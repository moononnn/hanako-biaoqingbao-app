// tests/observer.test.mjs
//
// 覆盖 v0.1.9「App 接管配图注入」这批改动的纯逻辑：
//   1. 频率抽样与场景校准（决定该不该配图）
//   2. 关键词清洗
//   3. 注入文案与注入动作（改写 messages）
//   4. 分析文本构造
//   5. 悬浮球路由前缀（不能指回插件版）
//
// 不覆盖真实的模型调用与宿主钩子分发 —— 那两条只能实机验。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

// 必须赶在 import 之前：shared.js 在模块加载时就会按这个变量定下数据目录，
// 不能让它落到真实的 app-data 上。
process.env.BQB_DATA_DIR = path.join(os.tmpdir(), `bqb-observer-test-${process.pid}`);

const observer = await import('../lib/observer.js');
const analysis = await import('../lib/text-analysis.js');
const { buildAppRouteUrl } = await import('../lib/ball.js');

// ── 频率抽样 ──────────────────────────────────────────────

test('抽样：0% 永不通过，100% 总是通过', () => {
  assert.equal(observer.passesFrequency(0, 0), false);
  assert.equal(observer.passesFrequency(0, 0.999), false);
  assert.equal(observer.passesFrequency(100, 0), true);
  assert.equal(observer.passesFrequency(100, 0.999), true);
});

test('抽样：50% 的边界（随机值恰好等于阈值不通过）', () => {
  assert.equal(observer.passesFrequency(50, 0.49), true);
  assert.equal(observer.passesFrequency(50, 0.5), false);
});

test('抽样：非法或越界值被钳到 0~100，不会让配图失控', () => {
  assert.equal(observer.passesFrequency(undefined, 0), false);
  assert.equal(observer.passesFrequency('abc', 0), false);
  assert.equal(observer.passesFrequency(-30, 0), false);
  assert.equal(observer.passesFrequency(300, 0.999), true);
});

// ── 场景校准（两阶段抽样的第二阶段）────────────────────────

test('场景校准：日常 100% 预筛时，正事 20% 落成 20%', () => {
  assert.equal(observer.getConditionalScenePercent(20, 100), 20);
});

test('场景校准：预筛与目标相等时校准为 100%（不再二次打折）', () => {
  assert.equal(observer.getConditionalScenePercent(50, 50), 100);
});

test('场景校准：任一侧为 0 时结果 0，且上限不超过 100', () => {
  assert.equal(observer.getConditionalScenePercent(0, 100), 0);
  assert.equal(observer.getConditionalScenePercent(50, 0), 0);
  assert.equal(observer.getConditionalScenePercent(100, 50), 100);
});

// ── 关键词清洗 ────────────────────────────────────────────

test('关键词：去重、去空、支持逗号与顿号分隔', () => {
  assert.deepEqual(observer.sanitizeKeywords(['加班', '加班', '', '猫']), ['加班', '猫']);
  assert.deepEqual(observer.sanitizeKeywords('加班，猫、生日'), ['加班', '猫', '生日']);
});

test('关键词：超长截断到 12 字，最多 6 个', () => {
  const long = '一'.repeat(30);
  assert.equal(observer.sanitizeKeywords([long])[0].length, 12);
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.equal(observer.sanitizeKeywords(many).length, 6);
});

test('关键词：非数组非字符串一律给空数组', () => {
  assert.deepEqual(observer.sanitizeKeywords(null), []);
  assert.deepEqual(observer.sanitizeKeywords(123), []);
});

// ── 注入文案 ──────────────────────────────────────────────

test('注入文案：点名 express，并写死「这一轮最多发一张」', () => {
  const text = observer.buildHintText('委屈');
  assert.match(text, /委屈/);
  assert.match(text, /express/);
  assert.match(text, /这一轮最多发一张/);
});

test('注入文案：不再出现插件版的旧宿主拐杖（tool_search / biaoqingbao_express）', () => {
  const text = observer.buildHintText('开心', ['加班'], '刚聊到加班', { scene: '加班', tone: '自嘲', intensity: 'medium' });
  assert.doesNotMatch(text, /tool_search/);
  assert.doesNotMatch(text, /biaoqingbao_express/);
  assert.doesNotMatch(text, /tool_call/);
});

test('注入文案：堵住「用文字写标记代替调工具」这条路（v0.1.25）', () => {
  const text = observer.buildHintText('开心');
  assert.match(text, /不要用文字写标记来代替/);
  // 故意不给那句标记的字面样子：写出来反而可能被照抄
  assert.doesNotMatch(text, /<express/);
  assert.doesNotMatch(text, /mood-send/);
});

