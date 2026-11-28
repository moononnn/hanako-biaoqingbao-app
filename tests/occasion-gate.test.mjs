// tests/occasion-gate.test.mjs
// v0.8.0 - 场合门禁：早安/晚安这类被画面钉死在某个场合的图，不许靠情绪标签和语义相似度
// 跑到别的场合去用。
//
// 事故现场（2026-11-28）：stk_494 是一张写着「早安」的元气图，scene 只有一条早安，
// 却在「干劲十足」「如释重负」这两条查询里被选中发了出去。原因不是向量算错，
// 是标签体系里场景只当加分项，查询里没早安时它一分不扣照样参选。
//
// 这里守三件事：
//   1) 归一化：同一场合的不同说法要认成一组
//   2) 门禁：没标场合的图行为完全不变；标了的只在同场合放行
//   3) 两道通道都过闸：标签通道和向量通道谁都不能绕过
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOccasion,
  occasionSet,
  queryOccasionSet,
  isOccasionLocked,
  describeOccasion,
  occasionsInText,
  inferOccasions,
  fillInferredOccasion,
} from '../lib/occasion-gate.js';
import { scoreStickers, applyVectorBonus } from '../tools/express.js';
import { buildCandidateList, buildVerifyMessages } from '../lib/pick-verify.js';

const noPrefs = { vetoed: [], disliked: {} };
const mk = (id, extra = {}) => ({
  id,
  file: `${id}.png`,
  description: '',
  tags: { emotion: [], scene: [], keywords: [] },
  ...extra,
});

test('归一化：同一场合的不同说法归到同一组', () => {
  assert.equal(normalizeOccasion('早安'), '早安');
  assert.equal(normalizeOccasion('早上好'), '早安');
  assert.equal(normalizeOccasion('早安呀'), '早安');
  assert.equal(normalizeOccasion('晚安安'), '晚安');
  assert.equal(normalizeOccasion('晚上好'), '晚安');
  assert.equal(normalizeOccasion('生日快乐'), '生日');
  assert.equal(normalizeOccasion('恭喜发财'), '恭喜');
});

test('归一化：不是场合词就返回空，情绪词不许混进来', () => {
  for (const word of ['干劲十足', '如释重负', '撒娇', '吐槽', '开心', '']) {
    assert.equal(normalizeOccasion(word), '', `${word} 不该被当成场合`);
  }
});

test('归一化：日文与空耳音译也认（空吧哇 / 欧嗨呦）', () => {
  assert.equal(normalizeOccasion('欧嗨呦'), '早安');
  assert.equal(normalizeOccasion('おはよう'), '早安');
  assert.equal(normalizeOccasion('ohayo'), '早安');
  assert.equal(normalizeOccasion('空吧哇'), '晚安');
  assert.equal(normalizeOccasion('こんばんは'), '晚安');
  assert.equal(normalizeOccasion('おやすみ'), '晚安');
  // 打招呼不属于任何场合：任何时间都能用
  assert.equal(normalizeOccasion('こんにちは'), '');
});

test('长描述能同时判出多个场合', () => {
  const hits = occasionsInText('配文早安，睡前也会说晚安');
  assert.ok(hits.has('早安'));
  assert.ok(hits.has('晚安'));
  assert.equal(occasionsInText('猫咪翻肚皮撒娇').size, 0);
});

test('没标场合的图不受门禁影响（老图行为完全不变）', () => {
  const plain = mk('plain');
  assert.equal(isOccasionLocked(plain, new Set()), false);
  assert.equal(isOccasionLocked(plain, null), false);
  assert.equal(isOccasionLocked(plain, queryOccasionSet(['早安'])), false);
});

test('标了场合的图，查询没带场合就出局', () => {
  const morning = mk('morning', { occasion: ['早安'] });
  assert.equal(isOccasionLocked(morning, null), true, '查询没给场合集时一律锁死');
  assert.equal(isOccasionLocked(morning, queryOccasionSet([])), true);
  assert.equal(isOccasionLocked(morning, queryOccasionSet(['干劲十足'])), true);
});

test('查询带了同一场合就放行，带了别的场合不放', () => {
  const morning = mk('morning', { occasion: ['早安'] });
  assert.equal(isOccasionLocked(morning, queryOccasionSet(['早安'])), false);
  assert.equal(isOccasionLocked(morning, queryOccasionSet(['早上好'])), false, '同组说法要认');
  assert.equal(isOccasionLocked(morning, queryOccasionSet(['晚安'])), true);
});

