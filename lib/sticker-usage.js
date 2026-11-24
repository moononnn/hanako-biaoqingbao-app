// 采用的用法：这张图在聊天里到底是怎么用的。
//
// 茶话会那边学到一句纠正（「这张不是卖萌，是被夸了之后假装不在意」），
// 会把它递过来让我们也记住。记住之后有三条规矩：
//   1. 用法写在自己的字段 `usage` 里，不碰标题、不碰原图、不联网、不调模型。
//   2. 自动选图不再拿这张图的旧标签/旧向量说事——旧标签说的可能就是错的。
//      只有新用法本身命中当下的情绪/关键词，这张图才重新有资格被选中；
//      否则它就只当一张「已经被纠正过」的图，不去抢别的位置。
//   3. 对外索引里带上这条用法，别的应用看得见（见 lib/public-index.js）。
//
// 这里只放纯逻辑：不读盘、不写盘，方便单测直接摆事实。

/** 采用来源：目前只有茶话会会把用法递过来。 */
export const USAGE_SOURCE = "chahuahui";
/** 用法说明最长多少字（发送方那边也按 60 字截，两边口径一致）。 */
export const USAGE_MEANING_MAX = 60;
/** 命中权重：用法是明确纠正过的，比旧标签更可信，所以给得比标签通道高。 */
export const USAGE_WEIGHT = { emotion: 40, keyword: 30, scene: 20, tone: 10 };

/** 清洗用法文本：控制字符换成空格、压掉连续空白、截长。 */
export function normalizeUsageMeaning(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, USAGE_MEANING_MAX);
}

/** 这张图有没有被采用过用法。没有就是空串。 */
export function usageMeaningOf(sticker) {
  const usage = sticker?.usage;
  if (typeof usage === "string") return normalizeUsageMeaning(usage);
  if (!usage || typeof usage !== "object") return "";
  return normalizeUsageMeaning(usage.meaning);
}

/** 这张图是不是已经被纠正过用法。 */
export function hasAdoptedUsage(sticker) {
  return Boolean(usageMeaningOf(sticker));
}

/**
 * 一个查询词算不算命中这条用法。
 * 单字词不去自由文本里乱撞（"累"能撞上一堆字）；两个字的才允许包含匹配。
 */
function termHitsMeaning(meaning, term) {
  const t = String(term ?? "").trim();
  if (!t || !meaning) return false;
  if (t === meaning) return true;
  if (t.length < 2) return false;
  if (meaning.includes(t)) return true;
  if (meaning.length >= 2 && t.includes(meaning)) return true;
  return false;
}

/**
 * 用新用法给一张图打分：命中才算分，没命中就是 0（也就是不参选）。
 * @param {object} sticker 图库那一行
 * @param {object} query   { emotions, keywords, scenes, tone }
 */
export function scoreUsageMeaning(sticker, query = {}) {
  const meaning = usageMeaningOf(sticker);
  if (!meaning) return 0;
  const emotions = Array.isArray(query.emotions) ? query.emotions : (query.emotions ? [query.emotions] : []);
  const keywords = Array.isArray(query.keywords) ? query.keywords : (query.keywords ? [query.keywords] : []);
  const scenes = Array.isArray(query.scenes) ? query.scenes : (query.scenes ? [query.scenes] : []);
  const terms = [
    ...emotions.map((item) => ["emotion", item]),
    ...keywords.map((item) => ["keyword", item]),
    ...scenes.map((item) => ["scene", item]),
    ...(query.tone ? [["tone", query.tone]] : []),
  ];
  let best = 0;
  for (const [kind, raw] of terms) {
    if (!termHitsMeaning(meaning, raw)) continue;
    best = Math.max(best, USAGE_WEIGHT[kind] || 0);
  }
  return best;
}

/**
 * 给一批「已经采用过用法」的图按新用法打分，返回有分的候选（分数高的在前）。
 * 这批图不参与旧标签通道，也不参与向量通道。
 */
export function scoreAdoptedUsage(stickers, query = {}) {
  const scored = [];
  for (const sticker of Array.isArray(stickers) ? stickers : []) {
    if (!sticker) continue;
    const score = scoreUsageMeaning(sticker, query);
    if (score > 0) scored.push({ ...sticker, _score: score, _usageAdopted: true });
  }
  scored.sort((a, b) => b._score - a._score);
  return scored;
}
