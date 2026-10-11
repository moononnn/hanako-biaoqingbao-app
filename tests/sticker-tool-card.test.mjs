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
    throw new Error('不允许二次投递或调用模型：' + type);
  } } } };
}
function registeredExpress(sdk, result, delivered) {
  const start = entrySource.indexOf('execute: async (input) => {', entrySource.indexOf('for (const rel of TOOL_MODULES)'));
  const end = entrySource.indexOf('\n      });', start);
  assert.ok(start >= 0 && end > start);
  const expression = entrySource.slice(start + 'execute: '.length, end).trim().replace(/,$/, '');
  return vm.runInNewContext('(' + expression + ')', {
    t: { name: 'express', execute: async () => result }, sdk,
    legacyToolCtx: input => input.context,
    stripInlineBase64: vm.runInNewContext('(' + entrySource.slice(
      entrySource.indexOf('  const stripInlineBase64 = ') + '  const stripInlineBase64 = '.length,
      entrySource.indexOf('\n  const legacyToolCtx = ')).trim().replace(/;$/, '') + ')'),
    extractSelectedSticker: delivery.extractSelectedSticker,
    createStickerToolCard: delivery.createStickerToolCard,
    markInjectionDelivered: value => delivered.push(value),
    queueStickerDelivery: () => { throw new Error('不能再排队送 custom 图'); },
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

test('模型配图提供工具图卡构造入口，不再要求 custom 二次投递', () => {
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
  assert.equal(Object.hasOwn(out.card, 'cardInstanceId'), false);
  assert.equal(Object.hasOwn(out.card, 'hanaAppCardSource'), false);
  assert.equal(new URL(out.card.route, 'https://fixture.invalid').searchParams.get('recordId'), out.recordId);
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

test('没有会话编号时不给无归属卡片', async () => {
  const out = await delivery.createStickerToolCard({ sdk: { bus: { request: async () => [] } }, dataDir, sessionPath: 'C:/missing.jsonl', sticker });
  assert.equal(out.ok, false);
  assert.match(out.error, /编号/);
});

test('旧 custom 卡与旧 hash 身份仍能读取；非法业务编号不得抢优先级', () => {
  const id = 'a_' + '3'.repeat(20);
  assert.equal(candidates('', { cardInstanceId: id })[0], id);
  assert.equal(candidates('?recordId=../data.json', { cardInstanceId: id })[0], id);
  assert.equal(candidates('', {}, '#id=' + id)[0], id);
});

test('真实注册回调返回 details.card，保留附加信息并阻止定稿重复补发', async () => {
  const { sdk, calls } = fixtureSdk(), delivered = [];
  const result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { action: 'selected', sticker } }) }], details: { preserved: true } };
  const execute = registeredExpress(sdk, result, delivered);
  const out = await execute({ context: { sessionPath }, emotion: '开心' });
  assert.equal(out.details.preserved, true);
  assert.match(out.details.card.route, /recordId=a_/);
  assert.equal(out.content[0].text, result.content[0].text);
  assert.deepEqual(delivered, [sessionPath]);
  assert.deepEqual(calls, ['session:list']);
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
  assert.ok(out.details.card);
});

test('未选中图片的工具结果原样返回，不造卡、不标记送达', async () => {
  const { sdk, calls } = fixtureSdk(), delivered = [];
  const result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { action: 'no_match' } }) }] };
  const out = await registeredExpress(sdk, result, delivered)({ context: { sessionPath } });
  assert.equal(out, result);
  assert.deepEqual(delivered, []);
  assert.deepEqual(calls, []);
});
