import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// v0.1.29 - 点过「不喜欢」之后的「和小花聊聊」：聊天面板内联在卡片里、建议卡长在消息流末尾、
// 确认修改才落盘、回包没接住先回查图库。
// 挂的是真实共用视图（ui/assets/message-card-view.js），不是抄一份逻辑。
const viewSource = fs.readFileSync(new URL('../ui/assets/message-card-view.js', import.meta.url), 'utf8')
  .replace("import { hana } from './sdk.js';", '')
  .replace('export function mountMessageCard', 'function mountMessageCard');
const source = viewSource + '\nmountMessageCard({ showCaption: false });\n';
const ID = 'a_' + 'c'.repeat(20);
const STICKER = 'stk-one';
const settle = (ms = 12) => new Promise(resolve => setTimeout(resolve, ms));

// ── 最小 DOM：视图要 createElement / appendChild / querySelector / classList，
//    现有那套 fakeElement 只够图片卡，聊天要建节点，所以这里自己搭一个。 ──
function createDom() {
  const owned = new WeakMap();
  const classOf = (node) => {
    if (!owned.has(node)) owned.set(node, new Set());
    return owned.get(node);
  };
  function element(tag = 'div') {
    const node = {
      tagName: tag, children: [], parent: null, textContent: '', value: '', src: '',
      type: '', hidden: false, disabled: false, style: {}, scrollTop: 0, scrollHeight: 0,
      naturalWidth: 600, naturalHeight: 400, events: {}, attributes: {},
    };
    let className = '';
    Object.defineProperty(node, 'className', {
      get: () => [...classOf(node)].join(' '),
      set: (value) => {
        const set = classOf(node);
        set.clear();
        String(value || '').split(/\s+/).filter(Boolean).forEach(name => set.add(name));
      },
    });
    node.classList = {
      add: (...names) => names.forEach(name => classOf(node).add(name)),
      remove: (...names) => names.forEach(name => classOf(node).delete(name)),
      contains: (name) => classOf(node).has(name),
      toggle: (name, on) => { on ? classOf(node).add(name) : classOf(node).delete(name); },
    };
    node.addEventListener = (name, callback) => { (node.events[name] = node.events[name] || []).push(callback); };
    node.dispatch = (name, event = {}) => { (node.events[name] || []).forEach(callback => callback(event)); };
    node.appendChild = (child) => { child.parent = node; node.children.push(child); node.scrollHeight = node.children.length * 40; return child; };
    node.removeChild = (child) => { const index = node.children.indexOf(child); if (index >= 0) node.children.splice(index, 1); return child; };
    node.remove = () => { if (node.parent) node.parent.removeChild(node); };
    node.querySelector = (selector) => findIn(node, selector);
    node.getBoundingClientRect = () => ({ height: node.rectHeight || 0 });
    node.scrollWidth = 0;
    node.focus = () => {};
    node.getAttribute = (name) => node.attributes[name] ?? null;
    node.setAttribute = (name, value) => { node.attributes[name] = value; };
    node.removeAttribute = (name) => { delete node.attributes[name]; };
    Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
    return node;
  }
  function findIn(root, selector) {    const want = String(selector || '').replace(/^\./, '');
    for (const child of root.children) {
      if (classOf(child).has(want)) return child;
      const hit = findIn(child, selector);
      if (hit) return hit;
    }
    return null;
  }
  return { element, findIn };
}

const CARD_IDS = ['image', 'caption', 'status', 'fb-card', 'fb-pos', 'fb-fit', 'fb-neg', 'fb-toast',
  'fb-chat-row', 'fb-chat-btn', 'chat-panel', 'chat-thumb', 'chat-collapse', 'chat-msgs', 'chat-input', 'chat-send-btn'];

// 节点里的文本要递归收：视图把文字放在子孙 span 上，只看直接子节点的 textContent 会拿到空字符串。
function textOf(node) {
  const self = String(node?.textContent || '');
  return [self, ...(node?.children || []).map(textOf)].filter(Boolean).join('');
}

