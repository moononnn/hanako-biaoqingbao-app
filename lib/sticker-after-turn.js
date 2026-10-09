// lib/sticker-after-turn.js — 把伙伴配的图压到这一轮说完之后再投（v0.1.38）
//
// 为什么不能边回话边投：宿主判断「这条消息要不要再叫一轮」的写法是
//   needsTurn = isSessionStreaming(sessionPath) || triggerTurn !== false
// 模型是在回话中途调 express 的，那一刻会话正在生成中，第一个条件已经成立，
// 投递里写多少遍 triggerTurn: false 都没用，宿主一定会再叫一轮；而那一轮手里
// 只有这张图（实测输入只有 1718 token），于是说出「趁你还没回话」这类像在等人回复的话。
// 改成：图先排队，等这条回复定稿、会话静下来再投，那时 notifyOnly 才真的成立。

import { deliverStickerToSession, resolveSessionId } from './sticker-delivery.js';

const PENDING_TTL_MS = 25000;   // 兜底：排队这么久还没被钩子领走，就自己投
const IDLE_TRIES = 12;          // 等空闲最多查这么多次
const IDLE_DELAY_MS = 700;      // 每次间隔（12 × 0.7s ≈ 8.4s）
const IDLE_FALLBACK_MS = 2500;  // 查不到会话状态时，退化的固定等待

const pending = new Map();      // sessionPath(小写) -> 条目
const flushing = new Set();     // 正在投递的会话，防重入

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyOf = (sessionPath) => String(sessionPath || '').trim().toLowerCase();

/**
 * 把一张刚选中的图排进「本轮结束后投递」的队列。
 * 同一段对话里重复排队时后一张覆盖前一张（一轮只送最后选中的那张）。
 */
export function queueStickerDelivery(entry) {
  const key = keyOf(entry?.sessionPath);
  if (!key || !entry?.sticker || !entry?.sdk) return { ok: false, error: '排队信息不完整' };
  const old = pending.get(key);
  if (old?.timer) clearTimeout(old.timer);
  const item = { ...entry, at: Date.now() };
  // 兜底：万一这轮没走到 post-assistant（模型只调工具没说话之类），也不能把图丢了
  item.timer = setTimeout(() => {
    void flushStickerDelivery(entry.sessionPath, 'timeout');
  }, PENDING_TTL_MS);
  if (typeof item.timer?.unref === 'function') item.timer.unref();
  pending.set(key, item);
  return { ok: true };
}

/** 这段对话里有没有等着投的图（只查不改）。 */
export function hasPendingSticker(sessionPath) {
  return pending.has(keyOf(sessionPath));
}

// 等会话静下来。返回 { idle, probed, error }：probed=false 表示压根没查到状态
// （接口变动、权限没给、参数不认），那时不去猜，退化成固定等一小会儿再投。
//
// 2026-10-09 实机修正：这里原先只传 legacySessionPath，宿主不认，每次都报
//   「Session manifest resolution requires sessionId or legacy sessionPath」，
// 于是每张图都白白多等 IDLE_FALLBACK_MS（2.5 秒）才投出去——这就是「说完话停一会儿，
// 图才慢吞吞出现」的直接原因。宿主那个解析器实际读的是 sessionId / sessionPath / path，
// 错误文案里写的 legacySessionPath 是个坑。两个都带上，让它自己挑能认的那个。
async function waitUntilIdle(sdk, sessionPath, sessionId = '') {
  for (let i = 0; i < IDLE_TRIES; i += 1) {
    let streaming = null;
    let err = '';
    try {
      const res = await sdk.bus.request('session:context',
        { sessionId: sessionId || undefined, sessionPath, scope: 'all' },
        { timeoutMs: 4000 });
      streaming = res?.isStreaming ?? res?.data?.isStreaming ?? null;
    } catch (e) {
      err = e?.message || String(e);
    }
    if (streaming === false) return { idle: true, probed: true, error: '' };
    if (streaming === null || streaming === undefined) {
      // 拿不到状态时，上一版是直接投——结果照旧多出一轮（实机 2026-10-07 12:29:25 投递，
      // 13 秒后又起一轮）。现在改成固定等一段：钩子触发时这一轮已经接近收尾，这点时间够它静下来。
      await sleep(IDLE_FALLBACK_MS);
      return { idle: false, probed: false, error: err };
    }
    await sleep(IDLE_DELAY_MS);
  }
  return { idle: false, probed: true, error: '' };
}

/**
 * 把排队的图投出去。post-assistant 钩子（回复定稿）和超时兜底都会调它。
 * 返回 { ok, entryId } / { ok:false, error }；没人排队时是 { ok:true, skipped:true }。
 */
export async function flushStickerDelivery(sessionPath, reason = 'hook') {
  const key = keyOf(sessionPath);
  if (!key) return { ok: false, error: '缺少会话路径' };
  if (flushing.has(key)) return { ok: false, error: '这张图正在投递中' };
  const item = pending.get(key);
  if (!item) return { ok: true, skipped: true };
  pending.delete(key);
  if (item.timer) clearTimeout(item.timer);
  flushing.add(key);
  try {
    // 会话编号只为把空闲探测送对地方；拿不到就退回只传 sessionPath，两条路都试过。
    let sessionId = '';
    try {
      sessionId = await resolveSessionId(item.sdk, sessionPath);
    } catch {
      sessionId = '';
    }
    const wait = await waitUntilIdle(item.sdk, sessionPath, sessionId);
    const delivered = await deliverStickerToSession({
      sdk: item.sdk,
      dataDir: item.dataDir,
      sessionPath,
      sticker: item.sticker,
      text: item.text,
      emotion: item.emotion,
    });
    return { ...delivered, ...wait, reason };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    flushing.delete(key);
  }
}

/** 只给自动测试用：清空队列。 */
export function __resetStickerQueueForTests() {
  for (const item of pending.values()) {
    if (item.timer) clearTimeout(item.timer);
  }
  pending.clear();
  flushing.clear();
}
