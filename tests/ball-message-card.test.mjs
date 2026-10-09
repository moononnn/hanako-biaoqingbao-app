import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareMessageCard, readMessageCard, cardImagePath, buildMessageCardPayload, setMessageCardState, setMessageCardFeedback, nextPositiveKind, deliverMessageCard, MAX_INLINE_IMAGE_BASE64, claimRenderSlot, __resetRenderClaimsForTests, RENDER_CLAIM_TTL_MS } from '../lib/ball-message-card.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-card-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, sessionId: 'session-one', requestId: 'request-one',
    sticker: { id: 'stk-one', description: 'test', tags: {} }, text: '', bytes: Buffer.from('image-one'), mimeType: 'image/png' };
}

test('unique message binding survives reload; caption/image remain immutable', (t) => {
  const input = fixture(t);
  const first = prepareMessageCard(input);
  const second = prepareMessageCard({ ...input, requestId: 'request-two', text: '<b>caption</b>', bytes: Buffer.from('image-two') });
  assert.notEqual(first.id, second.id);
  // Current host CN(stored) rejects every format except /^[am]_[0-9a-f]{20}$/.
  assert.match(first.id, /^[am]_[0-9a-f]{20}$/);
  assert.match(second.id, /^[am]_[0-9a-f]{20}$/);
  assert.equal(readMessageCard(input.dataDir, first.id).text, '');
  assert.equal(readMessageCard(input.dataDir, second.id).text, '<b>caption</b>');
  assert.equal(fs.readFileSync(cardImagePath(input.dataDir, first)).toString(), 'image-one');
  assert.equal(fs.readFileSync(cardImagePath(input.dataDir, second)).toString(), 'image-two');
  assert.deepEqual(prepareMessageCard(input), first);
  assert.throws(() => prepareMessageCard({ ...input, text: 'changed' }), /不同内容/);
});

test('same image bytes share storage; sessions and requests still have distinct cards', (t) => {
  const input = fixture(t);
  const first = prepareMessageCard(input);
  const second = prepareMessageCard({ ...input, sessionId: 'session-two' });
  assert.notEqual(first.id, second.id);
  assert.equal(cardImagePath(input.dataDir, first), cardImagePath(input.dataDir, second));
});

test('one custom message contains image, caption/semantics and exact card id; no forged origin', (t) => {
  const input = fixture(t);
  const record = prepareMessageCard(input);
  const payload = buildMessageCardPayload({ ...input, record });
  assert.equal(payload.customType, 'paper-plane-image');
  assert.equal(payload.display, true);
  assert.equal(payload.triggerTurn, true);
  assert.equal(payload.details.cardInstanceId, record.id);
  assert.equal(payload.content.length, 2);
  assert.deepEqual(payload.content[1], { type: 'image', data: input.bytes.toString('base64'), mimeType: 'image/png' });
  assert.match(payload.content[0].text, /attached_image/);
  assert.ok(!('source' in payload) && !('origin' in payload) && !('hanaAppCustomCardSource' in payload.details));
});

test('reject path traversal, missing/changed images and unknown formats', (t) => {
  const input = fixture(t);
  assert.equal(readMessageCard(input.dataDir, '../../preferences'), null);
  assert.throws(() => cardImagePath(input.dataDir, { imageHash: '../../x' }));
  assert.throws(() => prepareMessageCard({ ...input, bytes: Buffer.alloc(0) }));
  assert.throws(() => prepareMessageCard({ ...input, mimeType: 'text/html' }));
});

test('one send call, accepted receipt, and durable deduplication after reload', async (t) => {
  const input = fixture(t);
  let calls = 0;
  const ctx = { bus: { request: async (verb, payload) => {
    calls++;
    assert.equal(verb, 'session:send-custom');
    assert.equal(payload.triggerTurn, true);
    assert.equal(payload.content[1].type, 'image');
    return { ok: true, entryId: null, mode: 'queued' };
  } } };
  let record = prepareMessageCard(input);
  assert.equal((await deliverMessageCard({ ...input, record, ctx })).ok, true);
  record = prepareMessageCard(input);
  assert.equal((await deliverMessageCard({ ...input, record, ctx })).reused, true);
  assert.equal(calls, 1);
});

