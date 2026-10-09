import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// v0.1.17 - 两张流内卡共用一份视图（message-card-view.js），
// 入口文件只决定显不显示配文，所以这里挂真实视图 + 纸飞机入口。
const viewSource = fs.readFileSync(new URL('../ui/assets/message-card-view.js', import.meta.url), 'utf8')
  .replace("import { hana } from './sdk.js';", '')
  .replace('export function mountMessageCard', 'function mountMessageCard');
const source = viewSource + '\nmountMessageCard({ showCaption: true });\n';
const idA = 'a_' + 'a'.repeat(20);
const idB = 'a_' + 'b'.repeat(20);
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

function fakeElement(height = 0, natural = { naturalWidth: 600, naturalHeight: 400 }) {
  const classes = new Set();
  return {
    textContent: '', hidden: false, style: {}, events: {}, ...natural,
    classList: {
      toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    addEventListener(name, callback) { this.events[name] = callback; },
    removeAttribute(name) { delete this[name]; },
    getBoundingClientRect() { return { height }; },
  };
}

function ui(context, fetch, initialSearch = '', viewport = { width: 314, height: 51 }, pathname = '/paper-plane-message.html') {
  const elements = Object.fromEntries(['image', 'caption', 'status', 'fb-card', 'fb-pos', 'fb-fit', 'fb-neg', 'fb-toast']
    .map(key => [key, fakeElement(key === 'message' ? 240 : 0)]));
  const message = fakeElement(240);
  let onContext;
  const calls = [];
  const resizeRequests = [];
  // v0.1.27 - 卡头标题走 hana.chrome.set，这里把它收下来当断言依据。
  const chromeSets = [];
  // 窗口地址也要能改：卡片在宿主没给身份时会从地址里找记录编号。
  const search = { value: initialSearch };
  const viewportBox = { innerWidth: viewport.width, innerHeight: viewport.height };
  const doc = { hidden: false };
  const listeners = {};
  // v0.1.32 - 卡片把“重新可见就再试一次”当成一条自愈路径，测试要能手动触发它。
  const contextBox = { value: context };
  const sandbox = {
    location: { get search() { return search.value; }, hash: '', pathname },
    document: Object.assign(doc, {
      getElementById: key => elements[key],
      querySelector: () => message,
      addEventListener(name, callback) { listeners[name] = callback; },
      body: { scrollHeight: 240 },
    }),
    window: { addEventListener() {}, get innerWidth() { return viewportBox.innerWidth; }, get innerHeight() { return viewportBox.innerHeight; } },
    requestAnimationFrame: callback => callback(),
    ResizeObserver: class { observe() {} },
    setTimeout, clearTimeout,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    URLSearchParams,
    hana: {
      ready() {},
      ui: { resize(size) { resizeRequests.push(size); } },
      chrome: { set(description) { chromeSets.push(description); return Promise.resolve({ ok: true }); } },
      surface: { getContext: () => contextBox.value, onContextChanged(callback) { onContext = callback; } },
      api: { fetch: async (route, init) => {
        // 显示配置与认不出记录时的现场上报都是卡片自己的前置/诊断请求，不计入「卡片数据请求」的断言。
        if (route === '/api/display-config') {
          return { ok: true, json: async () => ({ ok: true, data: { sizeMode: 'auto', smallImageFit: true, showFeedbackButtons: true } }) };
        }
        if (route.startsWith('/api/message-card-context')) {
          return { ok: true, json: async () => ({ ok: true }) };
        }
        // v0.1.30 - 聊天记录也是卡片自己的前置请求（没记录就只是 null），不计入数据请求断言。
        if (route.startsWith('/api/message-card/chat')) {
          return { ok: true, json: async () => ({ ok: true, data: null }) };
        }
        calls.push({ route, init });
        return fetch(route, init);
      } },
    },
  };
  vm.runInNewContext(source, sandbox);
  return { elements, calls, resizeRequests, chromeSets, change: value => onContext(value),
    setSearch: value => { search.value = value; },
    // 身份晚一拍才补上时，卡片得能靠“页面重新可见”自愈
    setContext: value => { contextBox.value = value; },
    visibilityChange: (hidden = false) => { doc.hidden = hidden; listeners.visibilitychange?.(); },
    viewport: viewportBox, doc };
}

function response(id, text = '', sessionId = 'session-one', extra = {}) {
  return {
    ok: true,
    json: async () => ({ ok: true, data: { id, text, sessionId, state: 'accepted', stickerId: 'stk-one', ...extra } }),
    blob: async () => ({}),
  };
}

test('exact stamped id controls image and literal caption; no HTML interpolation', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, route => response(idA, '<script>no</script>'));
  await settle();
  assert.equal(state.elements.image.hidden, false);
  assert.equal(state.elements.caption.textContent, '<script>no</script>');
  // 图片本体走 /image?id=，数据走 /?id=：两条都得把记录编号放在查询串第一位。
  const isRecordRoute = (route) => route.startsWith('/api/paper-plane-message?id=' + idA)
    || route.startsWith('/api/paper-plane-message/image?id=' + idA);
  assert.ok(state.calls.every(call => isRecordRoute(call.route)),
    '记录编号必须是查询串的第一个参数（后面可以再挂认领参数）');
  assert.ok(state.calls.every(call => !call.route.includes('&id=')));
  assert.equal(state.calls.length, 2);
});

