import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-tool-card-'));
process.env.BQB_DATA_DIR = dataDir;
const delivery = await import('../lib/sticker-delivery.js');
const viewSource = fs.readFileSync(new URL('../ui/assets/message-card-view.js', import.meta.url), 'utf8');
const entrySource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const { readMessageCard, setMessageCardFeedback } = await import('../lib/ball-message-card.js');
const { skippedToolResult } = await import('../lib/sticker-gate.js');
beforeEach(() => delivery.__resetSessionIdCacheForTests());
const sessionPath = 'C:/fixture/agents/demo/sessions/a.jsonl';
const imagePath = path.join(dataDir, 'fixture.png');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(imagePath, PNG);
const sticker = { id: 'fixture', filePath: imagePath, description: '测试图' };
function fixtureSdk() {
  const calls = [];
  return { calls, sdk: { dataDir, bus: { request: async (type) => {
    calls.push(type);
    if (type === 'session:list') return [{ sessionId: 'sess_fixture', path: sessionPath }];
    if (type === 'session:stage-file') return { mediaItem: { type: 'session_file', fileId: 'sf_fixture', mime: 'image/png' } };
    throw new Error('express 图卡不应走回合外投递或调用模型：' + type);
  } } } };
}
function registeredExpress(sdk, result, delivered, gate = null) {
  const start = entrySource.indexOf('execute: async (input) => {', entrySource.indexOf('for (const rel of TOOL_MODULES)'));
  const end = entrySource.indexOf('\n      });', start);
  assert.ok(start >= 0 && end > start);
  const expression = entrySource.slice(start + 'execute: '.length, end).trim().replace(/,$/, '');
  return vm.runInNewContext('(' + expression + ')', {
    t: { name: 'express', execute: async () => result }, sdk,
    // 配图准入：默认 null = 闸门没装（旧行为）；单独用例会传真闸门进来。
    stickerAccess: gate,
    gateMod: { skippedToolResult },
    legacyToolCtx: input => input.context,
    stripInlineBase64: vm.runInNewContext('(' + entrySource.slice(
      entrySource.indexOf('  const stripInlineBase64 = ') + '  const stripInlineBase64 = '.length,
      entrySource.indexOf('\n  const legacyToolCtx = ')).trim().replace(/;$/, '') + ')'),
    extractSelectedSticker: delivery.extractSelectedSticker,
    createStickerToolCard: delivery.createStickerToolCard,
    markInjectionDelivered: value => delivered.push(value),
    queueStickerDelivery: () => { throw new Error('express 图卡不能改走回合末补投'); },
    record() {},
  });
}
function candidates(search, context, hash = '') {
  const start = viewSource.indexOf('  function candidateIds(context) {');
  const end = viewSource.indexOf('\n  // 现场记录', start);
  assert.ok(start >= 0 && end > start);
  const fn = vm.runInNewContext('(' + viewSource.slice(start, end).trim() + ')', { URLSearchParams, location: { search, hash } });
  return Array.from(fn(context));
}

test('模型配图提供兼容投递入口', () => {
  assert.equal(typeof delivery.createStickerToolCard, 'function');
});

test('工具卡优先读取显式业务记录，不把宿主铸造的卡编号当图片记录', () => {
  const own = 'a_' + '1'.repeat(20), native = 'a_' + '2'.repeat(20);
  assert.equal(candidates('?recordId=' + own, { cardInstanceId: native })[0], own);
});