test('timeouts/empty replies never claim success or blindly replay after restart', async (t) => {
  const input = fixture(t);
  let calls = 0;
  const ctx = { bus: { request: async () => { calls++; throw new Error('timeout'); } } };
  let record = prepareMessageCard(input);
  assert.equal((await deliverMessageCard({ ...input, record, ctx })).ok, false);
  record = prepareMessageCard(input);
  assert.equal(record.state, 'unknown');
  assert.equal((await deliverMessageCard({ ...input, record, ctx })).ok, false);
  assert.equal(calls, 1);
  const secondInput = { ...input, requestId: 'empty-reply' };
  record = prepareMessageCard(secondInput);
  const emptyCtx = { bus: { request: async () => ({}) } };
  assert.equal((await deliverMessageCard({ ...secondInput, record, ctx: emptyCtx })).ok, false);
  assert.equal(readMessageCard(input.dataDir, record.id).state, 'unknown');
});

test('corrupt records do not permit replay', (t) => {
  const input = fixture(t);
  const record = prepareMessageCard(input);
  fs.writeFileSync(path.join(input.dataDir, 'ball-message-cards', record.id + '.json'), '{broken');
  assert.throws(() => prepareMessageCard(input), /记录损坏/);
});

test('delivery state is durable without altering snapshot', (t) => {
  const input = fixture(t);
  const record = prepareMessageCard(input);
  const updated = setMessageCardState(input.dataDir, record, 'accepted', 'entry-one');
  assert.equal(updated.entryId, 'entry-one');
  assert.equal(readMessageCard(input.dataDir, record.id).state, 'accepted');
  assert.equal(fs.readFileSync(cardImagePath(input.dataDir, updated)).toString(), 'image-one');
});

// v0.1.17 - 卡片自己要记住反馈归属（哪张图、哪个伙伴）和反馈状态，反馈路由不再依赖「最近配图」账本。
test('card record carries the sticker, the partner and the feedback state', (t) => {
  const input = fixture(t);
  const record = prepareMessageCard({ ...input, agentId: 'hanako', emotion: '开心' });
  assert.equal(record.stickerId, 'stk-one');
  assert.equal(record.agentId, 'hanako');
  assert.equal(record.emotion, '开心');
  assert.equal(record.feedback, null);

  const saved = setMessageCardFeedback(input.dataDir, record, {
    feedback: 'positive', feedbackKind: 'both', feedbackBase: { preference: { a: 1 }, context: null },
  });
  assert.equal(saved.feedback, 'positive');
  const reloaded = readMessageCard(input.dataDir, record.id);
  assert.equal(reloaded.feedback, 'positive');
  assert.equal(reloaded.feedbackKind, 'both');
  assert.equal(reloaded.agentId, 'hanako');
  // 反馈状态不影响图片快照与投递状态。
  assert.equal(reloaded.state, 'prepared');
  assert.equal(fs.readFileSync(cardImagePath(input.dataDir, reloaded)).toString(), 'image-one');
});

test('three-button state machine: same kind cancels, different kind stacks into both', () => {
  assert.equal(nextPositiveKind(null, 'image', 'image'), 'image');
  assert.equal(nextPositiveKind(null, 'image', 'context'), 'context');
  // 再点同维度 = 取消
  assert.equal(nextPositiveKind('positive', 'image', 'image'), null);
  assert.equal(nextPositiveKind('positive', 'context', 'context'), null);
  // 跨维度 = 叠成 both
  assert.equal(nextPositiveKind('positive', 'image', 'context'), 'both');
  assert.equal(nextPositiveKind('positive', 'context', 'image'), 'both');
  // both 再点某维度 = 只剩另一个
  assert.equal(nextPositiveKind('positive', 'both', 'image'), 'context');
  assert.equal(nextPositiveKind('positive', 'both', 'context'), 'image');
  // 脏值归一到 image，不会把按钮状态算成空
  assert.equal(nextPositiveKind('positive', 'nonsense', 'image'), null);
});

// v0.1.28 - 图太大时不送像素，只送引用。
// 背景：宿主写jsonl 时对超过 1MB 的单条记录做「瘦身投影」，会把我们 custom_message 里的
// 图片 base64 就地换成 `[omitted N chars by Hana session JSONL guard]` 这句占位文字，
// 结构里却还留着「这是一张图」。此后每一轮都把这句文字当图片 base64 发给模型，
// 模型解码失败，那个窗口从此每轮 400 Invalid base64 data，且投影已落盘、不可逆。
test('oversized images degrade to a reference instead of inline pixels', (t) => {
  const input = { ...fixture(t), bytes: Buffer.alloc(300 * 1024, 7) };
  const record = prepareMessageCard(input);
  const payload = buildMessageCardPayload({ ...input, record });
  assert.equal(payload.content.length, 1);
  assert.equal(payload.content[0].type, 'text');
  assert.ok(!JSON.stringify(payload.content).includes('"type":"image"'));
  // 降级时也要把话讲清楚：路径和语义仍然有效。
  assert.match(payload.content[0].text, /没有随这条消息一起送进来/);
  assert.match(payload.content[0].text, /attached_image/);
  // 真正要守的指标：落盘那一行必须远低于宿主的 1MB 投影线。
  const line = JSON.stringify({ type: 'custom_message', customType: payload.customType, content: payload.content });
  assert.ok(Buffer.byteLength(line, 'utf8') < 1024 * 1024,
    'payload line must stay under the host projection threshold');
});