test('注入文案：关键词、场景、语气、强度带进参数提示', () => {
  const text = observer.buildHintText('无语', ['猫', '拆家'], '猫又拆家', { scene: '拆家', tone: '调侃', intensity: 'light' });
  assert.match(text, /关键词：猫、拆家/);
  assert.match(text, /场景：拆家/);
  assert.match(text, /语气：调侃/);
  assert.match(text, /强度：light/);
});

test('注入文案：没有附加信息时不留下空标签', () => {
  const text = observer.buildHintText('开心');
  assert.doesNotMatch(text, /关键词：/);
  assert.doesNotMatch(text, /场景：/);
});

// ── 注入动作 ──────────────────────────────────────────────

test('注入：返回新数组，原消息一个字节都不动（宿主对象可能是冻的）', () => {
  const messages = [
    { role: 'user', content: '今天好累' },
    { role: 'assistant', content: '抱抱' },
    { role: 'user', content: '谢谢' },
  ];
  // 模拟宿主的冻结对象：原地写会抛 TypeError，复制写法必须照样跑通
  const frozen = Object.freeze(messages.map((m) => Object.freeze({ ...m })));
  const next = observer.buildInjectedMessages(frozen, '感动');
  assert.notEqual(next, frozen);
  assert.equal(next.length, 3);
  assert.match(next[2].content, /感动/);
  assert.equal(frozen[2].content, '谢谢'); // 原数组没被碰
  assert.equal(next[0].content, '今天好累'); // 别的消息保持原样
});

test('注入：数组型 content 追加为一段文本，不改动原数组', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: '看图' }] }];
  const next = observer.buildInjectedMessages(messages, '好奇');
  assert.equal(next[0].content[0].text, '看图');
  assert.match(next[0].content[1].text, /好奇/);
  assert.equal(messages[0].content.length, 1); // 原消息没被 push
});

test('注入：保留原消息的其他字段（如 timestamp）', () => {
  const messages = [{ role: 'user', content: '在吗', timestamp: 1791164317863 }];
  const next = observer.buildInjectedMessages(messages, '开心');
  assert.equal(next[0].timestamp, 1791164317863);
  assert.equal(next[0].role, 'user');
});

test('注入：没有用户消息时不注入', () => {
  assert.equal(observer.buildInjectedMessages([{ role: 'assistant', content: '自言自语' }], '开心'), null);
});

test('注入：最后一条用户消息的 content 类型不认识时放弃注入', () => {
  assert.equal(observer.buildInjectedMessages([{ role: 'user', content: 12345 }], '开心'), null);
});

test('注入：messages 不是数组时给 null，不抛异常', () => {
  assert.equal(observer.buildInjectedMessages(null, '开心'), null);
  assert.equal(observer.buildInjectedMessages('x', '开心'), null);
});

test('注入：拿上一轮结果再注一次会叠加（调用方需自控频率）', () => {
  const messages = [{ role: 'user', content: '在吗' }];
  const once = observer.buildInjectedMessages(messages, '开心');
  const twice = observer.buildInjectedMessages(once, '期待');
  assert.equal((twice[0].content.match(/💡/g) || []).length, 2);
  assert.equal((messages[0].content.match(/💡/g) || []).length, 0); // 原消息仍是干净的
});

// ── 分析文本构造 ──────────────────────────────────────────

test('文本提取：字符串、文本块、多模态对象都能取到正文', () => {
  assert.equal(analysis.extractText('你好'), '你好');
  assert.equal(analysis.extractText([{ type: 'text', text: '看图' }]), '看图');
  assert.equal(analysis.extractText({ text: '嵌套' }), '嵌套');
});

test('文本提取：tool_use 之类不混进对话正文', () => {
  const content = [
    { type: 'text', text: '我查一下' },
    { type: 'tool_use', name: 'search', input: { q: '天气' } },
  ];
  assert.equal(analysis.extractText(content), '我查一下');
});

test('文本提取：空值一律给空串，不抛异常', () => {
  assert.equal(analysis.extractText(null), '');
  assert.equal(analysis.extractText(undefined), '');
  assert.equal(analysis.extractText([]), '');
});

test('分析内容：只取最后 6 条 user/assistant，带角色前缀', () => {
  const messages = [];
  for (let i = 1; i <= 8; i++) {
    messages.push({ role: 'user', content: `u${i}` });
    messages.push({ role: 'assistant', content: `a${i}` });
  }
  const text = analysis.buildAnalyzeText(messages);
  const lines = text.split('\n');
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^用户：u6$/);
  assert.match(lines[5], /^助手：a8$/);
});

test('分析内容：显式给了 context 就直接用，不再拼消息', () => {
  const text = analysis.buildAnalyzeText([{ role: 'user', content: 'u' }], '外部给的上下文');
  assert.equal(text, '外部给的上下文');
});

