// 输入栏那个表情按钮的显隐。
// 宿主只提供「按会话」的动态覆盖：没有全局开关，而且覆盖只活在本次宿主运行里。
// 所以关掉时把已知会话盖一遍，新会话靠 session_created 事件补上，宿主重启后由应用重新盖。
//
// 2026-10-29：开关按页拆开。
//   聊天页一个（inputButtonChat），Code 页一个（inputButtonCode），两边互不影响。
//   宿主只有一个输入栏项（sticker-compose），按会话盖，所以「分页」靠的是
//   盖的时候用哪一档值：宿主名单里的会话（home / app）算聊天页，
//   本应用自记的 Code 会话名单算 Code 页。
//   旧键 inputButton 留着当镜像（两边都开才算开），老配置读出来自动落到两页上。
//
// 2026-10-27 补上 Code 页这一块：
// 宿主给 App 的 session:list 只开 home / app 两个分区（namespace 写死在宿主里），
// Code 页的会话压根不在名单里——实测同一时刻宿主有 19 个 Code 会话，App 的名单里一个都没有。
// 于是光靠名单同步，关掉开关以后 Code 页的输入栏按钮永远藏不住。
// 宿主又不给 App 别的枚举入口（session:search 只回本应用自己的会话），
// 所以这里自己记一份「已见过的 Code 会话」名单：
//   · session_created 事件：宿主对 Code 会话也发，带稳定 id 和 namespace
//   · 钩子里解析出的当前会话分区：session:get 按会话路径查得到 code
// 这份名单落盘，宿主重启后照样能用；关开关时名单里的会话和 session:list 的名单一起盖。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson } from './shared.js';
import { getSessionMetaResolver, isCodeSession, isSubagentSession } from './session-kind.js';

export const INPUT_STATUS_ID = 'sticker-compose';
const configPath = () => path.join(DATA_DIR, 'display-config.json');
const codeSessionsPath = () => path.join(DATA_DIR, 'input-button-code-sessions.json');
const MAX_SESSIONS = 2000;
// 已见过的 Code 会话最多留这么多条：这份名单是给「关开关时补盖」用的，
// 留太多会让每次同步都多盖几百个会话，留太少又会把老会话忘干净。
const MAX_CODE_SESSIONS = 300;
// 串行 RPC 盖 300 个会话要好几秒，并发太高又会撞宿主的 RPC 并发上限（日志里有那条
// "App RPC concurrency limit reached"）。8 个一批是实测能跑完又不报错的数量。
const SYNC_CONCURRENCY = 8;
// 装载时宿主还没投影本应用的 UI 贡献，这时 set 会被回「没有声明这个输入栏项」。
// 单靠一个固定延时赌它能赶上，实测赌输过（2026-10-21 09:25 那条日志），
// 所以改成「试几次 + 退避」，直到宿主认了这个声明为止。
const STARTUP_RETRY_DELAYS = [800, 1600, 3200, 6000, 10000];

// 「这次同步还在跑」的统一判法。
// 服务端的在跑状态带 reason:'pending'，POST 的即时回包带 pending:true，
// 两个标记表达的是同一件事；只认一个就会把「还在跑」当成最终结果，
// 界面就会在同步还没结束时说「没盖上」。
export function isInputButtonSyncPending(sync) {
  return !!(sync && (sync.pending === true || sync.reason === 'pending'));
}

// 两个页面各管各的：聊天页和 Code 页。
// 配置里两个键：inputButtonChat / inputButtonCode。
// 旧键 inputButton 留着不删：老版本只有这一个开关，老机器的配置里也只有它。
//   读法：新键写了就认新键；没写就退回旧键；两个都没写按默认显示算。
//   这样老配置迁上来不用改文件，新键一旦写定就不再受旧键影响。
export function resolveInputButtonSwitches(cfg) {
  const base = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const legacy = typeof base.inputButton === 'boolean' ? base.inputButton : true;
  return {
    chat: typeof base.inputButtonChat === 'boolean' ? base.inputButtonChat : legacy,
    code: typeof base.inputButtonCode === 'boolean' ? base.inputButtonCode : legacy,
  };
}

