// 会话分区判断：这个会话在「聊天」页还是「Code」页
//
// 为什么只能靠 session:get：Code 页的会话不在 session:list 的名单里（2026-10-25 实机确认），
// 只有 session:get 查得到，而且只有它返回的对象带 namespace（home / code / app）。
// session:list 那些字段（path / title / kind / visibility / ownerPluginId）里没有任何一项
// 能区分 Code 窗口：普通会话的 kind 一律为空，cwd 两边都可能指向同一个工作台。
//
// 判断失败的代价要说清楚：判不出来就按聊天页处理（日常那档），
// 宁可少配一张，也不能让 Code 窗口按日常频率乱甩图。

const CACHE_MAX = 200;
// 会话落在哪个分区是创建时定死的，中途不会变，所以缓存可以一直用；
// 保鲜期从 30 分钟拉到 8 小时：每次过期都意味着一次 session:get 真 RPC，
// 而 Code 窗口总闸关着时，这一次 RPC 换来的结论永远是「什么都不做」。
// 宿主重启后 app 跟着重启，内存缓存自然清空，不存在拿到陈旧值的窗口。
const CACHE_TTL_MS = 8 * 60 * 60 * 1000;
// 查不到的也记一笔：2026-10-26 实机里子代理会话每条都查不到，
// 每个钩子重打两遍失败查询，白白占着宿主那条 128 槽的 RPC 通道。
// 负结果只保鲜一分钟：宿主刚启动或会话刚建出来时，miss 是正常的。
const NEGATIVE_TTL_MS = 60 * 1000;

// sessionId 一并带出来：宿主给 App 的 session:list 名单里没有 Code 页的会话，
// 输入栏按钮要覆盖它们就得靠这个稳定 id（会话名单之外，只能靠 session:get 拿）。
const EMPTY = Object.freeze({ namespace: '', title: '', sessionId: '' });

/**
 * 创建会话信息解析器。
 * @param {{bus?:object, debug?:(line:string)=>void}} opts
 * @returns {(input:{sessionId?:string, sessionPath?:string, timeoutMs?:number}) => Promise<{namespace:string, title:string}>}
 *   namespace 为 'home' / 'code' / 'app'，判不出来是空字符串。
 */
export function createSessionMetaResolver({ bus, debug, negativeTtlMs = NEGATIVE_TTL_MS } = {}) {
  const cache = new Map();
  let debugFn = debug;

  function remember(key, value, ttlMs = CACHE_TTL_MS) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, at: Date.now(), ttlMs });
  }

  async function resolveSessionMeta({ sessionId, sessionPath, timeoutMs = 2500 } = {}) {
    const id = String(sessionId || '').trim();
    const file = String(sessionPath || '').trim();
    const key = id || file;
    if (!key) return EMPTY;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < (hit.ttlMs ?? CACHE_TTL_MS)) return hit.value;
    if (typeof bus?.request !== 'function') return EMPTY;

    // 宿主两种参数都认；有 sessionId 优先用它，没有就退回会话路径。
    // 注意：总线事件里的 sessionId 有时是会话文件名（时间戳_UUID），不是宿主的 sess_xxx；
    // 拿它直接问会失败，所以宁可多试一次，也不能让分区判断变成一场空。
    const attempts = [];
    // 宿主 id 长这样 sess_xxx；总线事件里带的常常是「时间戳_UUID」的文件名，拿它去问必失败。
    // 每次 miss 都白占一次 RPC（失败要等回包），所以先按形状分个流，把它排到最后去。
    const looksHostId = /^sess_[A-Za-z0-9_-]+$/.test(id);
    if (id && id !== 'unknown' && looksHostId) attempts.push({ sessionId: id, scope: 'all' });
    if (file) attempts.push({ legacySessionPath: file, scope: 'all' });
    // 兜底：形状不像宿主 id 但又只有它可用时，还是得试一次，不能因为正则写得窄就放弃一条路。
    if (id && id !== 'unknown' && !looksHostId) attempts.push({ sessionId: id, scope: 'all' });

    for (const payload of attempts) {
      try {
        const result = await bus.request('session:get', payload, { timeout: timeoutMs });
        const session = result?.session || result;
        const meta = {
          namespace: String(session?.namespace || '').trim(),
          title: typeof session?.title === 'string' ? session.title.trim() : '',
          sessionId: String(session?.sessionId || '').trim(),
        };
        if (meta.namespace || meta.title || meta.sessionId) {
          remember(key, meta);
          if (file && file !== key) remember(file, meta);
          return meta;
        }
      } catch (error) {
        debugFn?.('会话分区判断失败：' + (error?.message || error));
      }
    }
    // 查不到不等于出了错：照常配图，按聊天页那档算。
    // 但这份「查不到」要记一分钟，否则同一条失败查询会每轮重打两遍。
    remember(key, EMPTY, negativeTtlMs);
    return EMPTY;
  }

  /**
   * 只读缓存，不同步等任何东西。命中不了返回 null，调用方自己决定要不要走 async 那条。
   * 存在的意义：Code 窗口总闸关着的时候，钩子该在发第一条 RPC 之前就认出「这事跟我无关」。
   */
  // 日志出口可以后补：谁先建谁不一定，但日志总要有地方可写。
  resolveSessionMeta.setDebug = (fn) => { debugFn = fn; };

  resolveSessionMeta.peek = ({ sessionId, sessionPath } = {}) => {
    for (const raw of [sessionId, sessionPath]) {
      const key = String(raw || '').trim();
      if (!key) continue;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < (hit.ttlMs ?? CACHE_TTL_MS)) return hit.value;
    }
    return null;
  };

  return resolveSessionMeta;
}