test('分析内容：messages 不是数组时给空串', () => {
  assert.equal(analysis.buildAnalyzeText(null), '');
  assert.equal(analysis.buildAnalyzeText('x'), '');
});

test('分析内容：尾巴上全是工具往返时，仍能捞到有正文的最近几轮', () => {
  // 宿主给的消息里混着 toolResult 和只带 tool_use 的 assistant。
  // 旧写法「先切最后 6 条再过滤」会被工具消息挤满，一条正文都剩不下。
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '今天好累啊' }] },
    { role: 'assistant', content: [{ type: 'text', text: '抱抱你' }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'a' }] },
    { role: 'toolResult', content: [{ type: 'text', text: '工具结果甲' }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'b' }] },
    { role: 'toolResult', content: [{ type: 'text', text: '工具结果乙' }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'c' }] },
    { role: 'toolResult', content: [{ type: 'text', text: '工具结果丙' }] },
  ];
  const text = analysis.buildAnalyzeText(messages);
  assert.match(text, /今天好累啊/);
  assert.match(text, /抱抱你/);
  assert.ok(!/工具结果/.test(text), '工具结果不能混进对话正文');
});

test('分析内容：全是有正文的往返时，仍然是最近 6 条', () => {
  const messages = [];
  for (let i = 1; i <= 10; i++) {
    messages.push({ role: 'user', content: `u${i}` });
    messages.push({ role: 'assistant', content: `a${i}` });
  }
  const lines = analysis.buildAnalyzeText(messages).split('\n');
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^用户：u8$/);
  assert.match(lines[5], /^助手：a10$/);
});

test('分析内容：完全没有正文时不硬凑，返回空串', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', name: 'a' }] },
    { role: 'toolResult', content: [{ type: 'text', text: '结果' }] },
  ];
  assert.equal(analysis.buildAnalyzeText(messages), '');
});

test('分析内容：custom 角色不计入对话正文', () => {
  const messages = [
    { role: 'user', content: '真的吗' },
    { role: 'custom', content: '注入的提示不该被当成对话' },
  ];
  const text = analysis.buildAnalyzeText(messages);
  assert.match(text, /真的吗/);
  assert.ok(!/注入的提示/.test(text));
});

test('分析内容：剥掉 <mood> 内心草稿，不占额度也不干扰判断', () => {
  const messages = [
    { role: 'user', content: '薄荷那盆还有救吗' },
    { role: 'assistant', content: '<mood>\nVibe: 心疼得很\nReflections:\n  - 该不该劝她换土\n</mood>\n还有救，掐两节插水里就行。' },
  ];
  const text = analysis.buildAnalyzeText(messages);
  assert.match(text, /还有救/);
  assert.ok(!/Vibe:/.test(text), '内心草稿不该流给辅助模型');
  assert.ok(!/Reflections/.test(text));
});

test('分析内容：单条过长会截断，不让一条撑满预算', () => {
  const long = '啊'.repeat(900);
  const text = analysis.buildAnalyzeText([{ role: 'assistant', content: long }]);
  assert.ok(text.length < 450, `太长：${text.length}`);
  assert.match(text, /…$/);
});

test('分析内容：整段有长度上限，防止拖慢辅助模型', () => {
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: 'x'.repeat(400) });
    messages.push({ role: 'assistant', content: 'y'.repeat(400) });
  }
  const text = analysis.buildAnalyzeText(messages);
  assert.ok(text.length <= 1900, `超上限：${text.length}`);
  assert.match(text, /助手：y+…?$/, '从后往前挑，最后一条一定在');
});

// ── Jev 旁路状态 ──────────────────────────────────────────

test('Jev 状态：只取最后 6 条 user/assistant，忽略其他角色', () => {
  const messages = [
    { role: 'system', content: '系统提示不该进状态' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'custom', content: 'custom 不该进' },
    { role: 'user', content: 'u2' },
  ];
  const state = observer.buildJevState(messages);
  assert.match(state, /用户：u1/);
  assert.match(state, /助手：a1/);
  assert.match(state, /用户：u2/);
  assert.doesNotMatch(state, /系统提示/);
  assert.doesNotMatch(state, /custom 不该进/);
});

test('Jev 状态：messages 不是数组时给空串', () => {
  assert.equal(observer.buildJevState(null), '');
});

// ── 悬浮球路由前缀（脱离插件版）──────────────────────────

test('悬浮球路由：指向 App 自己的路由前缀', () => {
  const url = buildAppRouteUrl(14500, '/api/sticker/chat');
  assert.equal(url, 'http://127.0.0.1:14500/api/apps/biaoqingbao-app/routes/api/sticker/chat');
});

test('悬浮球路由：不再指回插件版的 /api/plugins/biaoqingbao', () => {
  const url = buildAppRouteUrl(14500, '/api');
  assert.doesNotMatch(url, /\/api\/plugins\//);
});