/** 读本机当前的两个开关。 */
export function readInputButtonSwitches() {
  try {
    return resolveInputButtonSwitches(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch { return { chat: true, code: true }; }
}

/**
 * 旧键只当镜像用：两边都开才算开。
 * 降级到老版本时宁可两边都藏起来，也别冒出一个用户没按过的按钮。
 */
export function legacyInputButtonValue(switches) {
  const resolved = normalizeInputButtonSwitches(switches);
  return resolved.chat && resolved.code;
}

/**
 * 把各种形态的开关值归一成 { chat, code }。
 * 布尔值按「两页一起」处理：那是旧版单开关的形状。
 */
export function normalizeInputButtonSwitches(value) {
  if (typeof value === 'boolean') return { chat: value, code: value };
  const base = value && typeof value === 'object' ? value : {};
  return { chat: base.chat !== false, code: base.code !== false };
}

// 「声明还没被宿主投影」这类错重试有意义，权限没批、会话删了重试也没用。
function isRetryableDeclareMiss(error) {
  const message = String(error?.message || error || '');
  return /no declared input status item/i.test(message);
}

// 会话没了（删了、过期了）：盖不上去不算失败，是这份名单该清掉的那一条。
function isSessionGone(error) {
  const message = String(error?.message || error || '');
  return /target session is unavailable|session manifest not found/i.test(message);
}

// 那个伙伴里没启用本应用：那里本来就不渲染这个按钮，盖不上去也不该报成「没盖上」。
function isNotActivated(error) {
  const message = String(error?.message || error || '');
  return /needs app\/input\.status and activation/i.test(message);
}

// ── 已见过的 Code 会话名单 ──
// 宿主名单（session:list）里没有 Code 页的会话，而宿主也没给 App 枚举它们的入口，
// 所以这份名单是「关开关时能盖到 Code 页」的唯一凭据。它必须落盘：
// 覆盖只活在本次宿主运行里，宿主一重启就得重盖一遍，名单没了就只能重新认。
export function readCodeSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(codeSessionsPath(), 'utf8'));
    const list = Array.isArray(raw?.sessions) ? raw.sessions : [];
    return list.map(row => String(row?.id || '').trim()).filter(Boolean);
  } catch { return []; }
}

function writeCodeSessions(ids) {
  const unique = [];
  for (const id of ids) { if (id && !unique.includes(id)) unique.push(id); }
  const kept = unique.slice(-MAX_CODE_SESSIONS);
  try {
    atomicWriteJson(codeSessionsPath(), { sessions: kept.map(id => ({ id, at: Date.now() })) });
  } catch { /* 写不下去就先靠内存里这份，下一次再说 */ }
  return kept;
}

/** 记下一个 Code 会话。已经在名单里就返回 false。 */
export function rememberCodeSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  const ids = readCodeSessions();
  if (ids.includes(id)) return false;
  writeCodeSessions(ids.concat(id));
  return true;
}

/** 把一个死掉的会话从名单里去掉。 */
export function forgetCodeSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  const ids = readCodeSessions();
  if (!ids.includes(id)) return;
  writeCodeSessions(ids.filter(item => item !== id));
}

/**
 * 记下当前会话：Code 页的会话不在宿主名单里，得自己认下来。
 * 认到新的 Code 会话就按当前开关盖一次——
 * 关着要立刻藏住，开着要把之前那笔 visible:false 抹掉。
 */
export async function noteInputButtonSession(sdk, session) {
  try {
    // 子代理会话不记：它们查不到分区，也不给人看输入栏，
    // 为此白打一次 session:get 只会占着宿主那条 RPC 通道。
    if (isSubagentSession({ sessionPath: session?.sessionPath, sessionKind: session?.kind })) return { noted: false };
    const resolver = getSessionMetaResolver(sdk?.bus);
    const meta = await resolver({ sessionId: session?.sessionId, sessionPath: session?.sessionPath });
    if (!isCodeSession(meta?.namespace)) return { noted: false };
    const id = String(meta?.sessionId || '').trim();
    if (!id) return { noted: false };
    const isNew = rememberCodeSession(id);
    // 新认到的 Code 会话：按 Code 页那一档盖，别拿聊天页的开关盖它。
    if (isNew) await syncInputButtonSession(sdk, id, readInputButtonSwitches(), 'code');
    return { noted: true, sessionId: id, isNew };
  } catch (error) {
    try { await sdk?.logger?.warn?.('记 Code 会话失败：' + (error?.message || error)); } catch {}
    return { noted: false };
  }
}

