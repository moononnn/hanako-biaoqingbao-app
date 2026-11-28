// lib/occasion-gate.js - 场合门禁：把「只在某个场合成立」的图挡在别的场合之外
//
// 起因（2026-11-28 实测）：stk_494 是一张画面写着「早安」的元气图，scene 只有一条「早安」，
// 却在「干劲十足」「如释重负」这些查询里被选中。原因不在向量算错，而在标签体系里
// 场景只是个加分项：查询里没有「早安」时它一分不扣，照样靠 emo 标签和语义相似度参选。
//
// 语义相似度是连续空间里的软权重，表达不了「必须且仅在早上可用」这种硬约束。
// 硬约束只能用离散字段做门禁：图侧写死 occasion，查询侧带场合信号，两边对上才放行。
//
// 三条纪律：
//   1. occasion 只收被画面或文字钉死在具体场合的图。拿不准就留空，宁可不当场合图。
//      标错的代价是这张图再也出不来，比漏标严重得多。
//   2. 门禁只否决，不改分数：锁住的直接出局，不搞「扣点分凑合用」那一套软办法。
//   3. 查询侧没有场合信号时一律锁死。情绪词不是场合，「开心」不代表「早上」。
//
// 和 emotion-families 的分工：那边管「这个词属于哪种情绪」，是连续的、可近似的；
// 这边管「这张图只能在什么时候用」，是离散的、不许近似的。两件事不能混在一起做。

// 场合组：组名是判定用的键，数组里是组内可以互认的说法。
// 只收「钉死时间点或事件」的场合。打招呼、撒娇、吐槽这些任何时候都能用，不算场合。
// v0.8.1 - 加上日文与空耳音译：图库里有「空吧哇」「欧嗨呦」这类只写音译字的问候图，
// 不认这些写法，画面上的字就白写了（实测 stk_586 因此漏标）。
// 日语对应：おはよう＝早上好，こんばんは＝晚上好，おやすみ＝晚安。
export const OCCASION_GROUPS = {
  早安: ['早安', '早上好', '早呀', '早上', '上午好', '清晨',
    '欧嗨呦', '欧嗨哟', '欧哈哟', '哦哈哟', '噢哈哟', 'おはよう', 'おはようございます', 'ohayo', 'ohayou'],
  晚安: ['晚安', '晚安安', '晚上好', '该睡了', '去睡了', '睡觉了', '好梦',
    '空吧哇', '空邦哇', 'こんばんは', 'konbanwa', 'おやすみ', 'oyasumi', '欧亚斯密'],
  生日: ['生日', '生日快乐', '寿星', '生日蛋糕', 'happy birthday'],
  节日: ['节日', '过年', '春节', '新年', '元旦', '圣诞', '中秋', '端午', '万圣', '情人节', '七夕', '元宵', '除夕', '感恩节'],
  恭喜: ['恭喜', '恭喜发财', '庆祝', '上岸', '金榜题名'],
};

/** 组名列表，给提示词和 UI 用。 */
export const OCCASION_NAMES = Object.keys(OCCASION_GROUPS);

/**
 * 一个词归属哪个场合组。不归属返回空串。
 * 中英文都走包含判断：短词（单字）不参与包含，避免「早」这种字把整句话都判成早安。
 */
export function normalizeOccasion(word) {
  const w = String(word ?? '').trim().toLowerCase();
  if (!w) return '';
  for (const [group, aliases] of Object.entries(OCCASION_GROUPS)) {
    if (w === group) return group;
    for (const alias of aliases) {
      const a = alias.toLowerCase();
      if (w === a) return group;
      if (a.length >= 2 && w.includes(a)) return group;
      if (w.length >= 2 && a.includes(w)) return group;
    }
  }
  return '';
}

/**
 * 一段长文本里出现了哪些场合组。给迁移脚本筛描述用。
 * 跟 occasionSet 的区别：这里逐组扫全文，一段话里同时提到早安和晚安两个都能拿到；
 * occasionSet 是逐词归一，一个词只归属一个组。
 */
