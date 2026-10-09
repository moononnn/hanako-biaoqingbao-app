// v0.1.38 回归：伙伴配的图要排到「这一轮说完之后」再投
//
// 背景：宿主判断要不要为一条消息再叫一轮，写的是
//   needsTurn = isSessionStreaming(sessionPath) || triggerTurn !== false
// 模型是在回话中途调 express 的，那一刻会话正在生成中，第一个条件已经成立，
// 所以边回话边投必然多出一轮，那一轮手里只有那张图，就会说成「趁你还没回话」。
// 这个模块把图压到回复定稿之后投，测试盯住的是队列本身的纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  queueStickerDelivery,
  flushStickerDelivery,
  hasPendingSticker,
  __resetStickerQueueForTests,
} from '../lib/sticker-after-turn.js';

const sticker = { id: 'stk_test', file: 'stk_test.png', description: '测试用图' };

test.beforeEach(() => __resetStickerQueueForTests());
test.after(() => __resetStickerQueueForTests());

test('没人排队时投递什么都不做，不当成错误', async () => {
  const r = await flushStickerDelivery('C:/tmp/sess.jsonl');
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test('排队信息不完整直接拒绝，不进队列', () => {
  assert.equal(queueStickerDelivery({}).ok, false);
  assert.equal(queueStickerDelivery({ sessionPath: 'C:/tmp/sess.jsonl', sticker }).ok, false, '缺 sdk 不收');
  assert.equal(queueStickerDelivery({ sessionPath: 'C:/tmp/sess.jsonl', sdk: {} }).ok, false, '缺图不收');
  assert.equal(hasPendingSticker('C:/tmp/sess.jsonl'), false);
});

test('排上队以后投一次就出队；同一段对话重复排队只留最后一张', async () => {
  const sdk = { bus: { request: async () => { throw new Error('这个假 sdk 查不了会话状态'); } } };
  const base = { sdk, dataDir: 'C:/tmp/nope', sessionPath: 'C:/tmp/sess.jsonl', text: 'x', emotion: '开心' };
  assert.equal(queueStickerDelivery({ ...base, sticker }).ok, true);
  assert.equal(hasPendingSticker('C:/tmp/sess.jsonl'), true);
  // 后一张覆盖前一张，队列里始终只有一条
  assert.equal(queueStickerDelivery({ ...base, sticker: { ...sticker, id: 'stk_test2' } }).ok, true);

  const first = await flushStickerDelivery('C:/tmp/sess.jsonl', 'hook');
  assert.equal(typeof first, 'object', '投递失败也要返回结果，不能抛');
  assert.equal(first.probed, false, '假 sdk 查不到会话状态时要如实标出来');
  assert.equal(hasPendingSticker('C:/tmp/sess.jsonl'), false, '投过一次就出队');

  const second = await flushStickerDelivery('C:/tmp/sess.jsonl', 'hook');
  assert.equal(second.skipped, true, '再投就没有了，不会重复发');
});

test('会话路径大小写不同算同一段对话', () => {
  const sdk = { bus: { request: async () => { throw new Error('n/a'); } } };
  assert.equal(queueStickerDelivery({ sdk, dataDir: 'C:/tmp/nope', sessionPath: 'C:/TMP/Sess.jsonl', sticker, text: '', emotion: '' }).ok, true);
  assert.equal(hasPendingSticker('c:/tmp/sess.jsonl'), true);
});

// 2026-10-09 实机修正：空闲探测原先只传 legacySessionPath，宿主那个解析器不认它，
// 于是每张图都白白多等 2.5 秒才投出去（用户看到的就是「说完话停一会儿图才出现」）。
// 这次钉住两个字段都带上，并且能认出宿主到底认哪一个。
test('空闲探测同时带 sessionId 与 sessionPath，宿主认哪个都能用', async () => {
  const asked = [];
  const sdk = {
    bus: {
      request: async (_verb, payload) => {
        asked.push(payload);
        if (_verb === 'session:context') return { isStreaming: false };
        throw new Error('n/a');
      },
    },
  };
  assert.equal(queueStickerDelivery({ sdk, dataDir: 'C:/tmp/nope', sessionPath: 'C:/tmp/sess.jsonl', sticker, text: '', emotion: '' }).ok, true);
  const r = await flushStickerDelivery('C:/tmp/sess.jsonl', 'hook');
  const ctx = asked.find((p) => p.scope === 'all' && p.sessionPath);
  assert.ok(ctx, '应该真的去问了一次会话状态');
  assert.ok(!('legacySessionPath' in ctx), 'legacySessionPath 是宿主不认的那个字段，不能再发');
  assert.equal(ctx.sessionPath, 'C:/tmp/sess.jsonl', 'sessionPath 要带上');
  assert.equal(r.probed, true, '宿主认了参数就该标记为真的探测到了');
});