// 2026-10-09 实机：宿主把同一条图片消息挂了两个卡片实例，同一张图被画了两遍。
// 后到的那个要让位 —— 关键是它不能再去拉图片，否则重复照旧。
test('another instance is already drawing this record: yield instead of painting it twice', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' },
    () => response(idA, '', 'session-one', { duplicate: true }), '', { width: 314, height: 51 }, '/surface/token-two');
  await settle();
  assert.equal(state.calls.length, 1, '让位的那次不能再去拉图片');
  assert.equal(state.calls[0].route.includes('/image'), false);
  assert.equal(state.elements.image.hidden, true, '让位的实例不画图');
});

// 认领参数必须带上：没有它，后端分不出「我是谁」，也就判不出重复。
test('picture requests carry the instance identity used for the claim', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' },
    () => response(idA), '', { width: 314, height: 51 }, '/surface/token-one');
  await settle();
  const dataCalls = state.calls.filter(call => call.route.startsWith('/api/paper-plane-message?id='));
  assert.ok(dataCalls.length > 0 && dataCalls.every(call => call.route.includes('&instance=')),
    '取数据那次要带实例身份，图片本体那次不用');
  assert.ok(dataCalls.every(call => call.route.includes('token-one')), '实例身份取自当前 surface 路径');
});

test('compact width is reported to the host rather than only shrinking inner CSS', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, () => response(idA));
  await settle();
  assert.ok(state.resizeRequests.length > 0);
  assert.ok(state.resizeRequests.every(size => size.width === 316));
  assert.ok(state.resizeRequests.every(size => size.height > 0));
});

test('card reappearing in the view reports its size again instead of trusting the host frame', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, () => response(idA));
  await settle();
  const before = state.resizeRequests.length;
  // 切到别的对话再切回来：同一个 cardInstanceId 重新下发上下文，不能再发请求，但必须重报尺寸。
  state.change({ cardInstanceId: idA, embeddedSessionId: 'session-one' });
  await settle();
  assert.equal(state.calls.length, 2, '同一张卡重新出现不该重新拉一次数据');
  assert.ok(state.resizeRequests.length > before, '重新出现时要重新上报尺寸');
});

test('missing id never guesses the latest picture', async () => {
  const state = ui({}, () => { throw new Error('must not fetch'); });
  await settle();
  assert.equal(state.calls.length, 0);
  assert.match(state.elements.status.textContent, /认不出来/);
});

test('a record id found in the window address is used when the host has none', async () => {  const state = ui({ cardInstanceId: null, embeddedSessionId: 'session-one' }, () => response(idA), '?hana-card-instance=' + idA);
  await settle();
  assert.equal(state.elements.image.hidden, false, '地址里带的编号应该能认回记录');
  assert.equal(state.elements.status.textContent, '');
});

// v0.1.32 - 重载 App / 换对话回来时，宿主可能晚一拍才把卡片身份补上：
// 页面重新可见的那一刻要立刻再试一次，别干等下一次碰巧重新挂载。
test('重新可见时身份补上了，卡片要立刻接住', async () => {
  const state = ui(null, () => response(idA), '', { width: 314, height: 51 });
  await settle();
  assert.equal(state.calls.length, 0, '一开始没身份，不该乱取数');
  state.setContext({ cardInstanceId: idA, embeddedSessionId: 'session-one' });
  state.visibilityChange(false);
  await settle();
  assert.equal(state.calls.length, 2, '重新可见要立刻再试一次，把记录认回来');
  assert.equal(state.elements.image.hidden, false);
  assert.equal(state.elements.status.textContent, '');
});