export async function syncInputButton(sdk, switches = readInputButtonSwitches(), isStale = null) {
  // 两页各一个开关：聊天页看 chat，Code 页看 code。
  const resolved = normalizeInputButtonSwitches(switches);
  // 每项带一个 kind（'chat' / 'code'），盖的时候才知道该用哪一档。
  let sessions = [];
  let hostIds = [];
  let truncated = 0;
  let listFailed = false;
  let listError = '';
  try {
    const result = await sdk.bus.request('session:list', { scope: 'all' }, { timeoutMs: 8000 });
    const list = Array.isArray(result) ? result : result?.sessions;
    const ids = (Array.isArray(list) ? list : [])
      .map(row => String(row?.sessionId || '').trim())
      .filter(Boolean);
    // 会话数超过上限时，超出的那些根本没盖到。这事得报出来，
    // 不能只说「已关闭」——那等于拿一半的成功冒充全部。
    truncated = Math.max(0, ids.length - MAX_SESSIONS);
    hostIds = ids;
    // 宿主名单只开 home / app 两个分区，拿到的是聊天页（含应用页）的会话。
    sessions = ids.slice(0, MAX_SESSIONS).map(id => ({ id, kind: 'chat' }));
  } catch (error) {
    listFailed = true;
    listError = String(error?.message || error);
    try { await sdk.logger?.warn?.('列会话失败，输入栏按钮显隐没同步：' + listError); } catch {}
  }
  // Code 页的会话不在宿主名单里，把本应用记下的那些补进来一起盖。
  // 不补这一段，关掉开关以后 Code 页的按钮永远藏不住（这就是本条待修的老毛病）。
  const codeIds = readCodeSessions().filter(id => !hostIds.includes(id));
  sessions = sessions.concat(codeIds.map(id => ({ id, kind: 'code' })));
  // 两边各盖各的：Code 页的会话拿 Code 页那一档，聊天页的会话拿聊天页那一档。
  // 拿同一个值盖两边，就等于两个开关还是同一个开关。
  const visibleFor = (kind) => (kind === 'code' ? resolved.code : resolved.chat);
  // 名单取不到、连一个已知会话都没有：确实无从下手，如实报出来。
  if (listFailed && sessions.length === 0) {
    return { ok: false, synced: 0, failed: 0, skipped: 0, gone: 0, total: 0, truncated: 0, codeSessions: 0, reason: 'session-list-failed', error: listError };
  }
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  let gone = 0;
  let chatSynced = 0;
  let codeSynced = 0;
  let lastError = '';
  let declareMiss = false;
  let stale = false;
  const codeIdSet = new Set(codeIds);
  for (let start = 0; start < sessions.length; start += SYNC_CONCURRENCY) {
    const batch = sessions.slice(start, start + SYNC_CONCURRENCY);
    const results = await Promise.all(batch.map(async (item) => {
      const sessionId = item.id;
      const visible = visibleFor(item.kind);
      // 已经被更新的请求取代了就别再往会话里写：旧值晚写进去会盖掉新结果，
      // 而界面报的是新结果——那又是一次「状态说谎」。
      if (typeof isStale === 'function' && isStale()) return { stale: true };
      try {
        await sdk.inputStatus.set({ sessionId, id: INPUT_STATUS_ID, visible });
        if (item.kind === 'code') codeSynced += 1; else chatSynced += 1;
        return null;
      } catch (error) {
        // 某个会话失败（比如那个伙伴里没启用本应用）不影响其他会话。
        try { await sdk.logger?.warn?.('输入栏按钮显隐同步失败：' + (error?.message || error)); } catch {}
        return { message: String(error?.message || error), sessionId };
      }
    }));
    for (const outcome of results) {
      if (!outcome) { synced += 1; continue; }
      if (outcome.stale) { stale = true; continue; }
      // 会话没了：从名单里清掉，下次不再去问一个死会话。
      if (isSessionGone(outcome.message)) {
        gone += 1;
        if (codeIdSet.has(outcome.sessionId)) forgetCodeSession(outcome.sessionId);
        continue;
      }
      // 那个伙伴里没启用本应用：那里本来就不渲染这个按钮，不算没盖上。
      if (isNotActivated(outcome.message)) {
        skipped += 1;
        lastError = outcome.message;
        continue;
      }
      // 失败数要带出去：只报「盖成了几个」的话，1999 个失败 1 个成功也会被说成成功，
      // 界面就会拿一句「已隐藏」把没生效的事盖住——那正是这个开关最初的老毛病。
      failed += 1;
      lastError = outcome.message;
      if (isRetryableDeclareMiss(outcome.message)) declareMiss = true;
    }
    if (stale) break;
  }
  // 被更新的请求取代：这次的半截结果不算数，直接交回去让上层丢掉。
  if (stale) {
    return { ok: false, synced, failed, skipped, gone, total: sessions.length, truncated, codeSessions: codeIds.length, chatSynced, codeSynced, applied: resolved, reason: 'superseded' };
  }
  // 一个会话都没盖成、而且错在「声明没被认」，报失败让上层决定要不要再试；
  // 只要盖成了几个，就算生效了，剩下的会话本来也可能是没启用本应用的。
  // 全都盖不成但也没有真失败（会话全没了 / 那些伙伴里没启用本应用），
  // 那也算生效：没有按钮可藏，本来就没东西要藏。
  const ok = sessions.length === 0 ? true : (synced > 0 || failed === 0);
  // 盖成了但也有失败的：不算失败，但界面得说「部分会话没盖上」，不能装作全好。
  const partial = ok && failed > 0;
  return {
    ok,
    synced,
    failed,
    skipped,
    gone,
    total: sessions.length,
    truncated,
    codeSessions: codeIds.length,
    chatSynced,
    codeSynced,
    // 这次盖的时候用的是哪两档：界面要说清楚「聊天页开着、Code 页关着」，
    // 不能让用户以为一个总闸管着两边。
    applied: resolved,
    ...(partial ? { reason: 'partial' } : {}),
    ...(ok ? {} : { reason: declareMiss ? 'not-declared-yet' : 'all-sessions-failed' }),
    ...(lastError && !ok ? { error: lastError } : {}),
  };
}