test('回归：早安图不再被「干劲十足」选中（stk_494 事故）', () => {
  const list = [
    // 事故原图的样子：emo 有元气/治愈，scene 只有早安
    mk('morning', { occasion: ['早安'], tags: { emotion: ['元气', '治愈'], scene: ['早安'], keywords: ['早安'] } }),
    mk('daily', { tags: { emotion: ['元气'], scene: ['打气'], keywords: [] } }),
  ];
  const scored = scoreStickers(list, '干劲十足', [], noPrefs);
  const ids = scored.map((s) => s.id);
  assert.ok(ids.includes('daily'), '日常元气图该参选');
  assert.ok(!ids.includes('morning'), '早安图不该在「干劲十足」这条查询里参选');
});

test('场合对上了就能参选：早安查询能选到早安图', () => {
  const list = [mk('morning', { occasion: ['早安'], tags: { emotion: [], scene: ['早安'], keywords: ['早安'] } })];
  const query = { scene: [], tone: '', occasions: queryOccasionSet(['早安', '开心']) };
  const scored = scoreStickers(list, '开心', [], noPrefs, null, null, null, ['早安'], query);
  assert.ok(scored.some((s) => s.id === 'morning'));
});

test('场合集为空时，调用方漏传 occasions 也不会让锁失效', () => {
  const list = [mk('morning', { occasion: ['早安'], tags: { emotion: ['元气'], scene: ['早安'] } })];
  // 不传 occasions：必须按锁死处理，而不是「没限制」
  const scored = scoreStickers(list, '干劲十足', [], noPrefs);
  assert.deepEqual(scored.map((s) => s.id), []);
});

test('向量通道同样过闸：语义再近也拉不回早安图', () => {
  const emotionVec = [1, 0];
  const stickers = [mk('morning', { occasion: ['早安'], tags: { emotion: ['元气'] } })];
  const vectorMap = { morning: [1, 0] }; // cos = 1，语义上完全贴

  const blocked = [];
  applyVectorBonus(blocked, stickers, emotionVec, vectorMap, [], noPrefs, null, null,
    { queryOccasions: queryOccasionSet(['干劲十足']) });
  assert.deepEqual(blocked.map((s) => s.id), [], '向量通道不能绕过场合锁');

  const opened = [];
  applyVectorBonus(opened, stickers, emotionVec, vectorMap, [], noPrefs, null, null,
    { queryOccasions: queryOccasionSet(['早安']) });
  assert.deepEqual(opened.map((s) => s.id), ['morning']);
});

test('复核候选带上场合锁，提示词里能看见', () => {
  const list = buildCandidateList([
    mk('morning', { occasion: ['早安'], description: '配早安文字元气满满' }),
  ]);
  assert.equal(list[0].occasion, '早安');
  assert.equal(describeOccasion(mk('plain')), '');

  const messages = buildVerifyMessages({ emotion: '干劲十足', candidates: list });
  assert.match(messages[1].content, /限用场合：早安/);
});

test('occasionSet 只留词表内的组名，乱写的词直接丢掉', () => {
  const set = occasionSet(['早安', '干劲十足', '早上好', '瞎写的场合']);
  assert.deepEqual([...set].sort(), ['早安']);
});

test('推断兜底：标签与画面文字同时指向才成锁', () => {
  const written = {
    tags: { scene: ['早安'], keywords: ['樱花'] },
    semantic_description: '配文早安和太阳，适合早晨问好',
    description: '少女挥手微笑',
  };
  assert.deepEqual(inferOccasions(written), ['早安']);
});

test('推断兜底：只有标签没有画面文字，不当场锁（猫咪翻肚皮那种）', () => {
  const loose = {
    tags: { scene: ['早安'], keywords: ['猫咪', '可爱'] },
    semantic_description: '适合撒娇卖萌时发',
    description: '白猫侧躺翻肚皮',
  };
  assert.deepEqual(inferOccasions(loose), []);
});

test('推断兜底：语义里只说「适合睡前」不算画面写了字', () => {
  const loose = {
    tags: { scene: ['晚安'] },
    semantic_description: '适合睡前向朋友道别，或者累了想摆烂时发',
    description: '少女裹着被子犯困',
  };
  assert.deepEqual(inferOccasions(loose), []);
});

test('fillInferredOccasion 不覆盖已有的锁', () => {
  const entry = { occasion: ['晚安'], tags: { scene: ['早安'] }, semantic_description: '配文早安' };
  assert.equal(fillInferredOccasion(entry), false);
  assert.deepEqual(entry.occasion, ['晚安']);
});

test('fillInferredOccasion 空值时写入推断结果', () => {
  const entry = { tags: { scene: ['晚安'] }, semantic_description: '配文晚安~', description: '女仆微笑' };
  assert.equal(fillInferredOccasion(entry), true);
  assert.deepEqual(entry.occasion, ['晚安']);
});