test('工具卡准备保留图片、会话、伙伴与情绪，宿主身份和证明留给 Hana', async () => {
  const { sdk, calls } = fixtureSdk();
  const out = await delivery.createStickerToolCard({ sdk, dataDir, sessionPath, sticker, text: '测试图', emotion: '开心' });
  assert.equal(out.ok, true);
  assert.equal(out.card.pluginId, 'biaoqingbao-app');
  assert.equal(out.card.sessionId, 'sess_fixture');
  assert.equal(out.card.type, 'iframe');
  assert.match(out.card.route, /recordId=a_/);
  assert.equal(Object.hasOwn(out.card, 'cardInstanceId'), false);
  assert.equal(Object.hasOwn(out.card, 'hanaAppCardSource'), false);
  assert.equal(out.preparedRecord.id, out.recordId);
  const stored = readMessageCard(dataDir, out.recordId);
  assert.equal(stored.sender, 'partner');
  assert.equal(stored.triggerTurn, false);
  assert.equal(stored.agentId, 'demo');
  assert.equal(stored.emotion, '开心');
  assert.equal(stored.stickerId, sticker.id);
  assert.equal(stored.text, '测试图');
  assert.equal(fs.readdirSync(path.join(dataDir, 'ball-message-cards', 'images')).length > 0, true);
  assert.deepEqual(calls, ['session:list']);
});

test('同图在两次工具调用中独立记录，不争抢同一业务记录的显示租约', async () => {
  const { sdk } = fixtureSdk();
  const first = await delivery.createStickerToolCard({ sdk, dataDir, sessionPath, sticker });
  const second = await delivery.createStickerToolCard({ sdk, dataDir, sessionPath, sticker });
  assert.equal(first.ok && second.ok, true);
  assert.notEqual(first.recordId, second.recordId);
});

test('同一明确请求重读仍用原记录，反馈不会被覆盖', async () => {
  const { sdk } = fixtureSdk();
  const args = { sdk, dataDir, sessionPath, sticker, requestId: 'fixture-repeat' };
  const first = await delivery.createStickerToolCard(args);
  setMessageCardFeedback(dataDir, readMessageCard(dataDir, first.recordId), { feedback: 'positive', feedbackKind: 'context' });
  const second = await delivery.createStickerToolCard(args);
  assert.equal(first.recordId, second.recordId);
  assert.equal(readMessageCard(dataDir, second.recordId).feedbackKind, 'context');
});

test('读不到图片时明确失败，不能偷偷回退到二次发图', async () => {
  const { sdk, calls } = fixtureSdk();
  const out = await delivery.createStickerToolCard({ sdk, dataDir, sessionPath, sticker: { id: 'missing', filePath: path.join(dataDir, 'missing.png') } });
  assert.equal(out.ok, false);
  assert.deepEqual(calls, []);
});

// 编号只是图卡的门槛，不是投递的门槛；两样都没有时依旧不能造出无归属的卡片。
// （issue #1 之后：没编号但能登记附件时，应当只出附件；这里连令牌也没有，才真失败。）
test('没有会话编号也没有投递令牌时，不给无归属卡片', async () => {
  const out = await delivery.createStickerToolCard({ sdk: { bus: { request: async () => [] } }, dataDir, sessionPath: 'C:/missing.jsonl', sticker });
  assert.equal(out.ok, false);
  assert.equal(out.card, undefined);
});

test('没有会话编号但有投递令牌时，只出会话附件、不出图卡', async () => {
  const staged = { mediaItem: { type: 'session_file', fileId: 'sf_x', mime: 'image/png' } };
  const sdk = { bus: { request: async (type) => {
    if (type === 'session:list') return [];
    if (type === 'session:stage-file') return staged;
    return { ok: false };
  } } };
  const out = await delivery.createStickerToolCard({ sdk, dataDir, sessionPath: 'C:/missing.jsonl', callToken: 'tok', sticker });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.card, undefined);
  assert.equal(out.noSessionId, true);
  assert.deepEqual(out.media, { items: [staged.mediaItem] });
});

test('旧 custom 卡与旧 hash 身份仍能读取；非法业务编号不得抢优先级', () => {
  const id = 'a_' + '3'.repeat(20);
  assert.equal(candidates('', { cardInstanceId: id })[0], id);
  assert.equal(candidates('?recordId=../data.json', { cardInstanceId: id })[0], id);
  assert.equal(candidates('', {}, '#id=' + id)[0], id);
});

