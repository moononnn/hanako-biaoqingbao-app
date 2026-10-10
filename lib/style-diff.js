/**
 * 文案版本对比：把「旧版」和「新版」按句子切出来，逐句比出哪些相同、哪些是新版新增的、哪些是旧版独有的。
 *
 * 为什么要有这个：学我说话每总结一次就是一份新的人格描述，但只有一段文字，
 * 想知道「这次和上次到底改了什么」只能靠自己逐句读。于是做一份带标记的对照：
 *   同一句话两边都原样显示；
 *   新版多出来的句子标绿（这是这次总结新学到的）；
 *   旧版有、新版没有的句子标红划掉（这次把它去掉了）。
 *
 * 算法就是最长公共子序列（LCS）那一套，句子级就够：一份文案最多 600 字，
 * 切出来几十句，方阵动态规划在这个量级是毫秒级，不用上别的算法。
 */

const OPEN_QUOTES = '“「『"\'‘';
const CLOSE_QUOTES = '”」』"\'’';
const OPEN_BRACKETS = '（(【《[〔';
const CLOSE_BRACKETS = '）)】》]〕';

// 断句兵底：引号没配对时单句最多积这么多字。
const MAX_SEGMENT_CHARS = 200;

/**
 * 按中文标点切句，保留标点。切不出句子时返回空数组。
 *
 * 关键：引号和括号内部的句末标点不断句。否则「“这个也太好看了！”情绪上来时」
 * 会被从感叹号处劈成两半，diff 出来变成半句话标红，看着像删了一半内容。
 * 所以要先数着还欠着多少个引号/括号，只在外层都闭合时才断。
 */
export function splitSentences(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return [];
  const out = [];
  let buf = '';
  let quoteDepth = 0;
  let bracketDepth = 0;
  for (const ch of raw) {
    buf += ch;
    if (OPEN_QUOTES.includes(ch)) quoteDepth += 1;
    else if (CLOSE_QUOTES.includes(ch) && quoteDepth > 0) quoteDepth -= 1;
    else if (OPEN_BRACKETS.includes(ch)) bracketDepth += 1;
    else if (CLOSE_BRACKETS.includes(ch) && bracketDepth > 0) bracketDepth -= 1;

    if ('。！？!?；;\n'.includes(ch) && quoteDepth === 0 && bracketDepth === 0) {
      out.push(buf.trim());
      buf = '';
    } else if (buf.length >= MAX_SEGMENT_CHARS) {
      // 兜底：引号没配对（比如模型吐了个孤立引号）时，上面那个条件永远不会成立，
      // 整篇会粘成一坨，diff 粒度就没了。所以保证任何一段最多积 MAX_SEGMENT_CHARS 字就断一次，
      // 宁可粗一点，也不要让整篇变成不可用的一大块。
      // 必须在循环里逐字判断（放循环外只会在最后看一眼，等于没有）。
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

function lcsMatrix(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

/**
 * 对比两段文案。
 * 返回 { oldParts: [{ type: 'same'|'removed', text }], newParts: [{ type: 'same'|'added', text }] }
 * 两边拼起来就是一份完整的对照：相同句原样，改动句各自带标记。
 */
export function diffTexts(oldText, newText) {
  const a = splitSentences(oldText);
  const b = splitSentences(newText);
  const dp = lcsMatrix(a, b);

  const oldParts = [];
  const newParts = [];
  let i = a.length;
  let j = b.length;

  const pushSame = (text) => {
    oldParts.push({ type: 'same', text });
    newParts.push({ type: 'same', text });
  };

  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pushSame(a[i - 1]);
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      oldParts.push({ type: 'removed', text: a[i - 1] });
      i -= 1;
    } else {
      newParts.push({ type: 'added', text: b[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    oldParts.push({ type: 'removed', text: a[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    newParts.push({ type: 'added', text: b[j - 1] });
    j -= 1;
  }

  oldParts.reverse();
  newParts.reverse();
  return { oldParts, newParts };
}

/** 一眼能看出「这次改了什么」：统计改动的句数。 */
export function diffStats(oldParts, newParts) {
  return {
    added: newParts.filter((p) => p.type === 'added').length,
    removed: oldParts.filter((p) => p.type === 'removed').length,
    unchanged: newParts.filter((p) => p.type === 'same').length,
  };
}

/**
 * 给接口用的一层：拿模板的当前版和某个历史版比。
 * 没历史、或者两版内容一模一样时返回 null（没有值得展示的差异，别占地方）。
 */
export function compareWithVersion(template, version) {
  const history = Array.isArray(template?.history) ? template.history : [];
  const target = history.find((h) => h && h.version === version);
  const current = template?.current || '';
  if (!target || !current) return null;
  const { oldParts, newParts } = diffTexts(target.content || '', current);
  if (!newParts.some((p) => p.type === 'added') && !oldParts.some((p) => p.type === 'removed')) {
    return null; // 两版一模一样，没什么可比的
  }
  return {
    version: target.version,
    saved_at: target.saved_at || null,
    level: target.level || '',
    source_agent: target.source_agent || '',
    oldParts,
    newParts,
    stats: diffStats(oldParts, newParts),
  };
}