test('an identityless context pushed later does not wipe an already loaded picture', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, () => response(idA));
  await settle();
  assert.equal(state.elements.image.hidden, false);
  // 宿主先给带编号的上下文、紧接着又推一个只带会话的，已显示的图不能被后一个抹掉。
  state.change({ cardInstanceId: null, embeddedSessionId: 'session-one' });
  await settle();
  assert.equal(state.elements.image.hidden, false);
  assert.equal(state.elements.status.textContent, '');
});

test('a null context never wipes an already loaded picture', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, () => response(idA));
  await settle();
  assert.equal(state.elements.image.hidden, false);
  state.change(null);
  await settle();
  assert.equal(state.elements.image.hidden, false);
  assert.equal(state.elements.status.textContent, '');
});

test('cross-session response is rejected and image stays hidden', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-two' }, () => response(idA));
  await settle();
  assert.equal(state.elements.image.hidden, true);
  assert.match(state.elements.status.textContent, /不属于/);
  assert.equal(state.calls.length, 1);
});

test('late reply from previous binding cannot replace current caption/image', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, route => route.endsWith(idA) ? delayed : response(idB, 'new'));
  state.change({ cardInstanceId: idB, embeddedSessionId: 'session-one' });
  await settle();
  release(response(idA, 'old'));
  await settle();
  assert.equal(state.elements.caption.textContent, 'new');
  assert.equal(state.elements.image.hidden, false);
});

test('feedback buttons post the tapped kind for this card record', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, (route) => {
    if (route.startsWith('/api/message-card/feedback')) {
      return { ok: true, json: async () => ({ ok: true, feedback: 'positive', feedbackKind: 'context', message: '已记下：这次很应景' }) };
    }
    return response(idA);
  });
  await settle();
  assert.equal(state.elements['fb-card'].hidden, false, '有图库 id 才显示反馈入口');
  state.elements['fb-fit'].events.click();
  await settle();
  const posted = state.calls.find(call => call.route === '/api/message-card/feedback');
  assert.ok(posted, '点击应景要打到反馈路由');
  assert.deepEqual(JSON.parse(posted.init.body), { id: idA, feedbackKind: 'context' });
  assert.equal(state.elements['fb-fit'].textContent, '已应景');
  assert.equal(state.elements['fb-toast'].textContent, '已记下：这次很应景');
});

test('card width follows the image size and the size mode', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, () => response(idA));
  state.elements.image.naturalWidth = 120;
  state.elements.image.naturalHeight = 120;
  await settle();
  state.elements.image.events.load();
  await settle();
  const last = state.resizeRequests[state.resizeRequests.length - 1];
  assert.equal(last.width, 132, '自适应模式：小图按原尺寸（加卡片内边距），不拉大');
});

test('feedback state from the record is reflected on the buttons', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' },
    () => response(idA, '', 'session-one', { feedback: 'negative', feedbackKind: null }));
  await settle();
  assert.equal(state.elements['fb-neg'].textContent, '已反馈');
  assert.equal(state.elements['fb-pos'].textContent, '喜欢');
});

test('cards no longer render a title row or a source line', () => {
  // v0.1.33 - 伙伴配的图和用户丢的图已经合成一张卡，这里只留这张。
  const paper = fs.readFileSync(new URL('../ui/paper-plane-message.html', import.meta.url), 'utf8');
  assert.ok(!paper.includes('class="source"'), '不该再有来源小字');
  assert.ok(!paper.includes('顺手配的表情'));
  assert.ok(paper.includes('id="fb-pos"') && paper.includes('id="fb-fit"') && paper.includes('id="fb-neg"'));
  assert.ok(!paper.includes('通过纸飞机发送'));
});