function mount({ fetch, record = {} }) {
  const dom = createDom();
  const elements = {};
  for (const id of CARD_IDS) elements[id] = dom.element('div');
  // 入口行有真实高度：卡片上报的高度必须把它算进去（2026-10-07 实机栽在这）
  elements['fb-chat-row'].rectHeight = 26;
  const message = dom.element('article');
  let onContext;
  const calls = [];
  const resizeRequests = [];
  const sandbox = {
    location: { search: '?id=' + ID, hash: '', pathname: '/partner-sticker-message.html' },
    document: {
      hidden: false,
      getElementById: (id) => elements[id],
      querySelector: () => message,
      createElement: (tag) => dom.element(tag),
      addEventListener() {},
      body: { scrollHeight: 240 },
    },
    window: { addEventListener() {}, innerWidth: 314, innerHeight: 400 },
    requestAnimationFrame: (callback) => callback(),
    ResizeObserver: class { observe() {} },
    setTimeout, clearTimeout,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    URLSearchParams,
    hana: {
      ready() {},
      ui: { resize(size) { resizeRequests.push(size); } },
      chrome: { set: () => Promise.resolve({ ok: true }) },
      surface: { getContext: () => ({ cardInstanceId: ID, embeddedSessionId: 's1' }), onContextChanged(callback) { onContext = callback; } },
      api: { fetch: async (route, init) => {
        if (route === '/api/display-config') {
          return { ok: true, json: async () => ({ ok: true, data: { sizeMode: 'auto', smallImageFit: true, showFeedbackButtons: true } }) };
        }
        if (route.startsWith('/api/message-card-context')) return { ok: true, json: async () => ({ ok: true }) };
        calls.push({ route, init });
        return fetch(route, init);
      } },
    },
  };
  vm.runInNewContext(source, sandbox);
  return { elements, calls, resizeRequests, dom, change: (value) => onContext(value) };
}

function recordResponse(extra = {}) {
  return {
    ok: true,
    json: async () => ({ ok: true, data: { id: ID, text: '', sessionId: 's1', state: 'accepted', stickerId: STICKER, ...extra } }),
    blob: async () => ({}),
  };
}

function jsonResponse(payload, status = 200) {
  return { ok: status < 400, status, json: async () => payload };
}

// 一个典型的机器：图片 + 反馈 + 聊天，按测试需要替换其中某几条。
function machine(overrides = {}) {
  const seen = { chat: [], confirm: [], close: [] };
  // chatLog 可改：模拟「卡片记录里还留着上次没聊完的账」
  const state = { chatLog: overrides.chatLog || null };
  const routes = {
    chat: () => jsonResponse({ ok: true, session_id: 'sess-1', reply: '听起来是标签认错了', suggestion: null, old_tags: {} }),
    confirm: () => jsonResponse({ ok: true, message: '已修改' }),
    list: () => jsonResponse({ ok: true, data: [{ id: STICKER, description: '旧描述', semantic_description: '旧语义', tags: { emotion: ['开心'], scene: ['早安'], keywords: ['猫'] } }] }),
    feedback: () => jsonResponse({ ok: true, feedback: 'negative', feedbackKind: null, message: '已记下：不喜欢' }),
    ...overrides,
  };
  const fetch = async (route, init) => {
    if (route.startsWith('/api/paper-plane-message/image')) return { ok: true, blob: async () => ({}) };
    if (route.startsWith('/api/paper-plane-message')) return recordResponse(overrides.recordExtra || {});
    if (route.startsWith('/api/message-card/chat')) return jsonResponse({ ok: true, data: state.chatLog });
    if (route.startsWith('/api/message-card/feedback')) return routes.feedback(route, init);
    if (route === '/api/sticker/chat') { seen.chat.push(JSON.parse(init.body)); return routes.chat(); }
    if (route === '/api/sticker/chat/confirm') { seen.confirm.push(JSON.parse(init.body)); return routes.confirm(); }
    if (route === '/api/sticker/chat/close') { seen.close.push(JSON.parse(init.body)); return jsonResponse({ ok: true }); }
    if (route.startsWith('/api/list')) return routes.list(route);
    throw new Error('未预期的请求 ' + route);
  };
  return { fetch, seen, routes, state };
}

test('「和小花聊聊」只在点过不喜欢之后出现', async () => {  const m = machine();
  const state = mount({ fetch: m.fetch });
  await settle();
  assert.equal(state.elements['fb-chat-row'].hidden, true, '喜欢/没表态时不该多一个按钮');
  state.elements['fb-neg'].dispatch('click');
  await settle();
  assert.equal(state.elements['fb-neg'].textContent, '已反馈');
  assert.equal(state.elements['fb-chat-row'].hidden, false, '点了不喜欢才给聊天入口');
});

