// 输入栏那个表情按钮的显隐。
// 宿主只提供「按会话」的动态覆盖：没有全局开关，而且覆盖只活在本次宿主运行里。
// 所以关掉时把已知会话盖一遍，新会话靠 session_created 事件补上，宿主重启后由应用重新盖。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './shared.js';

export const INPUT_STATUS_ID = 'sticker-compose';
const configPath = () => path.join(DATA_DIR, 'display-config.json');
const MAX_SESSIONS = 2000;
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

export function readInputButtonEnabled() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return cfg.inputButton !== false;
  } catch { return true; }
}

// 「声明还没被宿主投影」这类错重试有意义，权限没批、会话删了重试也没用。
function isRetryableDeclareMiss(error) {
  const message = String(error?.message || error || '');
  return /no declared input status item/i.test(message);
}

export async function syncInputButton(sdk, enabled = readInputButtonEnabled(), isStale = null) {
  const visible = enabled !== false;
  let sessions = [];
  let truncated = 0;
  try {
    const result = await sdk.bus.request('session:list', { scope: 'all' }, { timeoutMs: 8000 });
    const list = Array.isArray(result) ? result : result?.sessions;
    const ids = (Array.isArray(list) ? list : [])
      .map(row => String(row?.sessionId || '').trim())
      .filter(Boolean);
    // 会话数超过上限时，超出的那些根本没盖到。这事得报出来，
    // 不能只说「已关闭」——那等于拿一半的成功冒充全部。
    truncated = Math.max(0, ids.length - MAX_SESSIONS);
    sessions = ids.slice(0, MAX_SESSIONS);
  } catch (error) {
    try { await sdk.logger?.warn?.('列会话失败，输入栏按钮显隐没同步：' + (error?.message || error)); } catch {}
    return { ok: false, synced: 0, failed: 0, total: 0, truncated: 0, reason: 'session-list-failed', error: String(error?.message || error) };
  }
  let synced = 0;
  let failed = 0;
  let lastError = '';
  let declareMiss = false;
  let stale = false;
  for (let start = 0; start < sessions.length; start += SYNC_CONCURRENCY) {
    const batch = sessions.slice(start, start + SYNC_CONCURRENCY);
    const results = await Promise.all(batch.map(async (sessionId) => {
      // 已经被更新的请求取代了就别再往会话里写：旧值晚写进去会盖掉新结果，
      // 而界面报的是新结果——那又是一次「状态说谎」。
      if (typeof isStale === 'function' && isStale()) return { stale: true };
      try {
        await sdk.inputStatus.set({ sessionId, id: INPUT_STATUS_ID, visible });
        return null;
      } catch (error) {
        // 某个会话失败（比如那个伙伴里没启用本应用）不影响其他会话。
        try { await sdk.logger?.warn?.('输入栏按钮显隐同步失败：' + (error?.message || error)); } catch {}
        return { message: String(error?.message || error) };
      }
    }));
    for (const outcome of results) {
      if (!outcome) { synced += 1; continue; }
      if (outcome.stale) { stale = true; continue; }
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
    return { ok: false, synced, failed, total: sessions.length, truncated, reason: 'superseded' };
  }
  // 一个会话都没盖成、而且错在「声明没被认」，报失败让上层决定要不要再试；
  // 只要盖成了几个，就算生效了，剩下的会话本来也可能是没启用本应用的。
  const ok = sessions.length === 0 ? true : synced > 0;
  // 盖成了但也有失败的：不算失败，但界面得说「部分会话没盖上」，不能装作全好。
  const partial = ok && failed > 0;
  return {
    ok,
    synced,
    failed,
    total: sessions.length,
    truncated,
    ...(partial ? { reason: 'partial' } : {}),
    ...(ok ? {} : { reason: declareMiss ? 'not-declared-yet' : 'all-sessions-failed' }),
    ...(lastError && !ok ? { error: lastError } : {}),
  };
}

/**
 * 只盖一个会话。宿主文档说 session_created 会带 { sessionId, sessionPath, agentId }，
 * 拿得到 id 就不用为了一个新会话把全部会话重刷一遍（会话多时那是 N 次 RPC）。
 */
export async function syncInputButtonSession(sdk, sessionId, enabled = readInputButtonEnabled()) {
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, synced: 0, failed: 0, total: 0, reason: 'no-session' };
  const visible = enabled !== false;
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
      try { await sdk.logger?.info?.(`输入栏按钮启动同步：${result.ok ? 'ok' : 'fail'} ${result.synced}/${result.total}${result.reason ? ' ' + result.reason : ''}`); } catch {}
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
      await sdk.bus.subscribe((event) => {
        // 宿主文档：回调恒为 (event, sessionPath)，event 是只读投影，类型名在 event.type，
        // session_created 的负载带 { sessionId, sessionPath, agentId }。
        // 早先这里把 event 当字符串比，写成了 event !== 'session_created'，回调等于从未生效。
        const type = typeof event === 'string' ? event : event?.type;
        if (type !== 'session_created') return;
        // 宿主文档说负载是 { sessionId, sessionPath, agentId } 平铺在事件上；
        // 万一不是平铺的，再从 payload / data 里找一次，找不到才退回全量。
        const nested = typeof event === 'string' ? null : (event?.payload || event?.data || null);
        const sessionId = typeof event === 'string' ? '' : String(event?.sessionId || nested?.sessionId || '').trim();
        if (sessionId) {
          // 只补这一个会话：新会话默认是显示的，单独盖一次就够。
          // 结果要留一笔：以前这条路径的结果直接丢掉，出问题连日志都没有。
          void syncInputButtonSession(sdk, sessionId)
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
