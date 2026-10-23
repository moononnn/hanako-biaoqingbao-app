import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { moveSticker } from '../ui/assets/sticker-reorder.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-compose-'));
process.env.BQB_DATA_DIR = root;
const { normalizeCompose, deliverCompose, createStickerInputPanel } = await import('../lib/sticker-input-panel.js');
const { readMessageCard } = await import('../lib/ball-message-card.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const valid = (patch = {}) => ({ requestId: 'request-123', text: '配文', stickerIds: [], ...patch });

for (const [label, patch] of [
  ['empty', { text: '', stickerIds: [] }], ['oversized text', { text: '字'.repeat(2001) }],
  ['too many images', { stickerIds: Array.from({ length: 9 }, (_, i) => 's' + i) }],
  ['duplicate images', { stickerIds: ['one', 'one'] }], ['invalid request', { requestId: '../x' }],
]) test('reject ' + label, () => assert.throws(() => normalizeCompose(valid(patch))));
test('image-only and text-only submissions are valid', () => {
  assert.deepEqual(normalizeCompose(valid({ text: '  ', stickerIds: ['one'] })).stickerIds, ['one']);
  assert.equal(normalizeCompose(valid({ text: ' hi ' })).text, 'hi');
});
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(root, 'send-'));
  const filePath = path.join(dataDir, 'a.png'); fs.writeFileSync(filePath, Buffer.from('image'));
  const payloads = [];
  const sdk = { dataDir, bus: { request: async (verb, body) => { payloads.push({ verb, body }); return { ok: true, entryId: 'entry' }; } } };
  return { sdk, payloads, progress: {}, findSticker: id => ({ filePath, sticker: { id, description: 'test', tags: {} } }) };
}
test('images are caption-free and text is separate; one response and no accepted message replay', async t => {
  const f = fixture(t); const input = normalizeCompose(valid({ stickerIds: ['one', 'two'] }));
  await deliverCompose({ ...f, sessionId: 'bound-session', input });
  assert.equal(f.payloads.length, 3);
  assert.deepEqual(f.payloads.map(p => p.verb), ['session:send-custom', 'session:send-custom', 'session:send']);
  assert.deepEqual(f.payloads.slice(0, 2).map(p => p.body.triggerTurn), [false, false]);
  assert.ok(f.payloads.every(p => p.body.sessionId === 'bound-session'));
  assert.ok(f.payloads.slice(0, 2).every(p => !p.body.content[0].text.includes('配文')));
  assert.equal(f.payloads[2].body.text, '配文');
  assert.equal(f.payloads[2].body.deliverAs, 'followUp');
  await deliverCompose({ ...f, sessionId: 'bound-session', input });
  assert.equal(f.payloads.length, 3);
});
test('image-only submission still triggers exactly once on the last picture', async t => {
  const f = fixture(t);
  await deliverCompose({ ...f, sessionId: 'bound', input: valid({ text: '', stickerIds: ['one', 'two'] }) });
  assert.deepEqual(f.payloads.map(p => p.body.triggerTurn), [false, true]);
});
test('explicit text rejection retries text only, while a text timeout cannot be replayed', async t => {
  const f = fixture(t); let textCalls = 0;
  f.sdk.bus.request = async (verb, body) => {
    f.payloads.push({ verb, body });
    return verb === 'session:send' && ++textCalls === 1 ? { accepted: false, error: 'reject' } : { ok: true, accepted: true };
  };
  const args = { ...f, sessionId: 'bound', input: valid({ stickerIds: ['one'] }) };
  assert.equal((await deliverCompose(args)).ok, false);
  assert.equal((await deliverCompose(args)).ok, true);
  assert.deepEqual(f.payloads.map(p => p.verb), ['session:send-custom', 'session:send', 'session:send']);
  const timeout = fixture(t);
  timeout.sdk.bus.request = async (verb, body) => { timeout.payloads.push({ verb, body }); if (verb === 'session:send') throw new Error('timeout'); return { ok: true, accepted: true }; };
  const timedArgs = { ...timeout, sessionId: 'bound', input: valid({ stickerIds: ['one'] }) };
  await assert.rejects(deliverCompose(timedArgs), /timeout/);
  assert.equal((await deliverCompose(timedArgs)).ok, false);
  assert.equal(timeout.payloads.length, 2);
});
test('missing last image prevents the whole group from starting', async t => {
  const f = fixture(t); const find = f.findSticker;
  f.findSticker = id => id === 'two' ? null : find(id);
  await assert.rejects(deliverCompose({ ...f, sessionId: 'bound', input: valid({ stickerIds: ['one', 'two'] }) }), /已被删除/);
  assert.equal(f.payloads.length, 0);
});
test('partial explicit rejection resumes without replaying first image', async t => {
  const f = fixture(t); let count = 0;
  f.sdk.bus.request = async (verb, body) => { f.payloads.push({ verb, body }); return ++count === 2 ? { ok: false, error: 'reject' } : { ok: true }; };
  const args = { ...f, sessionId: 'bound', input: valid({ stickerIds: ['one', 'two'] }) };
  const first = await deliverCompose(args); assert.equal(first.ok, false); assert.equal(first.partial, true);
  assert.equal((await deliverCompose(args)).ok, true); assert.equal(f.payloads.length, 4);
});
test('timeout stays unknown and cannot blindly replay images', async t => {
  const f = fixture(t); let calls = 0;
  f.sdk.bus.request = async () => { calls++; throw new Error('timeout'); };
  const args = { ...f, sessionId: 'bound', input: valid({ stickerIds: ['one'] }) };
  assert.equal((await deliverCompose(args)).ok, false);
  assert.equal((await deliverCompose(args)).ok, false);
  assert.equal(calls, 1);
});
function harness() {
  const routes = new Map(); let tool, shown; let calls = 0; let dismissed = 0;
  const sdk = { dataDir: fs.mkdtempSync(path.join(root, 'panel-')), tools: { register: async value => { tool = value; } }, userInteraction: {
    show: async value => { shown = value; return { panelId: 'panel' }; }, dismiss: async () => { dismissed++; },
  }, bus: { request: async (verb, body) => {
    if (verb === 'session:get') return { session: { sessionRef: { id: 'sess_bound-session' }, id: 'internal-uuid' } };
    calls++; return { ok: true };
  } } };
  const panel = createStickerInputPanel(sdk);
  panel.registerRoutes({ get: (route, fn) => routes.set('GET ' + route, fn), post: (route, fn) => routes.set('POST ' + route, fn) });
  const invoke = (route, body) => routes.get('POST /api/sticker-compose/' + route)({ req: { json: async () => body }, json: (data, status = 200) => ({ data, status }) });
  const hidden = ticket => routes.get('POST /api/sticker-compose/panel-hidden')({ req: { query: key => key === 'ticket' ? ticket : '' }, json: (data, status = 200) => ({ data, status }) });
  const library = (ticket, requestId = '') => routes.get('GET /api/sticker-compose/library')({ req: { query: key => key === 'ticket' ? ticket : requestId }, json: (data, status = 200) => ({ data, status }) });
  return { panel, sdk, invoke, hidden, library, get tool() { return tool; }, get shown() { return shown; }, get calls() { return calls; }, get dismissed() { return dismissed; } };
}
test('tool toggles: first tap opens, second tap dismisses, third opens with the same ticket', async () => {
  const h = harness(); await h.panel.registerTool();
  await h.tool.execute({ context: { sessionPath: 'fixture-session' } });
  assert.equal(h.shown.sessionId, 'sess_bound-session');
  assert.equal(h.dismissed, 0, '第一下是打开，不该收起');
  const firstTicket = h.shown.contentFrame.data.ticket;
  // 再按一下 = 收起
  await h.tool.execute({ context: { sessionPath: 'fixture-session' } });
  assert.equal(h.dismissed, 1, '第二下应收起面板');
  // 再按回来 = 重新打开，票不变（草稿和防重记录都还在这张票上）
  await h.tool.execute({ context: { sessionPath: 'fixture-session' } });
  assert.equal(h.dismissed, 1);
  assert.equal(h.shown.contentFrame.data.ticket, firstTicket, '重新打开保留绑定和草稿');
  // 面板自己关掉时会报一声，之后点按钮应该是重新打开而不是收起
  h.hidden(firstTicket);
  await h.tool.execute({ context: { sessionPath: 'fixture-session' } });
  assert.equal(h.dismissed, 1, '面板已经关了，这一下应该打开');
  const body = { ...valid(), ticket: h.shown.contentFrame.data.ticket };
  const results = await Promise.all([h.invoke('send', body), h.invoke('send', body)]);
  assert.ok(results.every(result => result.data.ok)); assert.equal(h.calls, 1);
  assert.equal((await h.invoke('send', { ...body, text: 'changed' })).status, 400);
  assert.equal((await h.invoke('send', { ...body, ticket: 'invalid' })).status, 400);
  assert.equal(h.library(firstTicket, body.requestId).data.completedRequestId, body.requestId);
  assert.equal(h.library(firstTicket, 'not-sent').data.completedRequestId, '');
});
test('reopening after 100 sends keeps working and preserves old deduplication', async () => {
  const h = harness(); await h.panel.registerTool(); await h.tool.execute({ context: { sessionPath: 'fixture-session' } });
  const ticket = h.shown.contentFrame.data.ticket;
  for (let i = 0; i < 101; i++) assert.equal((await h.invoke('send', { ...valid({ requestId: 'request-' + String(i).padStart(4, '0') }), ticket })).data.ok, true);
  // 一次点收起、一次点打开：票不变，老的防重记录还在
  await h.tool.execute({ context: { sessionPath: 'fixture-session' } });
  assert.equal(h.dismissed, 1);
  await h.tool.execute({ context: { sessionPath: 'fixture-session' } });
  assert.equal(h.shown.contentFrame.data.ticket, ticket);
  await h.invoke('send', { ...valid({ requestId: 'request-0000' }), ticket });
  assert.equal(h.calls, 101);
});
test('text timeout is not retried on an uncertain outcome', async () => {
  const h = harness(); await h.panel.registerTool(); await h.tool.execute({ context: { sessionPath: 'fixture-session' } });
  let calls = 0; h.sdk.bus.request = async () => { calls++; throw new Error('timeout'); };
  const body = { ...valid(), ticket: h.shown.contentFrame.data.ticket };
  assert.equal((await h.invoke('send', body)).data.ok, false);
  assert.equal((await h.invoke('send', body)).data.ok, false); assert.equal(calls, 1);
});
test('text accepts the host accepted receipt without an ok field', async () => {
  const sdk = { bus: { request: async () => ({ accepted: true }) } };
  assert.equal((await deliverCompose({ sdk, sessionId: 'sess_test', input: valid() })).ok, true);
  sdk.bus.request = async () => ({});
  await assert.rejects(deliverCompose({ sdk, sessionId: 'sess_test', input: valid() }), /没有确认/);
});
test('shared gallery reads pinned ids; unpin keeps underlying original', async () => {
  fs.mkdirSync(path.join(root, 'stickers'), { recursive: true });
  fs.writeFileSync(path.join(root, 'stickers', 'shared.png'), 'image');
  fs.writeFileSync(path.join(root, 'stickers.json'), JSON.stringify([{ id: 'shared', file: 'shared.png', description: 'shared' }]));
  const { readBallConfig } = await import('../lib/ball.js');
  const h = harness(); await h.panel.registerTool(); await h.tool.execute({ context: { sessionPath: 'fixture-session' } });
  const ticket = h.shown.contentFrame.data.ticket;
  assert.equal((await h.invoke('pin', { ticket, stickerId: 'shared', pinned: true })).data.ok, true);
  assert.deepEqual(readBallConfig(h.sdk).pinnedIds, ['shared']);
  assert.equal((await h.invoke('pin', { ticket, stickerId: 'shared', pinned: false })).data.ok, true);
  assert.deepEqual(readBallConfig(h.sdk).pinnedIds, []); assert.ok(fs.existsSync(path.join(root, 'stickers', 'shared.png')));
});
test('library stays newest first while newly pinned pictures go to front', async () => {
  const meta = [
    { id: 'old', file: 'old.png', added_at: '2026-01-01', description: 'old' },
    { id: 'new', file: 'new.png', added_at: '2026-10-20', description: 'new' },
    { id: 'middle', file: 'middle.png', added_at: '2026-06-01', description: 'middle' },
  ];
  for (const item of meta) fs.writeFileSync(path.join(root, 'stickers', item.file), 'image');
  const original = JSON.stringify(meta); fs.writeFileSync(path.join(root, 'stickers.json'), original);
  const h = harness(); await h.panel.registerTool(); await h.tool.execute({ context: { sessionPath: 'fixture-session' } });
  const ticket = h.shown.contentFrame.data.ticket;
  for (const id of ['old', 'new', 'middle']) await h.invoke('pin', { ticket, stickerId: id, pinned: true });
  const response = h.library(ticket);
  assert.deepEqual(response.data.data.map(item => item.id), ['new', 'middle', 'old']);
  assert.deepEqual(response.data.pinnedIds, ['middle', 'new', 'old']);
  assert.equal((await h.invoke('reorder', { ticket, ids: ['old', 'middle', 'new'] })).data.ok, true);
  assert.deepEqual(h.library(ticket).data.pinnedIds, ['old', 'middle', 'new']);
  const { readBallConfig, reorderBallPinned, setBallPinned } = await import('../lib/ball.js');
  assert.deepEqual(readBallConfig(h.sdk).pinnedIds, ['old', 'middle', 'new']);
  await setBallPinned(h.sdk, 'middle', true);
  assert.deepEqual(readBallConfig(h.sdk).pinnedIds, ['old', 'middle', 'new'], '重复加入不会移位');
  assert.equal((await reorderBallPinned(h.sdk, ['new', 'old', 'middle'])).ok, true);
  assert.deepEqual(h.library(ticket).data.pinnedIds, ['new', 'old', 'middle'], '纸飞机写同一排序函数，面板读取一致');
  assert.equal((await h.invoke('reorder', { ticket, ids: ['new', 'old'] })).data.ok, false);
  assert.equal((await h.invoke('reorder', { ticket, ids: ['new', 'new', 'middle'] })).data.ok, false);
  assert.equal((await h.invoke('reorder', { ticket: 'bad', ids: ['new', 'old', 'middle'] })).status, 400);
  assert.deepEqual(h.library(ticket).data.pinnedIds, ['new', 'old', 'middle'], '无效顺序不覆盖已有成员');
  assert.equal(fs.readFileSync(path.join(root, 'stickers.json'), 'utf8'), original);
});
test('UI executes failure retention, repeated binding and remount draft restoration', async () => {
  class Element {
    constructor() { this.value = ''; this.children = []; this.dataset = {}; this.scrollTop = 0; this.classList = { toggle() {} }; this.isConnected = true; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute() {} addEventListener() {}
  }
  const nodes = new Map(); const stored = new Map(); let onContext, observer, imageRequests = 0;
  const catalog = Array.from({ length: 60 }, (_, index) => ({ id: 's' + index, description: '图' + index, keywords: [] }));
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observer = this; }
    observe(target) { this.targets.add(target); } unobserve(target) { this.targets.delete(target); } disconnect() { this.targets.clear(); }
  }
  const document = { hidden: false, getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); }, createElement: () => new Element() };
  const source = fs.readFileSync(new URL('../ui/assets/sticker-compose.js', import.meta.url), 'utf8').replace("import { hana } from './sdk.js';", '').replace("import { createStickerPreview } from './sticker-preview.js';", '').replace("import { moveSticker } from './sticker-reorder.js';", '');
  const storage = { setItem: (key, value) => stored.set(key, value), getItem: key => stored.get(key), removeItem: key => stored.delete(key) };
  function mount() {
    const hana = { ready() {}, inputPanel: { getContext: () => ({ data: { ticket: 'ticket-a' } }), onContextChanged: fn => { onContext = fn; } },
      api: { fetch: async route => {
        if (route.includes('/api/image')) imageRequests++;
        return { ok: true, blob: async () => ({}), json: async () => route.includes('/send') ? { ok: false, error: 'network failed' } : { ok: true, data: catalog, pinnedIds: catalog.map(item => item.id) } };
      } } };
    vm.runInNewContext(source, { document, hana, createStickerPreview: () => ({ bind() {}, hide() {}, dispose() {} }), moveSticker, sessionStorage: storage, window: { addEventListener() {} }, crypto: { randomUUID: () => 'request-ui-123' }, setInterval: () => 0, clearInterval() {}, queueMicrotask, IntersectionObserver: Observer, URL: { createObjectURL: () => 'blob:mock', revokeObjectURL() {} } });
  }
  mount();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.getElementById('gallery').children.length, 60, '连续展示全部60张，不截成分页');
  assert.equal(imageRequests, 0, '未进入可视区的图不请求像素');
  const target = [...observer.targets][0];
  observer.callback([{ target, isIntersecting: true }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(imageRequests, 1, '进入可视区才加载图片');
  document.getElementById('gallery').scrollTop = 220;
  const text = document.getElementById('text'); text.value = '尚未发送的草稿'; text.oninput();
  assert.equal(document.getElementById('gallery').scrollTop, 220, '输入文字不把图库卷回顶部');
  onContext(null); onContext({ data: { ticket: 'ticket-a' } }); assert.equal(text.value, '尚未发送的草稿');
  await document.getElementById('send').onclick();
  assert.equal(text.value, '尚未发送的草稿'); assert.equal(text.disabled, true);
  assert.match(document.getElementById('status').textContent, /待发送内容已保留/);
  // 模拟 iframe 重建：同 ticket 能找回正文与请求编号，不变成一次新的重复发送。
  text.value = ''; mount(); assert.equal(text.value, '尚未发送的草稿'); assert.equal(text.disabled, true);
});
test('UI contract uses SDK binding, safe DOM, retained failure draft and explicit delete confirmation', () => {
  const ui = fs.readFileSync(new URL('../ui/assets/sticker-compose.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../ui/sticker-compose.html', import.meta.url), 'utf8');
  assert.match(ui, /hana.inputPanel.onContextChanged/); assert.match(ui, /ticket === sendingTicket/); assert.match(ui, /requestId === sendingRequestId/);
  assert.ok(!html.includes('id="close"')); assert.ok(!ui.includes("$('close')"));
  // 2026-10-22：玥儿要求「我的收藏」里能自建分类，分类要有管理态（改名、删分类、把图移出分类）。
  // 所以这里不再一刀切禁掉 managing，只保留「面板里不许有全局的管理/关闭按钮」这条；
  // 分类自己的管理态是 2026-10-22 新加的，见 tests/favorite-categories.test.mjs。
  assert.ok(!html.includes('id="manage"')); assert.ok(!ui.includes("$('manage')"));
  assert.ok(html.includes('id="context-delete"') && html.includes('id="context-title"'));
  assert.ok(!ui.includes('.innerHTML')); assert.match(ui, /待发送内容已保留/);
  assert.ok(!/requestId \|\|= crypto\.randomUUID\(\)/.test(ui), '发送编号不能直接调 randomUUID');
  assert.match(ui, /typeof crypto !== 'undefined' && typeof crypto\.randomUUID === 'function'/);
  const apiSource = fs.readFileSync(new URL('../server/api.js', import.meta.url), 'utf8');
  assert.match(apiSource, /sticker-delete\.log/, '删原图失败要留下痕迹');
  assert.match(html, /id="delete-dialog"/); assert.match(html, /id="reset-dialog"/);
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.capabilities.includes('app/input.status'));
  assert.equal(manifest.contributes.ui.inputStatus[0].toolName, 'stickers.open_compose');
});