// 2026-10-07 实机回归：入口行出现后卡片没变高，它落在可视区外面被裁掉，
// 用户看到的就是「点了不喜欢，什么也没出现」。
test('入口行出现后要重报尺寸，把它算进卡片高度', async () => {
  const m = machine();
  const state = mount({ fetch: m.fetch });
  await settle();
  assert.equal(state.elements['fb-chat-row'].hidden, true, '没表态时入口是隐藏的');
  const before = state.resizeRequests[state.resizeRequests.length - 1].height;
  state.elements['fb-neg'].dispatch('click');
  await settle();
  assert.equal(state.elements['fb-chat-row'].hidden, false);
  const after = state.resizeRequests[state.resizeRequests.length - 1].height;
  assert.ok(after > before, `入口出现后卡片要变高（前 ${before}，后 ${after}）`);
  assert.equal(after - before, 26 + 8, '差值就是入口行高度 + 一道 flex 间距');
});

test('记录里已经是不喜欢时，入口直接就在', async () => {
  const m = machine({ recordExtra: { feedback: 'negative', feedbackKind: null } });
  const state = mount({ fetch: m.fetch });
  await settle();
  assert.equal(state.elements['fb-chat-row'].hidden, false);
});

test('打开聊天：面板顶上来，图片和三键收起来，尺寸按面板上报', async () => {
  const m = machine({ recordExtra: { feedback: 'negative' } });
  const state = mount({ fetch: m.fetch });
  await settle();
  const before = state.resizeRequests.length;
  state.elements['fb-chat-btn'].dispatch('click');
  await settle();
  assert.equal(state.elements['chat-panel'].hidden, false);
  assert.equal(state.elements.image.hidden, true, '图片收进缩略图');
  assert.equal(state.elements['fb-card'].hidden, true);
  assert.equal(state.elements['fb-chat-row'].hidden, true, '面板开着就不用再摆入口');
  const last = state.resizeRequests[state.resizeRequests.length - 1];
  assert.equal(last.width, 316, '聊天面板要一整条宽度');
  assert.equal(last.height, 352, '面板高 340 + 卡片内边距 12');
  assert.ok(state.resizeRequests.length > before);
});

test('发一句话：打到聊天路由，回的正文落进消息流', async () => {
  const m = machine({
    recordExtra: { feedback: 'negative' },
    chat: () => jsonResponse({ ok: true, session_id: 'sess-1', reply: '听起来是标签认错了', suggestion: null, old_tags: {} }),
  });
  const state = mount({ fetch: m.fetch });
  await settle();
  state.elements['fb-chat-btn'].dispatch('click');
  state.elements['chat-input'].value = '这张图表达的是撒娇，不是开心';
  state.elements['chat-send-btn'].dispatch('click');
  await settle();
  assert.equal(m.seen.chat.length, 1);
  assert.equal(m.seen.chat[0].sticker_id, STICKER);
  assert.equal(m.seen.chat[0].card_id, ID, '要带上这张卡的编号，服务端好核对是不是同一张图');
  assert.equal(m.seen.chat[0].message, '这张图表达的是撒娇，不是开心');
  const bot = state.dom.findIn(state.elements['chat-msgs'], '.chat-msg-bot');
  assert.ok(bot, '回复要出现');
  assert.equal(bot.textContent, '听起来是标签认错了');
  assert.equal(state.elements['chat-input'].value, '', '发完清空输入框');
});

test('建议卡：只列真的变了的字段，逐行给出「现在 → 改完」', async () => {
  const m = machine({
    recordExtra: { feedback: 'negative' },
    chat: () => jsonResponse({
      ok: true, session_id: 'sess-1', reply: '那就把情绪改过来',
      suggestion: { description: '旧描述', semantic_description: '新语义', emotion: ['委屈'], scene: ['早安'], keywords: ['猫'] },
      old_tags: { description: '旧描述', semantic_description: '旧语义', emotion: ['开心'], scene: ['早安'], keywords: ['猫'] },
    }),
  });
  const state = mount({ fetch: m.fetch });
  await settle();
  state.elements['fb-chat-btn'].dispatch('click');
  state.elements['chat-input'].value = '情绪不对';
  state.elements['chat-send-btn'].dispatch('click');
  await settle();
  const card = state.dom.findIn(state.elements['chat-msgs'], '.chat-sug');
  assert.ok(card, '出建议就要有建议卡');
  const rows = card.children.filter(child => child.className.includes('sug-row'));
  assert.equal(rows.length, 2, '描述没变不列，场景和关键词没变也不列，只剩语义描述和情绪');
  const texts = rows.map(row => textOf(row));
  assert.ok(texts.some(text => text.includes('旧语义') && text.includes('新语义')), '对照要带上旧值和新值');
  assert.ok(!texts.some(text => text.includes('旧描述')), '没变化的字段不该出现');
});