test('真实注册回调把图卡放进当前工具结果，保留 Bridge 附件且不回合末补投', async () => {
  const { sdk, calls } = fixtureSdk(), delivered = [];
  const result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { action: 'selected', sticker } }) }], details: { preserved: true } };
  const execute = registeredExpress(sdk, result, delivered);
  const out = await execute({ context: { sessionPath, callToken: 'call_fixture' }, emotion: '开心' });
  assert.equal(out.details.preserved, true);
  assert.match(out.details.card.route, /recordId=a_/);
  assert.equal(out.details.media.items[0].fileId, 'sf_fixture');
  assert.equal(out.content[0].text, result.content[0].text);
  assert.deepEqual(delivered, [sessionPath]);
  assert.deepEqual(calls, ['session:list', 'session:stage-file']);
});

test('注册回调准备失败要明确报失败，不标记送达、不排队', async () => {
  const { sdk, calls } = fixtureSdk(), delivered = [];
  const result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { action: 'selected', sticker: { id: 'missing', filePath: 'missing.png' } } }) }] };
  const out = await registeredExpress(sdk, result, delivered)({ context: { sessionPath } });
  assert.equal(JSON.parse(out.content[0].text).ok, false);
  assert.equal(out.details, undefined);
  assert.deepEqual(delivered, []);
  assert.deepEqual(calls, []);
});

test('小于旧阈值的 data URL 也剥离，图卡与记录仍正常返回', async () => {
  const { sdk } = fixtureSdk(), delivered = [];
  const payload = { ok: true, data: { action: 'selected', sticker: { ...sticker, url: 'data:image/png;base64,' + PNG.toString('base64') } } };
  const result = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  const out = await registeredExpress(sdk, result, delivered)({ context: { sessionPath } });
  const returned = JSON.parse(out.content[0].text);
  assert.equal(returned.data.sticker.url, undefined);
  assert.equal(payload.data.sticker.url.startsWith('data:'), true);
  assert.match(out.details.card.route, /recordId=a_/);
});

test('长回复超过兜底等待仍在生成时保留队列，不把图塞回模型', async () => {
  const { queueStickerDelivery, flushStickerDelivery, hasPendingSticker, __resetStickerQueueForTests } = await import('../lib/sticker-after-turn.js');
  let sends = 0;
  const sdk = { bus: { request: async type => {
    if (type === 'session:list') return [{ sessionId: 'sess_fixture', path: sessionPath }];
    if (type === 'session:context') return { isStreaming: true };
    if (type === 'session:send-custom') sends++;
    return { ok: true };
  } } };
  try {
    queueStickerDelivery({ sdk, dataDir, sessionPath, sticker });
    const out = await flushStickerDelivery(sessionPath, 'timeout');
    assert.equal(out.deferred, true);
    assert.equal(hasPendingSticker(sessionPath), true);
    assert.equal(sends, 0);
  } finally { __resetStickerQueueForTests(); }
});

test('定稿队列透传独立记录，等空闲才投递且跨回合同图仍能显示', async () => {
  const { queueStickerDelivery, flushStickerDelivery } = await import('../lib/sticker-after-turn.js');
  const payloads = [];
  const sdk = { bus: { request: async (type, payload) => {
    if (type === 'session:list') return [{ sessionId: 'sess_fixture', path: sessionPath }];
    if (type === 'session:context') return { isStreaming: false };
    if (type === 'session:send-custom') { payloads.push(payload); return { ok: true, entryId: 'entry_queue' }; }
    throw new Error(type);
  } } };
  for (const requestId of ['turn-one', 'turn-two']) {
    const prepared = await delivery.createStickerToolCard({ sdk, dataDir, sessionPath, sticker, requestId });
    queueStickerDelivery({ sdk, dataDir, sessionPath, sticker, preparedRecord: prepared.preparedRecord });
    const out = await flushStickerDelivery(sessionPath);
    assert.equal(out.ok, true, out.error);
    assert.equal(payloads.at(-1).details.cardInstanceId, prepared.recordId);
  }
  assert.equal(payloads.length, 2);
  assert.notEqual(payloads[0].details.cardInstanceId, payloads[1].details.cardInstanceId);
});