// v0.1.23 回归：图片高度上限不得再用 vh。
// vh 就是宿主给 iframe 的高度，而被上报的高度又决定这个框：报大→框大→图能更高→再报更大，
// 绕成循环（现场日志：316x52 → 316x89 → … → 316x184 → 跳回 316x52，一直重来），
// 而且开局的矮框会把图片压成几十像素。
test('卡片页面的图片高度上限不得用 vh（回归：上报高度与 vh 互相驱动成循环）', () => {
  for (const file of ['../ui/paper-plane-message.html']) {
    const html = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const imgRule = (html.match(/img\{[^}]*\}/) || [''])[0];
    assert.ok(imgRule, `${file} 应有 img 规则`);
    assert.ok(!/\d+vh/.test(imgRule), `${file} 的 img 规则不得用 vh（会与上报高度形成正反馈）`);
    assert.ok(/max-height:320px/.test(imgRule), `${file} 的图片高度上限应为固定 320px`);
  }
});

// v0.1.26 回归：高度不得再量渲染结果。
// 渲染高度被宿主给的框钳着，而框又是我们自己报上去的：框矮 → 图被压小 → 量到更小 → 再报更小。
// 现场日志里同一张 1254x1254 的图在视口 51px 时被量成 316x51，和正确的 316x353 抢同一个框，
// 来回把图压成一条、只露出头顶。
test('卡片高度按图片自然尺寸推算，不被宿主给的矮框锁死', async () => {
  // 切回对话框后宿主给的就是这种矮框（现场日志 vh=51）。
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, () => response(idA));
  state.elements.image.naturalWidth = 1254;
  state.elements.image.naturalHeight = 1254;
  await settle();
  state.elements.image.events.load();
  await settle();
  const last = state.resizeRequests[state.resizeRequests.length - 1];
  assert.equal(last.width, 316);
  assert.ok(last.height >= 316, `上报高度应至少是图片缩放后的高度，实际 ${last.height}`);
});

test('竖图按比例缩到同一宽度，高度不会超出图片本身', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, () => response(idA));
  state.elements.image.naturalWidth = 1000;
  state.elements.image.naturalHeight = 2000;
  await settle();
  state.elements.image.events.load();
  await settle();
  const last = state.resizeRequests[state.resizeRequests.length - 1];
  // 内容宽 316-12=304，高度上限 320：两倍高的竖图按宽缩到 304，高不超上限。
  assert.ok(last.height <= 320 + 12, `上报高度不应超过图片上限，实际 ${last.height}`);
  assert.ok(last.height > 300, `上报高度应贴近图片缩放高度，实际 ${last.height}`);
});

test('视口宽为 0 的不可见实例不上报尺寸（回归：残值把可见卡片压扁）', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, () => response(idA), '', { width: 0, height: 51 });
  await settle();
  assert.equal(state.resizeRequests.length, 0, '看不见的实例量到的宽高都是残值，不该上报');
  state.viewport.innerWidth = 314;
  state.elements.image.events.load();
  await settle();
  assert.ok(state.resizeRequests.length > 0, '变回可见后要恢复上报');
});

test('页面隐藏时不抢宿主已经撑好的框', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, () => response(idA));
  await settle();
  const before = state.resizeRequests.length;
  state.doc.hidden = true;
  state.change({ cardInstanceId: idA, embeddedSessionId: 'session-one' });
  await settle();
  assert.equal(state.resizeRequests.length, before, '页面隐藏时重新下发上下文不该再报尺寸');
});

// v0.1.23 回归：1px 容差。宿主改框会触发 ResizeObserver 回环，逐次都报会把宿主也拖进循环。
test('尺寸上报带 1px 容差，且现场日志记图片自然高', () => {
  assert.ok(viewSource.includes('Math.abs(width - lastW) <= 1'), 'resize 必须有 1px 容差');
  assert.ok(viewSource.includes("' nat=' + natural + 'x' + naturalH"), '现场日志要记图片自然尺寸的宽和高');
});

// v0.1.27 - 卡头标题：清单里那个静态的「表情包」是分类名，页面自己交一句人话上去。
// 谁发的 + 伙伴名 + 当时情绪决定这句话；缺哪截退哪截，不能空着也不能塞半句。
test('伙伴配的图：标题写清是谁顺手配的哪张心情', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' },
    () => response(idA, '', 'session-one', { sender: 'partner', agentName: '小花', emotion: '开心' }));
  await settle();
  assert.equal(state.chromeSets.length, 1, '记录到手后交一次标题');
  assert.equal(state.chromeSets[0].title, '小花 顺手配了张「开心」的表情包');
  assert.equal(state.chromeSets[0].titleMode, 'show');
  assert.equal(state.chromeSets[0].revision, 1);
});

