// tests/express-family-scoring.test.mjs
// v0.7.7 - 家族通道 + 嘲讽图降权 + 分差收敛的回归测试。
// 三件事：
//   1) 图情绪标签同家族 → +6；只有场景/关键词同家族 → +3
//   2) 诚恳语境（抱歉/感谢/关心…）里，嘲讽怼人图被扣出候选
//   3) 前三名分差明显时直接取第一，不再抽样
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreStickers, pickTopCandidate, stickerTouchesTerms, applyVectorBonus } from '../tools/express.js';
import { termsOfFamilies, MOCK_PENALTY } from '../lib/emotion-families.js';

const noPrefs = { vetoed: [], disliked: {} };
const mk = (id, tags, extra = {}) => ({ id, file: `${id}.png`, description: '', tags, ...extra });

test('家族命中：情绪标签同家族 +6', () => {
  const list = [mk('apology', { emotion: ['歉意'], scene: [], keywords: [] })];
  const scored = scoreStickers(list, '不好意思', [], noPrefs);
  assert.equal(scored.length, 1);
  // 6(家族) + 8(emotion 精确「歉意」不含「不好意思」，不命中) → 只有家族分
  assert.equal(scored[0]._score, 6);
});

test('家族命中：只有关键词同家族时 +3', () => {
  const list = [mk('sceneOnly', { emotion: ['害羞'], scene: [], keywords: ['道歉'] })];
  const scored = scoreStickers(list, '不好意思', [], noPrefs);
  assert.equal(scored.length, 1);
  assert.equal(scored[0]._score, 3);
});

test('诚恳语境下嘲讽图被扣到出局', () => {
  const list = [
    mk('apology', { emotion: ['歉意'], scene: [], keywords: [] }, { description: '双手合十求原谅' }),
    mk('mock', { emotion: ['嘲讽', '不屑'], scene: [], keywords: [] }, { description: '斜眼嘲讽不是哥们' }),
  ];
  const scored = scoreStickers(list, '不好意思', [], noPrefs);
  const ids = scored.map((s) => s.id);
  assert.ok(ids.includes('apology'), '道歉图应入选');
  assert.ok(!ids.includes('mock'), '嘲讽图在诚恳语境下不该入选');
});

test('无语语境下嘲讽图正常参选', () => {
  // 图的情绪标签要包含「无语」，否则别说嘲讽，任何图都命中不了这个查询
  const list = [mk('mock', { emotion: ['嘲讽', '无语'], scene: [], keywords: [] }, { description: '斜眼嘲讽' })];
  const scored = scoreStickers(list, '无语', [], noPrefs);
  assert.equal(scored.length, 1, '无语语境本来就要嘲讽图，不能一起扣');
  assert.ok(scored[0]._score > 0);
});

test('嘲讽图在诚恳语境下的惩罚值足以打掉家族分', () => {
  assert.ok(MOCK_PENALTY > 6, '惩罚要大于情绪标签家族分，否则嘲讽图还能靠家族分留在候选里');
});

test('stickerTouchesTerms：按词集判断同类准入', () => {
  const terms = termsOfFamilies(['歉意']);
  assert.equal(stickerTouchesTerms(mk('a', { emotion: [], scene: ['道歉'], keywords: [] }), terms), true);
  assert.equal(stickerTouchesTerms(mk('b', { emotion: ['嘲讽'], scene: [], keywords: [] }), terms), false);
  assert.equal(stickerTouchesTerms(mk('c', { emotion: [], scene: [], keywords: [] }), terms), false);
  assert.equal(stickerTouchesTerms(mk('d', { emotion: ['道歉'] }), new Set()), false);
});

test('向量补充通道：已有候选时也只收同类图', () => {
  // 起因：旧代码只在 0 命中时限制同类，有候选时完全不限，
  // 「不好意思」已有道歉图入选，向量又把「不是哥们」按相似度补回来。
  const emotionVec = [1, 0];
  const stickers = [
    { id: 'apology', tags: { emotion: ['道歉'] } },
    { id: 'mock', tags: { emotion: ['嘲讽'] } },
  ];
  const vectorMap = { apology: [1, 0], mock: [0.99, 0.14] }; // mock 的语义相似度更高
  const scored = [{ ...stickers[0], _score: 6 }];
  applyVectorBonus(scored, stickers, emotionVec, vectorMap, [], noPrefs, null, null,
    { allowedTerms: termsOfFamilies(['歉意']) });
  const ids = scored.map((s) => s.id);
  assert.ok(ids.includes('apology'));
  assert.ok(!ids.includes('mock'), '跨类的嘲讽图不能靠向量相似度混进候选');
});

test('向量补充通道：查询词归不了类时不限同类，只靠字面命中', () => {
  const emotionVec = [1, 0];
  const stickers = [
    { id: 'a', tags: { emotion: ['某个怪词'] } },
    { id: 'b', tags: { emotion: ['另一个怪词'] } },
  ];
  const vectorMap = { a: [1, 0], b: [0.98, 0.2] };
  const scored = [{ ...stickers[0], _score: 8 }];
  applyVectorBonus(scored, stickers, emotionVec, vectorMap, [], noPrefs, null, null, { allowedTerms: null });
  assert.equal(scored.length, 2, '无法归类时不该把向量候选也一并关掉');
});

test('pickTopCandidate：分差 ≥4 直接取第一', () => {
  const scored = [{ id: 'a', _score: 10 }, { id: 'b', _score: 5 }, { id: 'c', _score: 4 }];
  for (let i = 0; i < 5; i++) {
    assert.equal(pickTopCandidate(scored, () => Math.random()).id, 'a');
  }
});

test('pickTopCandidate：领先 50% 也直接取第一', () => {
  const scored = [{ id: 'a', _score: 9 }, { id: 'b', _score: 6 }];
  assert.equal(pickTopCandidate(scored, () => 0.99).id, 'a');
});

test('pickTopCandidate：分差很小时仍保留抽样', () => {
  const scored = [{ id: 'a', _score: 7 }, { id: 'b', _score: 6 }, { id: 'c', _score: 6 }];
  // random 拉满时落在最后一个
  assert.equal(pickTopCandidate(scored, () => 0.999).id, 'c');
  // random 为 0 时取第一个
  assert.equal(pickTopCandidate(scored, () => 0).id, 'a');
});

test('pickTopCandidate：空和单个候选', () => {
  assert.equal(pickTopCandidate([]), null);
  assert.equal(pickTopCandidate([{ id: 'only', _score: 3 }]).id, 'only');
});