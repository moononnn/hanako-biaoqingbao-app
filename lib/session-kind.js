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
// 留一个保鲜期，宿主重启后 session 对象重造时能自然失效。
const CACHE_TTL_MS = 30 * 60 * 1000;

const EMPTY = Object.freeze({ namespace: '', title: '' });

/**
 * 创建会话信息解析器。
 * @param {{bus?:object, debug?:(line:string)=>void}} opts
 * @returns {(input:{sessionId?:string, sessionPath?:string, timeoutMs?:number}) => Promise<{namespace:string, title:string}>}
 *   namespace 为 'home' / 'code' / 'app'，判不出来是空字符串。
 */
export function createSessionMetaResolver({ bus, debug } = {}) {
  const cache = new Map();

  function remember(key, value) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, at: Date.now() });
  }

  return async function resolveSessionMeta({ sessionId, sessionPath, timeoutMs = 2500 } = {}) {
    const id = String(sessionId || '').trim();
    const file = String(sessionPath || '').trim();
    const key = id || file;
    if (!key) return EMPTY;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    if (typeof bus?.request !== 'function') return EMPTY;

    // 宿主两种参数都认；有 sessionId 优先用它，没有就退回会话路径。
    // 注意：总线事件里的 sessionId 有时是会话文件名（时间戳_UUID），不是宿主的 sess_xxx；
    // 拿它直接问会失败，所以宁可多试一次，也不能让分区判断变成一场空。
    const attempts = [];
    if (id && id !== 'unknown') attempts.push({ sessionId: id, scope: 'all' });
    if (file) attempts.push({ legacySessionPath: file, scope: 'all' });

    for (const payload of attempts) {
      try {
        const result = await bus.request('session:get', payload, { timeout: timeoutMs });
        const session = result?.session || result;
        const meta = {
          namespace: String(session?.namespace || '').trim(),
          title: typeof session?.title === 'string' ? session.title.trim() : '',
        };
        if (meta.namespace || meta.title) {
          remember(key, meta);
          if (file && file !== key) remember(file, meta);
          return meta;
        }
      } catch (error) {
        debug?.('会话分区判断失败：' + (error?.message || error));
      }
    }
    // 查不到不等于出了错：照常配图，按聊天页那档算。
    return EMPTY;
  };
}

/** 是否 Code 页的会话。 */
export function isCodeSession(namespace) {
  return String(namespace || '').trim() === 'code';
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