test('建议卡里不想改的那条可以单独丢掉，确认时不提交它', async () => {
  const m = machine({
    recordExtra: { feedback: 'negative' },
    chat: () => jsonResponse({
      ok: true, session_id: 'sess-1', reply: '两块都调一下',
      suggestion: { description: '新描述', semantic_description: '新语义', emotion: ['委屈'], scene: ['早安'], keywords: ['猫'] },
      old_tags: { description: '旧描述', semantic_description: '旧语义', emotion: ['委屈'], scene: ['早安'], keywords: ['猫'] },
    }),
  });
  const state = mount({ fetch: m.fetch });
  await settle();
  state.elements['fb-chat-btn'].dispatch('click');
  state.elements['chat-input'].value = '调一下';
  state.elements['chat-send-btn'].dispatch('click');
  await settle();
  const card = state.dom.findIn(state.elements['chat-msgs'], '.chat-sug');
  const rows = card.children.filter(child => child.className.includes('sug-row'));
  assert.equal(rows.length, 2);
  const dropOf = (row) => row.children.find(child => child.className.includes('sug-drop'));
  dropOf(rows[0]).dispatch('click');
  assert.ok(rows[0].className.includes('dropped'), '丢掉的这条要看得出来');
  const yes = card.children.find(child => child.className.includes('sug-acts')).children
    .find(child => child.textContent === '确认修改');
  yes.dispatch('click');
  await settle();
  assert.equal(m.seen.confirm.length, 1);
  assert.equal(m.seen.confirm[0].sticker_id, STICKER);
  assert.deepEqual(m.seen.confirm[0].new_tags, { semantic_description: '新语义' }, '丢掉的那条不跟着提交');
});

test('确认成功：建议卡变回执，聊天流里留一句改了什么', async () => {
  const m = machine({
    recordExtra: { feedback: 'negative' },
    chat: () => jsonResponse({
      ok: true, session_id: 'sess-1', reply: '改吧',
      suggestion: { description: '新描述', semantic_description: '', emotion: [], scene: [], keywords: [] },
      old_tags: { description: '旧描述', semantic_description: '', emotion: [], scene: [], keywords: [] },
    }),
  });
  const state = mount({ fetch: m.fetch });
  await settle();
  state.elements['fb-chat-btn'].dispatch('click');
  state.elements['chat-input'].value = '描述改一下';
  state.elements['chat-send-btn'].dispatch('click');
  await settle();
  const card = state.dom.findIn(state.elements['chat-msgs'], '.chat-sug');
  const yes = card.children.find(child => child.className.includes('sug-acts')).children
    .find(child => child.textContent === '确认修改');
  yes.dispatch('click');
  await settle();
  assert.ok(state.dom.findIn(card, '.sug-done'), '改好了要给回执');
  const looseDone = state.elements['chat-msgs'].children
    .some(child => String(child.className || '').includes('sug-done'));
  assert.equal(looseDone, false, '回执住在建议卡里，不散在消息流');
});

test('确认没成功：建议卡和按钮留在原地，原因写卡里，能再点一次', async () => {
  let attempt = 0;
  const m = machine({
    recordExtra: { feedback: 'negative' },
    chat: () => jsonResponse({
      ok: true, session_id: 'sess-1', reply: '改吧',
      suggestion: { description: '新描述', semantic_description: '', emotion: [], scene: [], keywords: [] },
      old_tags: { description: '旧描述', semantic_description: '', emotion: [], scene: [], keywords: [] },
    }),
    confirm: () => { attempt++; return jsonResponse({ ok: false, error: '写盘炸了' }, 500); },
  });
  const state = mount({ fetch: m.fetch });
  await settle();
  state.elements['fb-chat-btn'].dispatch('click');
  state.elements['chat-input'].value = '描述改一下';
  state.elements['chat-send-btn'].dispatch('click');
  await settle();
  const card = state.dom.findIn(state.elements['chat-msgs'], '.chat-sug');
  const acts = card.children.find(child => child.className.includes('sug-acts'));
  const yes = acts.children.find(child => child.textContent === '确认修改');
  yes.dispatch('click');
  await settle();
  assert.equal(attempt, 1);
  assert.ok(state.dom.findIn(card, '.sug-note').textContent.includes('没改上'), '失败原因写在建议卡里');
  assert.ok(acts.children.find(child => child.textContent === '确认修改'), '按钮必须留着让用户重试');
  assert.equal(yes.disabled, false);
  yes.dispatch('click');
  await settle();
  assert.equal(attempt, 2, '原地就能再点一次');
});

