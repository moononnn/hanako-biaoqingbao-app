// 一轮只发一张：同一回合内已经发过图，就拒掉第二次 express 调用。
//
// 起因（v0.34.62）：observer 双通道注入把「可以发一张表情包」说了两遍，
// 再加上 express 回包里的「不合适就再调一次换一张」，模型会在同一轮连发两张。
// 文案侧已在 observer / express 收口，这里做硬上限兜底。
//
// v0.1.2 修掉的洞：原来只靠 60 秒时间窗判「同一轮」。
// 真实的翻车现场是模型在一条长回复里连着干十几步活（改文件、跑测试），
// 每步之间隔了几十秒甚至几分钟，时间窗一过就放行，于是同一条回复甩出四张图。
// 现在优先用「触发本回合的用户消息文本」当回合锚点：
// 同一回合内不管隔多久、跑多少步，消息文本不变 → 照样拒。
//
// 纯内存、进程内生效：Hana 重启或插件重载后自动放行，不写盘。
export const SAME_TURN_WINDOW_MS = 60 * 1000;

// 消息文本缺失时的兜底窗口：跟旧行为一致。
export const FALLBACK_WINDOW_MS = SAME_TURN_WINDOW_MS;

// 消息文本变了但时间很近：仍当作同一条工具链里的重复调用挡掉。
// 只防「模型在同一回合里换了个措辞再发一次」，不误伤隔了会儿的新一轮。
export const TEXT_SWITCH_GRACE_MS = 2 * 60 * 1000;

// 防止长期运行后 Map 无限增长：超过上限就清掉已经过期的键。
const MAX_TRACKED = 200;

/** 记录：at=发出时刻，msgKey=当时那条用户消息的锚点。 */
const lastSent = new Map();

function keyOf(agentId, sessionRef) {
  return `${agentId || 'unknown'}|${sessionRef || 'unknown'}`;
}

/**
 * 把用户消息文本压成稳定的回合锚点。
 * 取不到 / 全是空白时返回 null，调用方据此退回时间窗。
 */
export function toTurnKey(messageText, limit = 300) {
  if (typeof messageText !== 'string') return null;
  const normalized = messageText.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, limit);
}

/**
 * 是否属于「同一回合已经发过图」。
 * @param {string} agentId
 * @param {string} sessionRef
 * @param {{turnKey?: string|null, now?: number}} [opts]
 */
export function isWithinSameTurn(agentId, sessionRef, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const turnKey = opts.turnKey ?? null;
  const key = keyOf(agentId, sessionRef);
  const rec = lastSent.get(key);
  if (!rec) return false;

  const elapsed = now - rec.at;
  if (elapsed < 0) return true; // 时钟回拨，保守起见先挡着

  if (turnKey) {
    // 锚点一致 = 还是这一条用户消息在驱动，哪怕隔了几分钟也算同一回合。
    if (rec.turnKey && rec.turnKey === turnKey) return true;
    // 锚点变了：离上一张很近就再挡一下（同一串工具链里的重复调用）。
    return elapsed < TEXT_SWITCH_GRACE_MS;
  }

  // 没有锚点可用：退回旧的时间窗兜底。
  if (elapsed >= FALLBACK_WINDOW_MS) {
    lastSent.delete(key);
    return false;
  }
  return true;
}

/** 真正发出图片后才调用。 */
export function markStickerSent(agentId, sessionRef, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const turnKey = opts.turnKey ?? null;
  if (lastSent.size >= MAX_TRACKED) {
    for (const [key, rec] of lastSent) {
      if (now - rec.at >= Math.max(FALLBACK_WINDOW_MS, TEXT_SWITCH_GRACE_MS)) lastSent.delete(key);
    }
    // 清理后仍然超量（全是新鲜的键）就丢掉最老的一条，避免无界增长。
    while (lastSent.size >= MAX_TRACKED) {
      const oldest = lastSent.keys().next().value;
      if (oldest === undefined) break;
      lastSent.delete(oldest);
    }
  }
  lastSent.set(keyOf(agentId, sessionRef), { at: now, turnKey });
}

/** 仅供测试清理进程内状态。 */
export function resetSameTurnWindow() {
  lastSent.clear();
}
