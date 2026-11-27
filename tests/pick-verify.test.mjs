// tests/pick-verify.test.mjs
// v0.7.7 - 第三档复核的纯函数测试。
// 复核本身要调模型，不在单测里跑；这里守住三件会出错的事：
//   1) 候选裁剪（别把整个图库塞进请求）
//   2) 结果解析（模型编一个不存在的 id 必须当作没验过）
//   3) 失败放行（verifyPick 在没配置模型时必须 verified:false，不能抛）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidateList,
  buildVerifyMessages,
  parseVerifyResult,
  verifyPick,
  VERIFY_MAX_CANDIDATES,
} from '../lib/pick-verify.js';

const sticker = (id, emotion, description, semantic) => ({
  id,
  description,
  semantic_description: semantic,
  tags: { emotion },
});

test('buildCandidateList 截断到上限，只带判断要用的字段', () => {
  const many = Array.from({ length: 9 }, (_, i) => sticker(`stk_${i}`, ['无奈'], `画面${i}`, `适合${i}`));
  const list = buildCandidateList(many);
  assert.equal(list.length, VERIFY_MAX_CANDIDATES);
  assert.deepEqual(Object.keys(list[0]).sort(), ['description', 'emotion', 'id', 'semantic']);
  assert.equal(buildCandidateList(null).length, 0);
});

test('buildCandidateList 裁掉超长描述', () => {
  const long = '很长的画面描述'.repeat(20);
  const list = buildCandidateList([sticker('stk_1', ['无奈'], long, long)]);
  assert.ok(list[0].description.length <= 61, `描述被裁到 60 字加省略号，实际 ${list[0].description.length}`);
});

test('buildVerifyMessages 带上情绪和语境，候选编号可读', () => {
  const candidates = buildCandidateList([
    sticker('stk_631', ['无奈', '困惑'], '古装少女侧眼吐槽不是哥们', '适合吐槽看不懂'),
  ]);
  const messages = buildVerifyMessages({
    emotion: '不好意思',
    keywords: ['久等', '抱歉'],
    scenes: ['道歉'],
    tone: '诚恳',
    candidates,
  });
  assert.equal(messages.length, 2);
  const user = messages[1].content;
  assert.ok(user.includes('想表达：不好意思'));
  assert.ok(user.includes('久等'));
  assert.ok(user.includes('stk_631'));
  assert.ok(user.includes('画面：'));
});

test('parseVerifyResult：正常选中', () => {
  const r = parseVerifyResult('{"pick":"stk_442"}', ['stk_442', 'stk_631']);
  assert.deepEqual(r, { pick: 'stk_442', reason: '' });
});

test('parseVerifyResult：模型编造的 id 不认', () => {
  assert.equal(parseVerifyResult('{"pick":"stk_999"}', ['stk_442']), null);
  assert.equal(parseVerifyResult('{"pick":"随便一张"}', ['stk_442']), null);
});

test('parseVerifyResult：null 表示都不贴', () => {
  const r = parseVerifyResult('{"pick":null,"reason":"方向都反"}', ['stk_442']);
  assert.deepEqual(r, { pick: null, reason: '方向都反' });
  assert.deepEqual(parseVerifyResult('{"pick":"none"}', ['stk_442']).pick, null);
});

test('parseVerifyResult：容忍代码块包裹和前后废话', () => {
  assert.deepEqual(parseVerifyResult('```json\n{"pick":"stk_1"}\n```', ['stk_1']), { pick: 'stk_1', reason: '' });
  assert.deepEqual(parseVerifyResult('好的，我选这个：{"pick":"stk_1"}', ['stk_1']), { pick: 'stk_1', reason: '' });
});

test('parseVerifyResult：解析不出就返回 null，不当成否决', () => {
  assert.equal(parseVerifyResult('我觉得都不太行', ['stk_1']), null);
  assert.equal(parseVerifyResult('', ['stk_1']), null);
  assert.equal(parseVerifyResult(null, ['stk_1']), null);
});

test('verifyPick：候选不足两个时不花调用，直接放行', async () => {
  const r = await verifyPick({}, { emotion: '不好意思', candidates: [{ id: 'stk_1' }] });
  assert.equal(r.verified, false);
  assert.equal(r.reason, '候选不足');
});

test('verifyPick：没配置模型时放行，不抛错', async () => {
  const r = await verifyPick({}, {
    emotion: '不好意思',
    candidates: [{ id: 'stk_1' }, { id: 'stk_2' }],
    textConfig: { source: 'none' },
  });
  assert.equal(r.verified, false);
  assert.equal(typeof r.reason, 'string');
});

test('verifyPick：配置里显式关掉复核时放行', async () => {
  const r = await verifyPick({}, {
    emotion: '不好意思',
    candidates: [{ id: 'stk_1' }, { id: 'stk_2' }],
    textConfig: { source: 'hana', providerId: 'p', modelId: 'm', verifyPick: false },
  });
  assert.equal(r.verified, false);
  assert.equal(r.reason, '复核已关闭');
});