test('回包丢了但图库其实已经改上：回查落盘，判成成功', async () => {
  const m = machine({
    recordExtra: { feedback: 'negative' },
    chat: () => jsonResponse({
      ok: true, session_id: 'sess-1', reply: '改吧',
      suggestion: { description: '新描述', semantic_description: '', emotion: [], scene: [], keywords: [] },
      old_tags: { description: '旧描述', semantic_description: '', emotion: [], scene: [], keywords: [] },
    }),
    confirm: () => { throw new Error('网络断了'); },
    list: () => jsonResponse({ ok: true, data: [{ id: STICKER, description: '新描述', semantic_description: '', tags: { emotion: [], scene: [], keywords: [] } }] }),
  });
  const state = mount({ fetch: m.fetch });
  await settle();
  state.elements['fb-chat-btn'].dispatch('click');
  state.elements['chat-input'].value = '描述改一下';
  state.elements['chat-send-btn'].dispatch('click');
  await settle();
  const card = state.dom.findIn(state.elements['chat-msgs'], '.chat-sug');
  card.children.find(child => child.className.includes('sug-acts')).children
    .find(child => child.textContent === '确认修改').dispatch('click');
  await settle();
  assert.ok(state.dom.findIn(card, '.sug-done'), '图库已经是建议值了，就该说改好了，不该让人重试');
});

test('模型没配：给一句人话指路，不是甩内部报错', async () => {
  const m = machine({
    recordExtra: { feedback: 'negative' },
    chat: () => jsonResponse({ ok: false, session_id: 'sess-1', error: '内容分析模型未启用，请在设置中启用' }, 500),
  });
  const state = mount({ fetch: m.fetch });
  await settle();
  state.elements['fb-chat-btn'].dispatch('click');
  state.elements['chat-input'].value = '试试';
  state.elements['chat-send-btn'].dispatch('click');
  await settle();
  const err = state.dom.findIn(state.elements['chat-msgs'], '.chat-msg-err');
  assert.ok(err);
  assert.ok(err.textContent.includes('内容分析模型'), '要说清去哪儿配');
  assert.equal(state.elements['chat-send-btn'].disabled, false, '失败后还能接着发');
});

test('收起聊天：图片和三键回来，账还留着以便接着聊', async () => {
  const m = machine({ recordExtra: { feedback: 'negative' } });
  const state = mount({ fetch: m.fetch });
  await settle();
  state.elements['fb-chat-btn'].dispatch('click');
  state.elements['chat-input'].value = '聊一句';
  state.elements['chat-send-btn'].dispatch('click');
  await settle();
  state.elements['chat-collapse'].dispatch('click');
  await settle();
  assert.equal(state.elements['chat-panel'].hidden, true);
  assert.equal(state.elements.image.hidden, false);
  assert.equal(state.elements['fb-card'].hidden, false, '三键要回来');
  assert.equal(state.elements['fb-chat-row'].hidden, false, '还是不喜欢状态，入口还在');
  assert.equal(state.elements['fb-chat-btn'].textContent, '接着聊', '聊过就该说接着聊');
  assert.equal(m.seen.close.length, 0, '收起不销账：服务端会话与记录都留着，下次接着看接着聊');
  const last = state.resizeRequests[state.resizeRequests.length - 1];
  assert.equal(last.height !== 352, true, '收起后不该还是聊天面板那个高度');
});