test('伙伴配的图：缺情绪不带引号那截，缺名字不带名字那截', async () => {
  const noMood = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' },
    () => response(idA, '', 'session-one', { sender: 'partner', agentName: '小花' }));
  await settle();
  assert.equal(noMood.chromeSets[0].title, '小花 顺手配了张表情包');

  const noName = ui({ cardInstanceId: idB, embeddedSessionId: 'session-one' },
    () => response(idB, '', 'session-one', { sender: 'partner', emotion: '委屈' }));
  await settle();
  assert.equal(noName.chromeSets[0].title, '顺手配了张「委屈」的表情包');
  assert.equal(noName.chromeSets[0].revision, 1, '每张卡自己是独立视图，revision 从头数');
});

test('伙伴配的图：名字或情绪怪到不能用就整截退掉，不往标题里塞半句', async () => {
  const longMood = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' },
    () => response(idA, '', 'session-one', { sender: 'partner', agentName: '小花', emotion: '开心得想转圈圈那种开心' }));
  await settle();
  assert.equal(longMood.chromeSets[0].title, '小花 顺手配了张表情包', '超长情绪不切一半，整截退掉');

  const dirty = ui({ cardInstanceId: idB, embeddedSessionId: 'session-one' },
    () => response(idB, '', 'session-one', { sender: 'partner', agentName: '  \n ', emotion: '「无语」\n' }));
  await settle();
  assert.equal(dirty.chromeSets[0].title, '顺手配了张「无语」的表情包', '换行和引号要清掉，空白名字当没有');
});

test('自己发的图：标题是「你丢了一张过来」，不套伙伴那套话', async () => {
  const state = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' }, () => response(idA));
  await settle();
  assert.equal(state.chromeSets[0].title, '你丢了一张过来');
});

// v0.1.33 回归：两张流内卡合成一张后，配文得按归属区分。
// 拆卡时伙伴那张页面压根没有 caption 节点，合并后共用一张页面，条件只剩记录里的 sender。
test('合成一张卡后：伙伴配的图不配文，用户丢的图照旧显示配文', async () => {
  const partner = ui({ cardInstanceId: idA, embeddedSessionId: 'session-one' },
    () => response(idA, '顺手配的', 'session-one', { sender: 'partner', agentName: '小花', emotion: '开心' }));
  await settle();
  assert.equal(partner.elements.caption.textContent, '', '伙伴配的图不显示配文');
  assert.equal(partner.chromeSets[0].title, '小花 顺手配了张「开心」的表情包');

  const user = ui({ cardInstanceId: idB, embeddedSessionId: 'session-one' },
    () => response(idB, '你看这个', 'session-one', { sender: 'user' }));
  await settle();
  assert.equal(user.elements.caption.textContent, '你看这个', '用户丢的图保留配文');
});

// v0.1.33 回归：只留两张卡（面板 + 对话内那张），两个 customType 指同一张卡。
// 宿主要求 messageRenderers[].cardId 必须指向一张带 route 的卡，写成不存在的卡会被整条丢掉。
test('清单只注册两张卡，两个 customType 共用对话内那张', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const cards = manifest.contributes.cards;
  assert.equal(cards.length, 2, '只留面板和对话内图片卡');
  assert.deepEqual(cards.map(card => card.id).sort(), ['panel', 'paper-plane-message']);
  const renderers = manifest.contributes.messageRenderers;
  assert.equal(renderers.length, 2);
  for (const renderer of renderers) {
    assert.equal(renderer.cardId, 'paper-plane-message', `${renderer.customType} 应共用对话内那张卡`);
  }
  assert.ok(!fs.existsSync(new URL('../ui/partner-sticker-message.html', import.meta.url)), '拆掉的那张卡页面不该还在');
});

test('卡头标题走页面自己交的那条路（显式 show、revision 递增）', () => {
  assert.ok(viewSource.includes("titleMode: 'show'"), '标题策略要显式 show，别让清单里那个 hide 顺手把它藏了');
  assert.ok(viewSource.includes('chromeRevision += 1'), '同一视图内 revision 必须严格递增');
});