export function occasionsInText(text) {
  const s = String(text ?? '').toLowerCase();
  const hits = new Set();
  if (!s) return hits;
  for (const [group, aliases] of Object.entries(OCCASION_GROUPS)) {
    if (aliases.some((alias) => alias.length >= 2 && s.includes(alias.toLowerCase()))) hits.add(group);
  }
  return hits;
}

/** 一组词 → 场合组集合。查询侧和图的 occasion 字段都走它。 */
export function occasionSet(words) {
  const set = new Set();
  const list = Array.isArray(words) ? words : [words];
  for (const word of list) {
    const group = normalizeOccasion(word);
    if (group) set.add(group);
  }
  return set;
}

/**
 * 查询侧组装：把情绪词、关键词、场景、语气、触发原文都过一遍。
 * 传进来的东西越具体，解锁越准；什么都没传就是空集，所有场合图一律锁死。
 */
export function queryOccasionSet(parts) {
  const flat = [];
  for (const part of (Array.isArray(parts) ? parts : [parts])) {
    if (Array.isArray(part)) flat.push(...part);
    else if (part) flat.push(part);
  }
  return occasionSet(flat);
}

/** 这张图自己带的场合组。没标过就是空集，表示不设限。 */
export function stickerOccasionSet(sticker) {
  return occasionSet(sticker?.occasion);
}

/**
 * 门禁本体：这张图这一刻能不能参选。
 * 没标场合 → 放行（老图行为完全不变）。
 * 标了场合 → 查询必须带着同一个场合才放行，否则出局。
 */
export function isOccasionLocked(sticker, queryOccasions) {
  const own = stickerOccasionSet(sticker);
  if (own.size === 0) return false;
  if (!(queryOccasions instanceof Set) || queryOccasions.size === 0) return true;
  for (const group of own) {
    if (queryOccasions.has(group)) return false;
  }
  return true;
}

// 文字信号：描述里出现这些词，说明模型在转述画面上写的字，而不是在说这张图适合什么时候用。
const WRITTEN_TEXT_SIGNAL = /字样|配文|配字|写着|文字|大字|气泡|字牌/;

/** 一段文本里「被写出来的」场合组：同一句话里既有场合词又有文字信号才算。 */
function writtenOccasionGroups(text) {
  const groups = new Set();
  for (const sentence of String(text ?? '').split(/[，。；,;、\n]/)) {
    if (!WRITTEN_TEXT_SIGNAL.test(sentence)) continue;
    for (const group of occasionsInText(sentence)) groups.add(group);
  }
  return groups;
}

/**
 * 从已有标签推断场合锁，给没有识图结果的入库链路徽底。
 *
 * 规则故意严：图的标签（scene / keywords）和「画面里写的字」必须同时指向同一个场合。
 * 只靠标签不算——图库里「猫咪翻肚皮」被批量识图随手打过早安标签，但它任何时候都能用；
 * 只靠语义描述也不算——那边写的是模型认为该什么时候用，不是画面上写了什么。
 *
 * 用途：纸飞机、直接上传这些拿不到识图 occasion 的路径，写入前调一次。
 * 已经带 occasion 的图不走推断，显式值优先。宁可漏几张，不可误标：误标等于这张图再也出不来。
 */
export function inferOccasions(sticker) {
  const tags = sticker?.tags && typeof sticker.tags === 'object' ? sticker.tags : {};
  const tagGroups = occasionSet([...(tags.scene || []), ...(tags.keywords || [])]);
  if (tagGroups.size === 0) return [];
  const written = writtenOccasionGroups(`${sticker?.semantic_description || ''} ${sticker?.description || ''}`);
  return [...tagGroups].filter((group) => written.has(group));
}

/**
 * 写入前兜底：entry 没有显式 occasion 时，用标签与画面文字推断一次。
 * 返回是否真写入了。显式值优先，推断不会覆盖已有的锁。
 */
export function fillInferredOccasion(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (Array.isArray(entry.occasion) && entry.occasion.length) return false;
  const inferred = inferOccasions(entry);
  if (!inferred.length) return false;
  entry.occasion = inferred;
  return true;
}

/** 给复核提示词用的短描述，如「早安」。没标返回空串。 */
export function describeOccasion(sticker) {
  return [...stickerOccasionSet(sticker)].join('、');
}