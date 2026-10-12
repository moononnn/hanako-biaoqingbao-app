// tests/express-emotion-direction.test.mjs
// v0.2.13 - 修「关切」被向量兜底选中「求安慰」类图（施受方向反了）的回归测试。
// 覆盖三件事：
//   1) 同义词表新增「安慰」类，且索取侧词（求安慰/卖惨）不在表里
//   2) scene 通道参与组匹配：「关切」命中 scene=安慰 的图，不命中 scene=求安慰 的图
//   3) 标签 0 命中时的向量兜底收紧档：只收同类图 / 阈值抬高
// 这些用例都是纯函数，不读磁盘、不调模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreStickers,
  applyVectorBonus,
  groupsOfEmotion,
  stickerTouchesGroups,
  VECTOR_MIN_SIM,
  VECTOR_STRICT_MIN_SIM,
} from '../tools/express.js';
import { EMOTION_SYNONYMS, TAG_TO_GROUP } from '../lib/emotion-groups.js';

const noPrefs = { vetoed: [], disliked: {} };
const mk = (id, tags) => ({ id, file: `${id}.png`, description: '', tags });

test('「安慰」类已登记，且只收给予侧词', () => {
  assert.ok(Array.isArray(EMOTION_SYNONYMS.安慰), '缺「安慰」大类');
  for (const w of ['关切', '关心', '安慰', '想抱抱你']) {
    assert.ok(EMOTION_SYNONYMS.安慰.includes(w), `安慰类缺 ${w}`);
  }
  // 索取侧词不能归入安慰类，否则「关切」又会捞回「求安慰」的图
  for (const w of ['求安慰', '卖惨', '求抱抱']) {
    assert.ok(!EMOTION_SYNONYMS.安慰.includes(w), `安慰类不该包含 ${w}`);
    assert.equal(TAG_TO_GROUP[w], undefined, `${w} 不该有语义组`);
  }
});

test('groupsOfEmotion：表内词有组，表外词返回空', () => {
  assert.deepEqual(groupsOfEmotion('关切'), ['安慰']);
  assert.deepEqual(groupsOfEmotion('一个不存在的怪词'), []);
});

test('scene 通道参与组匹配：「关切」命中安慰场景、不命中求安慰场景', () => {
  const list = [
    mk('give', { emotion: [], scene: ['安慰'], keywords: [] }),
    mk('take', { emotion: [], scene: ['求安慰'], keywords: [] }),
  ];
  const scored = scoreStickers(list, '关切', [], noPrefs);
  const ids = scored.map((s) => s.id);
  assert.ok(ids.includes('give'), '安慰场景的图应被「关切」命中');
  assert.ok(!ids.includes('take'), '求安慰场景的图不该被「关切」命中');
});

test('回归：精确场景匹配仍走原来的 +5 通道', () => {
  const list = [mk('s1', { emotion: [], scene: ['撒娇'], keywords: [] })];
  const scored = scoreStickers(list, '撒娇', [], noPrefs);
  assert.equal(scored.length, 1);
  assert.equal(scored[0]._score, 5);
});

test('严格兜底：只收与情绪同类的向量候选（方向反的图被挡）', () => {
  const emotionVec = [1, 0];
  const stickers = [
    mk('give', { emotion: [], scene: ['安慰'], keywords: [] }),
    mk('take', { emotion: [], scene: ['求安慰'], keywords: [] }),
  ];
  const vectorMap = {
    give: [1, 0],            // cos = 1
    take: [0.95, 0.31],      // cos ≈ 0.95，语义很近但方向反
  };
  const scored = [];
  applyVectorBonus(scored, stickers, emotionVec, vectorMap, [], noPrefs, null, null,
    { minSim: VECTOR_STRICT_MIN_SIM, allowedGroups: ['安慰'] });
  assert.deepEqual(scored.map((s) => s.id), ['give']);
});

test('严格兜底：同类也没图时退回高阈值纯向量，宁缺毋滥', () => {
  const emotionVec = [1, 0];
  const stickers = [mk('weak', { emotion: [], scene: [], keywords: [] }), mk('strong', { emotion: [], scene: [], keywords: [] })];
  const vectorMap = {
    weak: [0.4, 0.9165],   // cos ≈ 0.4：低于收紧档 0.45，高于默认档 0.35
    strong: [0.9, 0.436],  // cos ≈ 0.9
  };
  const ok = [];
  applyVectorBonus(ok, stickers, emotionVec, vectorMap, [], noPrefs, null, null,
    { minSim: VECTOR_STRICT_MIN_SIM });
  assert.deepEqual(ok.map((s) => s.id), ['strong']);

  // 默认档（有标签候选时的补充通道）门槛仍是 0.35，0.4 的图会被收
  const relaxed = [];
  applyVectorBonus(relaxed, stickers, emotionVec, vectorMap, [], noPrefs, null, null, {});
  assert.deepEqual(relaxed.map((s) => s.id).sort(), ['strong', 'weak']);
  assert.equal(VECTOR_MIN_SIM, 0.35);
});

test('stickerTouchesGroups：看 emotion / scene / keywords 三个字段', () => {
  const groups = new Set(['安慰']);
  assert.equal(stickerTouchesGroups(mk('a', { scene: ['关心'] }), groups), true);
  assert.equal(stickerTouchesGroups(mk('b', { emotion: ['委屈'] }), groups), false);
  assert.equal(stickerTouchesGroups(mk('c', { keywords: ['拍拍'] }), groups), true);
});