test('卡片重放：记录里的聊天接回来，旧建议与「不要的那几条」一并还原', async () => {
  const m = machine({
    recordExtra: { feedback: 'negative' },
    chatLog: {
      messages: [{ role: 'user', text: '这图不对' }, { role: 'bot', text: '那改哪' }],
      suggestion: { description: '新描述', emotion: ['委屈'] },
      oldTags: { description: '旧描述', emotion: ['开心'] },
      dropped: ['emotion'],
    },
  });
  const state = mount({ fetch: m.fetch });
  await settle();
  assert.equal(state.elements['fb-chat-btn'].textContent, '接着聊', '有没聊完的账，入口就该这么说');
  state.elements['fb-chat-btn'].dispatch('click');
  await settle();
  assert.equal(state.elements['chat-panel'].hidden, false);
  const bubbles = state.elements['chat-msgs'].children.filter(child => String(child.className).includes('chat-msg'));
  assert.equal(bubbles.length, 2, '两句话都要回来');
  assert.equal(bubbles[0].textContent, '这图不对');
  assert.equal(bubbles[1].textContent, '那改哪');
  const card = state.dom.findIn(state.elements['chat-msgs'], '.chat-sug');
  assert.ok(card, '没确认的建议要还原');
  const rows = card.children.filter(child => String(child.className).includes('sug-row'));
  const emotionRow = rows.find(row => textOf(row).includes('委屈'));
  assert.ok(emotionRow, '情绪那行要在');
  assert.ok(String(emotionRow.className).includes('dropped'), '上次标了「不要」的，这次还该是灰的');
  const drop = emotionRow.children.find(child => String(child.className).includes('sug-drop'));
  assert.equal(drop.textContent, '要改', '灰着的行按钮写「要改」，点一下能反悔');
});

test('确认改完就算销案：收起后重开是崭新的一轮', async () => {
  const m = machine({
    recordExtra: { feedback: 'negative' },
    chat: () => jsonResponse({
      ok: true, session_id: 'sess-1', reply: '改吧',
      suggestion: { description: '新描述', semantic_description: '', emotion: [], scene: [], keywords: [] },
      old_tags: { description: '旧描述', semantic_description: '', emotion: [], scene: [], keywords: [] },
    }),
  });
  const state = mount({ fetch: m.fetch });
  await settle();
  state.elements['fb-chat-btn'].dispatch('click');
  state.elements['chat-input'].value = '描述改一下';
  state.elements['chat-send-btn'].dispatch('click');
  await settle();
  const card = state.dom.findIn(state.elements['chat-msgs'], '.chat-sug');
  card.children.find(child => String(child.className).includes('sug-acts')).children
    .find(child => child.textContent === '确认修改').dispatch('click');
  await settle();
  assert.ok(state.dom.findIn(card, '.sug-done'), '先看到回执');
  assert.equal(state.elements['fb-chat-btn'].textContent, '和小花聊聊', '销案后入口回到常态说法');
  // 服务端那边把记录清了（这里让回包跟着变），收起再打开不该看见旧账
  m.state.chatLog = null;
  state.elements['chat-collapse'].dispatch('click');
  await settle();
  state.elements['fb-chat-btn'].dispatch('click');
  await settle();
  const leftovers = state.elements['chat-msgs'].children
    .filter(child => String(child.className).includes('chat-msg'));
  assert.equal(leftovers.length, 0, '销案后重开是新一轮，不堆旧气泡');
  const empty = state.dom.findIn(state.elements['chat-msgs'], '.chat-empty');
  assert.ok(empty, '该给新话题的提示');
});

test('卡片页面自带聊天面板与入口那些节点', () => {
  for (const file of ['../ui/paper-plane-message.html']) {
    const html = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const id of ['fb-chat-row', 'fb-chat-btn', 'chat-panel', 'chat-msgs', 'chat-input', 'chat-send-btn', 'chat-collapse']) {
      assert.ok(html.includes('id="' + id + '"'), `${file} 缺少 #${id}`);
    }
  }
});

// 面板高度必须写死像素：vh 就是宿主给的框，而框由我们上报的高度决定，用 vh 会互相驱动成循环
// （图片高度上限那一版已经吃过这个亏，见 v0.1.23）。
test('聊天面板高度用固定像素，不用 vh', () => {
  for (const file of ['../ui/paper-plane-message.html']) {
    const html = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const rule = (html.match(/\.chat-panel\{[^}]*\}/) || [''])[0];
    assert.ok(rule, `${file} 应有 .chat-panel 规则`);
    assert.ok(/height:340px/.test(rule), `${file} 的面板高度应为 340px`);
    assert.ok(!/\d+vh/.test(rule), `${file} 的面板高度不得用 vh`);
  }
  assert.ok(viewSource.includes('const CHAT_PANEL_HEIGHT = 340'), '视图里上报的高度要与 CSS 一致');
});