// 进程内共用一份会话分区解析器。
// 同一段会话配图准入和输入栏按钮都会问，各自建一份就是同一段会话查两遍 session:get，
// 而这条 RPC 在会话多的时候本来就紧张。
let sharedResolver = null;
let sharedBus = null;

/**
 * 取（必要时建）进程内共用的会话分区解析器。
 * @param {object} bus 宿主总线对象
 * @param {(line:string)=>void} [debug] 日志出口，后补也能装上
 */
export function getSessionMetaResolver(bus, debug) {
  if (!sharedResolver || sharedBus !== bus) {
    sharedResolver = createSessionMetaResolver({ bus });
    sharedBus = bus;
  }
  if (debug) sharedResolver.setDebug?.(debug);
  return sharedResolver;
}

/** 是否 Code 页的会话。 */
export function isCodeSession(namespace) {
  return String(namespace || '').trim() === 'code';
}

/**
 * 子代理会话（她自己派出去干活的那些），一律不配图。
 *
 * 依据是会话落盘位置：宿主把子代理放在 `...\agents\<agentId>\subagent-sessions\...` 下，
 * 主窗口是 `...\agents\<agentId>\sessions\...`。不靠 session:get 判，是因为
 * 2026-10-26 实机里子代理会话的分区查询全部 `Session manifest not found`，
 * 判不出来就退回聊天页 90%，等于给每个子代理的每一步都排一次情绪模型，
 * 把宿主那条 128 槽的 RPC 通道填满（一小时 1150 条 concurrency limit）。
 * 路径是宿主自己写的，不花一次 RPC 就看得出来。
 */
export function isSubagentSession({ sessionPath, sessionKind } = {}) {
  if (String(sessionKind || '').trim() === 'subagent') return true;
  const p = String(sessionPath || '').replace(/\\/g, '/').toLowerCase();
  return p.includes('/subagent-sessions/') || p.includes('/subagent-sessions');
}

/**
 * 按窗口取频率档位。两档一直是同一份配置里的 daily / task：
 *   daily → 聊天页，task → Code 页。
 * 老版本这两档叫「日常 / 正事」，是按对话内容判的；现在按窗口判，字段名不动，省得迁移。
 * @param {{daily?:number, task?:number}} freqSettings
 * @param {boolean} inCode
 * @returns {number}
 */
export function pickWindowFreq(freqSettings, inCode) {
  const daily = Number(freqSettings?.daily) || 0;
  const task = Number.isFinite(Number(freqSettings?.task)) ? Number(freqSettings.task) : daily;
  return inCode ? task : daily;
}

/** 给日志用的窗口名。 */
export function windowLabel(inCode) {
  return inCode ? 'Code' : '聊天';
}

/**
 * Code 窗口总闸关掉时，代码页里连模型主动调的 express 也不放行。
 * @param {boolean} codeEnabled 配置里的 code_enabled
 * @param {boolean} inCode 当前会话是不是 Code 页
 */
export function isCodeWindowBlocked(codeEnabled, inCode) {
  return Boolean(inCode) && codeEnabled === false;
}
