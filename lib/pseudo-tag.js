// lib/pseudo-tag.js - 模型把「发图」写成文字时的兜底（清洗 + 注入登记）
//
// 现场（2026-10-06）：一次 ritual 注入之后，模型没有走 express 工具调用，
// 而是在正文末尾自己写了一段拟态标记：
//     <mood-send>
//     <express mood="开心"/>
//     </mood-send>
// 宿主和 App 都不认识这种东西，只能当普通文字原样贴给用户，图也没发出去。
//
// 这里只做两件不碰模型的事：
//   ① stripPseudoTags —— 剪掉「独占整行」的伪标记。夹在句子中间的一律不动：
//      正常讨论这类标记的正文（比如向用户解释这个毛病的消息）不能被误伤。
//   ② 注入登记表 —— pre-step 提醒过什么情绪，post-assistant 阶段要用它替模型补发。
//      每轮 pre-step 开头先清掉本会话的记录，避免上一轮的残留把下一轮带偏。
//
// 记录只在进程内存里，App 重载即清空，不写盘。

const INJECTION_TTL_MS = 10 * 60 * 1000;
const MAX_INJECTION_KEYS = 200;

const injections = new Map();

const keyOf = (sessionPath) => String(sessionPath || '').toLowerCase();

/** 本轮开始前清掉上一轮留下的记录。 */
export function clearInjection(sessionPath) {
  const key = keyOf(sessionPath);
  if (key) injections.delete(key);
}

/** pre-step 真的注入了提示才调用。 */
export function rememberInjection(sessionPath, info = {}) {
  const key = keyOf(sessionPath);
  if (!key) return;
  if (injections.size >= MAX_INJECTION_KEYS) {
    const now = Date.now();
    for (const [k, rec] of injections) {
      if (now - rec.at >= INJECTION_TTL_MS) injections.delete(k);
    }
    while (injections.size >= MAX_INJECTION_KEYS) {
      const oldest = injections.keys().next().value;
      if (oldest === undefined) break;
      injections.delete(oldest);
    }
  }
  injections.set(key, {
    emotion: '',
    keywords: [],
    reason: '',
    query: {},
    agentId: '',
    source: '',
    status: 'pending',
    ...info,
    at: Date.now(),
  });
}

/** 读本会话最近的注入记录；过期即视为没有。 */
export function peekInjection(sessionPath, now = Date.now()) {
  const key = keyOf(sessionPath);
  if (!key) return null;
  const rec = injections.get(key);
  if (!rec) return null;
  if (now - rec.at >= INJECTION_TTL_MS) {
    injections.delete(key);
    return null;
  }
  return rec;
}

/** 本轮真的把图发出去了（工具调用成功或补发成功）才标记，免得同一轮再补一张。 */
export function markInjectionDelivered(sessionPath) {
  const rec = peekInjection(sessionPath);
  if (rec) rec.status = 'delivered';
}

/** 仅供测试清理进程内状态。 */
export function __resetInjectionsForTests() {
  injections.clear();
}

// 整行只能由这些形态组成才算伪标记。要求「整行」是刻意的：
// 模型有时会在句子里正经提到这类标记（比如复盘这个 bug），那些不能剪。
const PSEUDO_LINE = new RegExp(
  '^(?:' +
    '<mood-send\\b[^>]*>\\s*(?:<[^>]+>\\s*)*</mood-send>' + // 单行包裹块
    '|<mood-send\\b[^>]*/?>' +                              // 开标签或自闭标签
    '|<express\\b[^>]*/?>' +                                // 单独一把
    '|</express>|</mood-send>' +                            // 收尾标签
  ')$',
);

/**
 * 剪掉独占整行的伪标记。
 * @returns {{text: string, removed: string[]}} 没有可剪的原样返回，removed 为空数组表示未改动。
 */
export function stripPseudoTags(text) {
  if (typeof text !== 'string' || !text.includes('<')) return { text, removed: [] };
  const kept = [];
  const removed = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && PSEUDO_LINE.test(trimmed)) {
      removed.push(trimmed);
      continue;
    }
    kept.push(line);
  }
  if (!removed.length) return { text, removed: [] };
  // 剪掉的行会留下空行，收一收；顺带清掉行尾多余空格。
  const cleaned = kept.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return { text: cleaned, removed };
}