function successUi({ stored = new Map(), send, completed = '', catalog = [], saveTitle, crypto: cryptoStub = { randomUUID: () => 'request-ui-success' } } = {}) {
  class Element {
    constructor() { this.value = ''; this.children = []; this.dataset = {}; this.scrollTop = 0; this.isConnected = true; this.style = {}; this.listeners = {}; this.classList = { toggle() {}, add() {}, remove() {} }; }
    append(...items) { this.children.push(...items); } replaceChildren(...items) { this.children = items; }
    setAttribute() {} addEventListener(type, fn) { this.listeners[type] = fn; }
    getBoundingClientRect() { return { left: 10, bottom: 60, width: 132, height: 80 }; }
    focus() { this.selectionStart = this.value.length; this.selectionEnd = this.value.length; this.scrollLeft = 160; } setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    showModal() { this.open = true; } close() { this.open = false; }
  }
  const nodes = new Map(); let context; const requests = []; let pins = catalog.map(item => item.id);
  const document = { hidden: false, getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); }, createElement: () => new Element() };
  const hana = { ready() {}, inputPanel: { getContext: () => ({ data: { ticket: 'ticket-a' } }), onContextChanged: fn => { context = fn; } }, api: { fetch: async (route, options) => {
    if (options?.body) { const body = JSON.parse(options.body); requests.push({ route, body }); if (route.includes('/reorder')) pins = body.ids; }
    if (route === '/api' && requests.at(-1)?.body.action === 'update') return { ok: true, json: async () => saveTitle ? saveTitle(requests.at(-1).body) : { ok: true } };
    if (route.includes('/send')) { await send?.(); return { ok: true, json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => ({ ok: true, data: JSON.parse(JSON.stringify(catalog)), pinnedIds: [...pins], completedRequestId: completed }), blob: async () => ({}) };
  } } };
  const source = fs.readFileSync(new URL('../ui/assets/sticker-compose.js', import.meta.url), 'utf8').replace("import { hana } from './sdk.js';", '').replace("import { createStickerPreview } from './sticker-preview.js';", '').replace("import { moveSticker } from './sticker-reorder.js';", '');
  vm.runInNewContext(source, { document, hana, createStickerPreview: () => ({ bind() {}, hide() {}, dispose() {} }), moveSticker, sessionStorage: { setItem: (k, v) => stored.set(k, v), getItem: k => stored.get(k), removeItem: k => stored.delete(k) }, window: { innerWidth: 640, innerHeight: 480, addEventListener() {} }, crypto: cryptoStub, setInterval: () => 0, clearInterval() {}, queueMicrotask, URL: { createObjectURL: () => 'blob:mock', revokeObjectURL() {} } });
  return { get: id => document.getElementById(id), context: value => context(value), stored, requests };
}
test('fallback request id when the host page has no crypto.randomUUID', async () => {
  const ui = successUi({ crypto: {} });
  await new Promise(resolve => setImmediate(resolve));
  ui.get('text').value = '没有随机数也要能发'; ui.get('text').oninput();
  await ui.get('send').onclick();
  const sent = ui.requests.find(request => request.route.includes('/send'));
  assert.match(sent.body.requestId, /^[a-zA-Z0-9_-]{8,100}$/, '退回来的编号要能过服务端校验');
  assert.equal(ui.get('text').value, '', '发送成功后清空草稿');
  assert.equal(ui.get('send').textContent, '发送', '按钮不能卡在处理中');
});
test('text progress survives a restart: accepted is not resent, unknown still blocks', async t => {
  const accepted = fixture(t);
  accepted.sdk.bus.request = async (verb, body) => { accepted.payloads.push({ verb, body }); return { ok: true, accepted: true }; };
  const input = valid({ stickerIds: [] });
  assert.equal((await deliverCompose({ ...accepted, sessionId: 'bound', input })).ok, true);
  assert.equal(accepted.payloads.length, 1);
  assert.equal((await deliverCompose({ ...accepted, sessionId: 'bound', progress: {}, input })).ok, true);
  assert.equal(accepted.payloads.length, 1, '已接纳的文字不会被重发');

  const unknown = fixture(t);
  unknown.sdk.bus.request = async () => { throw new Error('timeout'); };
  await assert.rejects(deliverCompose({ ...unknown, sessionId: 'bound', input: valid({ stickerIds: [] }) }));
  const blocked = await deliverCompose({ ...unknown, sessionId: 'bound', progress: {}, input: valid({ stickerIds: [] }) });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /不要重复发送/);
});
test('UI right click opens actions, original deletion asks confirmation, drag submits full shared order', async () => {
  const ui = successUi({ catalog: ['a', 'b', 'c'].map(id => ({ id, description: id, keywords: [] })) });
  await new Promise(resolve => setImmediate(resolve));
  const picks = ui.get('gallery').children.map(tile => tile.children[0]);
  picks[0].listeners.contextmenu({ preventDefault() {}, clientX: 20, clientY: 20 });
  assert.equal(ui.get('context-menu').hidden, false);
  ui.get('context-delete').onclick(); assert.equal(ui.get('delete-dialog').open, true);
  ui.get('delete-dialog').returnValue = 'cancel'; ui.get('delete-dialog').listeners.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!ui.requests.some(request => request.route === '/api'), '取消确认不删原图');
  const transfer = { setData() {} };
  picks[0].listeners.dragstart({ dataTransfer: transfer });
  picks[2].listeners.drop({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ui.requests.find(request => request.route.endsWith('/reorder')).body.ids, ['b', 'c', 'a']);
  const updated = ui.get('gallery').children.map(tile => tile.children[0]);
  updated[0].listeners.contextmenu({ preventDefault() {}, clientX: 20, clientY: 20 });
  ui.get('context-unpin').onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.requests.find(request => request.route.endsWith('/pin')).body.pinned, false);
});
test('right-click title editor reuses homepage update and keeps edits/dialog on failure until confirmed success', async () => {
  const catalog = [{ id: 'cat', description: '灰白猫咪八条，戴着粉色蝴蝶结的很长很长很长的标题，用来检查开头位置', keywords: ['原关键词'] }];
  let attempts = 0;
  const ui = successUi({ catalog, saveTitle: body => {
    if (++attempts === 1) return { ok: false, error: '保存失败' };
    catalog[0].description = body.description; return { ok: true };
  } });
  await new Promise(resolve => setImmediate(resolve));
  ui.get('gallery').children[0].children[0].listeners.contextmenu({ preventDefault() {}, clientX: 20, clientY: 20 });
  ui.get('context-title').onclick();
  assert.equal(ui.get('title-dialog').open, true); assert.equal(ui.get('title-value').value, catalog[0].description);
  assert.equal(ui.get('title-value').selectionStart, 0); assert.equal(ui.get('title-value').selectionEnd, 0);
  assert.equal(ui.get('title-value').scrollLeft, 0);
  ui.get('title-value').value = '  ';
  await ui.get('title-form').onsubmit({ preventDefault() {} }); assert.equal(attempts, 0);
  ui.get('title-value').value = '呆猫八条，戴着粉色蝴蝶结';
  await ui.get('title-form').onsubmit({ preventDefault() {} });
  assert.equal(ui.get('title-dialog').open, true); assert.equal(ui.get('title-value').disabled, false);
  assert.equal(ui.get('title-value').value, '呆猫八条，戴着粉色蝴蝶结'); assert.match(ui.get('title-status').textContent, /保存失败/);
  await ui.get('title-form').onsubmit({ preventDefault() {} });
  assert.equal(ui.get('title-dialog').open, false);
  assert.deepEqual(ui.requests.filter(request => request.route === '/api').map(request => request.body), [
    { action: 'update', id: 'cat', description: '呆猫八条，戴着粉色蝴蝶结' },
    { action: 'update', id: 'cat', description: '呆猫八条，戴着粉色蝴蝶结' },
  ]);
  assert.equal(ui.get('gallery').children[0].children[0].children[1].textContent, '呆猫八条，戴着粉色蝴蝶结');
  assert.deepEqual(catalog[0].keywords, ['原关键词']);
});
test('success clears draft even when visibility changes while the send is pending', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const ui = successUi({ send: () => pending });
  await new Promise(resolve => setImmediate(resolve));
  ui.get('text').value = '嘿嘿'; ui.get('text').oninput();
  const sending = ui.get('send').onclick();
  ui.context(null); ui.context({ data: { ticket: 'ticket-a' } });
  release(); await sending;
  assert.equal(ui.get('text').value, ''); assert.equal(ui.get('text').disabled, false);
  assert.equal(ui.get('queue').children.length, 0); assert.equal(ui.stored.has('bqb-compose:ticket-a'), false);
  ui.context(null); ui.context({ data: { ticket: 'ticket-a' } });
  assert.equal(ui.get('text').value, '');
});
test('late success clears only the sent ticket and never wipes a different draft', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const ui = successUi({ send: () => pending });
  await new Promise(resolve => setImmediate(resolve));
  ui.get('text').value = '旧消息'; ui.get('text').oninput(); const sending = ui.get('send').onclick();
  ui.context({ data: { ticket: 'ticket-b' } }); ui.get('text').value = '新草稿'; ui.get('text').oninput();
  release(); await sending;
  assert.equal(ui.get('text').value, '新草稿'); assert.equal(ui.stored.has('bqb-compose:ticket-a'), false);
  assert.equal(JSON.parse(ui.stored.get('bqb-compose:ticket-b')).text, '新草稿');
});
test('remount reconciles a missed success receipt against backend completion and removes saved text/images', async () => {
  const stored = new Map([['bqb-compose:ticket-a', JSON.stringify({ selected: ['sent-image'], text: '已发送', requestId: 'request-completed' })]]);
  const ui = successUi({ stored, completed: 'request-completed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.get('text').value, ''); assert.equal(ui.get('queue').children.length, 0);
  assert.equal(ui.get('text').disabled, false); assert.equal(stored.size, 0);
});