/**
 * 只盖一个会话。宿主文档说 session_created 会带 { sessionId, sessionPath, agentId }，
 * 拿得到 id 就不用为了一个新会话把全部会话重刷一遍（会话多时那是 N 次 RPC）。
 */
export async function syncInputButtonSession(sdk, sessionId, switches = readInputButtonSwitches(), kind = 'chat') {
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, synced: 0, failed: 0, total: 0, reason: 'no-session' };
  const resolved = normalizeInputButtonSwitches(switches);
  // kind 决定用哪一档：Code 页的会话用 Code 页的开关，其余按聊天页算。
  const visible = kind === 'code' ? resolved.code : resolved.chat;
  try {
    await sdk.inputStatus.set({ sessionId: id, id: INPUT_STATUS_ID, visible });
    return { ok: true, synced: 1, failed: 0, total: 1 };
  } catch (error) {
    try { await sdk.logger?.warn?.('输入栏按钮显隐同步失败：' + (error?.message || error)); } catch {}
    return { ok: false, synced: 0, failed: 1, total: 1, reason: 'set-failed', error: String(error?.message || error) };
  }
}

export async function installInputButtonWatcher(sdk) {
  let attempt = 0;
  const runOnce = async () => {
    try {
      const result = await syncInputButton(sdk);
      // 成功也要留一笔：这个开关过去「保存了、按钮还在」正是因为没有成功记录可查。
      try { await sdk.logger?.info?.(`输入栏按钮启动同步：${result.ok ? 'ok' : 'fail'} ${result.synced}/${result.total}${result.codeSessions ? ` Code ${result.codeSessions}` : ''}${result.reason ? ' ' + result.reason : ''}`); } catch {}
      // 声明还没被宿主投影时不放弃，按退避表继续试；其他失败（权限、名单）不再纠缠。
      if (result.ok === false && result.reason === 'not-declared-yet' && attempt < STARTUP_RETRY_DELAYS.length) {
        const delay = STARTUP_RETRY_DELAYS[attempt];
        attempt += 1;
        const timer = setTimeout(() => { void runOnce(); }, delay);
        timer.unref?.();
      }
      return result;
    } catch (error) {
      try { await sdk.logger?.warn?.('输入栏按钮显隐同步抛错：' + (error?.message || error)); } catch {}
      return { ok: false, synced: 0 };
    }
  };
  const first = setTimeout(() => { void runOnce(); }, STARTUP_RETRY_DELAYS[0]);
  attempt = 1;
  first.unref?.();
  try {
    if (typeof sdk.bus?.subscribe === 'function') {
      // 第二个参数必须给：省略时经 RPC 会变成 null，宿主读 types 直接抛错。
      await sdk.bus.subscribe(async (event, sessionPath) => {
        // 宿主文档：回调恒为 (event, sessionPath)，event 是只读投影，类型名在 event.type，
        // session_created 的负载带 { sessionId, sessionPath, agentId }。
        // 早先这里把 event 当字符串比，写成了 event !== 'session_created'，回调等于从未生效。
        const type = typeof event === 'string' ? event : event?.type;
        if (type !== 'session_created') return;
        // 负载有两种形状：平铺在事件上（{ sessionId, sessionPath, agentId }），
        // 或者塞在 session / payload / data 里。两种都得认。
        // 认不到 sessionId 就会退化成全量重刷——而 Code 页的会话压根不在全量名单里，
        // 那条退路对 Code 页等于什么都没盖（2026-10-27 实机日志：退路刷了 90 个，全是聊天页）。
        const nested = typeof event === 'string' ? null
          : (event?.session && typeof event.session === 'object' ? event.session : (event?.payload || event?.data || null));
        const sessionId = typeof event === 'string' ? '' : String(event?.sessionId || nested?.sessionId || '').trim();
        const namespace = typeof event === 'string' ? '' : String(event?.namespace || nested?.namespace || '').trim();
        if (sessionId) {
          // 分区决定用哪一档开关盖：Code 页的会话拿 Code 页那一档，其余拿聊天页那一档。
          // 事件不带 namespace 时不能瞎猜——两个开关一分开，猜错就是拿聊天页的开关
          // 去盖 Code 页的会话，用户明明关掉的东西又冒出来了。
          let kind = isCodeSession(namespace) ? 'code' : '';
          if (!kind) {
            // 先看本应用记下的 Code 名单，再问宿主（进程内共用的解析器，重复问不花钱）。
            if (readCodeSessions().includes(sessionId)) kind = 'code';
            else {
              try {
                const resolver = getSessionMetaResolver(sdk?.bus);
                const meta = await resolver({ sessionId, sessionPath: sessionPath || nested?.sessionPath || '' });
                kind = isCodeSession(meta?.namespace) ? 'code' : 'chat';
              } catch { kind = 'chat'; }
            }
          }
          // Code 页的会话不在宿主名单里，记下来，关开关时才知道要盖它。
          if (kind === 'code') rememberCodeSession(sessionId);
          // 只补这一个会话：新会话默认是显示的，单独盖一次就够。
          // 结果要留一笔：以前这条路径的结果直接丢掉，出问题连日志都没有。
          void syncInputButtonSession(sdk, sessionId, readInputButtonSwitches(), kind)
            .then(result => {
              try { void sdk.logger?.info?.(`输入栏按钮补盖新会话 ${sessionId}：${result.ok ? 'ok' : 'fail'}${result.error ? ' ' + result.error : ''}`); } catch {}
            })
            .catch(() => {});
          return;
        }
        // 拿不到会话 id 就只能退回全量；这次失败不跟着退避重试，等下次事件。
        void syncInputButton(sdk)
          .then(result => {
            try { void sdk.logger?.info?.(`输入栏按钮退路全量同步：${result.ok ? 'ok' : 'fail'} ${result.synced}/${result.total}${result.failed ? ' 失败 ' + result.failed : ''}${result.truncated ? ' 截断 ' + result.truncated : ''}${result.reason ? ' ' + result.reason : ''}`); } catch {}
          })
          .catch(() => {});
      }, {});
    }
  } catch (error) {
    try { await sdk.logger?.warn?.('输入栏按钮监听没挂上：' + (error?.message || error)); } catch {}
  }
}