test('自定义消息只投递一次、不启动新回合、不回灌像素，并保留三键所需记录', async () => {
  const sent = [];
  const sdk = { bus: { request: async (type, payload) => {
    if (type === 'session:list') return [{ sessionId: 'sess_fixture', path: sessionPath }];
    if (type === 'session:send-custom') { sent.push(payload); return { ok: true, entryId: 'entry_once' }; }
    throw new Error(type);
  } } };
  const args = { sdk, dataDir, sessionPath, sticker, requestId: 'custom-once' };
  const first = await delivery.createStickerToolCard(args);
  assert.equal(sent.length, 0, '工具中不直接向正在生成的回合注入');
  const flushArgs = { ...args, preparedRecord: first.preparedRecord };
  const delivered = await delivery.deliverStickerToSession(flushArgs);
  const second = await delivery.deliverStickerToSession(flushArgs);
  assert.equal(delivered.ok && second.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, 'partner-sticker');
  assert.equal(sent[0].triggerTurn, false);
  assert.equal(sent[0].details.cardInstanceId, first.recordId);
  assert.equal(sent[0].content.some(item => item.type === 'image'), false);
  assert.equal(readMessageCard(dataDir, first.recordId).stickerId, sticker.id);
});

test('自定义投递超时不盲重试，不伪称本地图卡成功', async () => {
  let sends = 0;
  const sdk = { bus: { request: async type => {
    if (type === 'session:list') return [{ sessionId: 'sess_fixture', path: sessionPath }];
    if (type === 'session:send-custom') { sends++; throw new Error('timeout'); }
    throw new Error(type);
  } } };
  const args = { sdk, dataDir, sessionPath, sticker, requestId: 'custom-timeout' };
  const prepared = await delivery.createStickerToolCard(args);
  const flushArgs = { ...args, preparedRecord: prepared.preparedRecord };
  const first = await delivery.deliverStickerToSession(flushArgs);
  const second = await delivery.deliverStickerToSession(flushArgs);
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(sends, 1);
  assert.match(first.error, /未确认/);
});

test('未选中图片的工具结果原样返回，不造卡、不标记送达', async () => {
  const { sdk, calls } = fixtureSdk(), delivered = [];
  const result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { action: 'no_match' } }) }] };
  const out = await registeredExpress(sdk, result, delivered)({ context: { sessionPath } });
  assert.equal(out, result);
  assert.deepEqual(delivered, []);
  assert.deepEqual(calls, []);
});

test('Code 窗口总闸关着时 express 直接拒，不进选图、不造卡', async () => {
  const { sdk, calls } = fixtureSdk(), delivered = [];
  const deny = async () => ({
    allowed: false,
    reason: 'code_window_off',
    window: 'code',
    text: 'Code 窗口的总开关是关着的。',
  });
  const out = await registeredExpress(sdk, { content: [] }, delivered, deny)({ context: { sessionPath }, emotion: '开心' });
  const payload = JSON.parse(out.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.action, 'skipped');
  assert.equal(payload.data.reason, 'code_window_off');
  assert.match(payload.data.message, /Code 窗口/);
  assert.deepEqual(delivered, []);
  assert.deepEqual(calls, []);
});

test('Code 窗口总闸打开时照旧走选图', async () => {
  const { sdk } = fixtureSdk(), delivered = [];
  const result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { action: 'no_match' } }) }] };
  const allow = async () => ({ allowed: true, reason: 'ok', window: 'code', text: '' });
  const out = await registeredExpress(sdk, result, delivered, allow)({ context: { sessionPath }, emotion: '开心' });
  assert.equal(out, result);
});