test('images exactly at the gate keep their pixels; one byte more does not', (t) => {
  const base = fixture(t);
  const atLimit = Buffer.alloc(Math.floor(MAX_INLINE_IMAGE_BASE64 / 4) * 3, 7);
  assert.equal(atLimit.toString('base64').length, MAX_INLINE_IMAGE_BASE64);
  const okPayload = buildMessageCardPayload({ ...base, bytes: atLimit, record: prepareMessageCard({ ...base, bytes: atLimit, requestId: 'at-limit' }) });
  assert.equal(okPayload.content.length, 2);
  assert.equal(okPayload.content[1].type, 'image');

  const over = Buffer.alloc(atLimit.length + 1, 7);
  const overPayload = buildMessageCardPayload({ ...base, bytes: over, record: prepareMessageCard({ ...base, bytes: over, requestId: 'over-limit' }) });
  assert.equal(overPayload.content.length, 1);
});

// v0.1.43 - 伙伴自己配的图不再把像素送回会话记录。
// 背景：那张 base64 落进 jsonl 之后，超 1MB 就会被宿主「瘦身投影」换成占位文字，
// 那个窗口从此每轮 400 Invalid base64 data（2026-10-06 的事故根因）；
// 就算不触发投影，每轮重建请求都要重发几百 KB。用户发来的图不受影响。
test('伙伴配图只送路径与语义，像素一律不进会话记录', (t) => {
  const base = fixture(t);
  const small = { ...base, sender: 'partner', requestId: 'partner-small' };
  const smallPayload = buildMessageCardPayload({ ...small, record: prepareMessageCard(small) });
  assert.equal(smallPayload.content.length, 1, '再小的图也不送像素');
  assert.match(smallPayload.content[0].text, /attached_image/);
  assert.ok(!JSON.stringify(smallPayload.content).includes('"type":"image"'));

  // 闸门以下的图也一样不送 —— 这条路压根不碰那条线。
  const big = { ...base, sender: 'partner', requestId: 'partner-big', bytes: Buffer.alloc(Math.floor(MAX_INLINE_IMAGE_BASE64 / 4) * 3, 7) };
  const bigPayload = buildMessageCardPayload({ ...big, record: prepareMessageCard(big) });
  assert.equal(bigPayload.content.length, 1);
  assert.ok(!JSON.stringify(bigPayload.content).includes('"type":"image"'));

  // 用户发来的图照旧送像素：那条路模型真的需要看懂图。
  const userPayload = buildMessageCardPayload({ ...base, record: prepareMessageCard(base) });
  assert.equal(userPayload.content[1].type, 'image');
});

// ═══ 渲染认领（2026-10-09：宿主把同一条图挂了两个实例，同一张被画两遍）═══
test('渲染认领：先到的实例拿到绘制权，后到的让位；持有者自己续期不算重复', () => {
  __resetRenderClaimsForTests();
  assert.equal(claimRenderSlot('a_one', 'surface-one').claimed, true);
  assert.equal(claimRenderSlot('a_one', 'surface-two').claimed, false, '同一时刻另一个实例该让位');
  assert.equal(claimRenderSlot('a_one', 'surface-one').claimed, true, '持有者自己续期不算重复');
});

test('渲染认领：租约过期后，后来者可以接管，不把图判没', () => {
  __resetRenderClaimsForTests();
  claimRenderSlot('a_one', 'surface-one', 1000);
  const late = claimRenderSlot('a_one', 'surface-two', 1000 + RENDER_CLAIM_TTL_MS + 1);
  assert.equal(late.claimed, true, '先到的不再续期就该让位给后来者');
});

test('渲染认领：认不出实例身份一律放行，宁可重复也不误伤唯一那张图', () => {
  __resetRenderClaimsForTests();
  claimRenderSlot('a_one', 'surface-one');
  assert.equal(claimRenderSlot('a_one', '').claimed, true);
  assert.equal(claimRenderSlot('a_one', '   ').claimed, true);
});

test('渲染认领：不同记录互不干扰', () => {
  __resetRenderClaimsForTests();
  claimRenderSlot('a_one', 'surface-one');
  assert.equal(claimRenderSlot('a_two', 'surface-two').claimed, true);
});
