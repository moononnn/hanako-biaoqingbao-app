// tests/pseudo-tag.test.mjs
//
// 覆盖 v0.1.25「模型把发图写成文字」的兜底纯逻辑：
//   1. 剪掉独占整行的伪标记（含现场那条真实样例）
//   2. 夹在句子中间的标记不剪（正常讨论这个毛病的正文不能被误伤）
//   3. 没有可剪的地方时原样返回、removed 为空
//   4. 注入登记表的增删查与过期
//
// 不覆盖钩子分发与真实投递 —— 那两条只能实机验。

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  stripPseudoTags,
  clearInjection,
  rememberInjection,
  peekInjection,
  markInjectionDelivered,
  __resetInjectionsForTests,
} = await import('../lib/pseudo-tag.js');

// ── 清洗 ──────────────────────────────────────────────────

test('清洗：现场那条真实样例（正文 + 独占三行的伪标记）', () => {
  const raw = [
    '晚上我想跟你把茶话会那条提示词拿真模型跑一遍看看效果，跑不跑得动另说，先试哈。',
    '',
    '<mood-send>',
    '<express mood="开心"/>',
    '</mood-send>',
  ].join('\n');
  const { text, removed } = stripPseudoTags(raw);
  assert.equal(removed.length, 3);
  assert.equal(text, '晚上我想跟你把茶话会那条提示词拿真模型跑一遍看看效果，跑不跑得动另说，先试哈。');
  assert.doesNotMatch(text, /mood-send|express/);
});

test('清洗：单行包裹块、自闭标签、收尾标签都能认出来', () => {
  const cases = [
    '<mood-send><express mood="开心"/></mood-send>',
    '<mood-send>',
    '</mood-send>',
    '<express/>',
    '<express emotion="开心" />',
    '<express emotion="开心">',
    '</express>',
  ];
  for (const line of cases) {
    const { text, removed } = stripPseudoTags(`好的。\n${line}`);
    assert.equal(removed.length, 1, line);
    assert.equal(text, '好的。', line);
  }
});

test('清洗：夹在句子中间的不动（这条边界是刻意的）', () => {
  const raw = '它写了这么一句：<express mood="开心"/>，然后图没出来。\n这串标记是模型自己编的。';
  const { text, removed } = stripPseudoTags(raw);
  assert.equal(removed.length, 0);
  assert.equal(text, raw);
});

test('清洗：普通正文（含尖括号但不是伪标记）原样返回', () => {
  const cases = [
    '正文里没有标记。',
    '这段在讲 HTML：<div> 和 </div> 是一对。',
    '小于号 3 < 5 是常识。',
    '<express 后面还有半句话，这行不是纯标记。',
  ];
  for (const raw of cases) {
    const { text, removed } = stripPseudoTags(raw);
    assert.equal(removed.length, 0, raw);
    assert.equal(text, raw, raw);
  }
});

test('清洗：非字符串输入不炸', () => {
  for (const raw of [null, undefined, 123, {}, []]) {
    const { text, removed } = stripPseudoTags(raw);
    assert.equal(text, raw);
    assert.deepEqual(removed, []);
  }
});

test('清洗：剪完之后不留一长串空行', () => {
  const raw = '开头。\n\n\n<express/>\n\n\n\n结尾。';
  const { text, removed } = stripPseudoTags(raw);
  assert.equal(removed.length, 1);
  assert.equal(text, '开头。\n\n结尾。');
});

// ── 注入登记 ──────────────────────────────────────────────

test('注入登记：记了能取回，清了取不到', () => {
  __resetInjectionsForTests();
  rememberInjection('/agents/hanako/sessions/a.jsonl', {
    emotion: '开心',
    keywords: ['薄荷', '浇水'],
    agentId: 'hanako',
    source: 'ritual',
  });
  const rec = peekInjection('/agents/hanako/sessions/a.jsonl');
  assert.equal(rec.emotion, '开心');
  assert.deepEqual(rec.keywords, ['薄荷', '浇水']);
  assert.equal(rec.status, 'pending');
  // 路径大小写不该影响命中
  assert.equal(peekInjection('/agents/HANAKO/sessions/A.jsonl').emotion, '开心');

  clearInjection('/agents/hanako/sessions/a.jsonl');
  assert.equal(peekInjection('/agents/hanako/sessions/a.jsonl'), null);
});

test('注入登记：超过十分钟的记录视为没有', () => {
  __resetInjectionsForTests();
  rememberInjection('/s/x.jsonl', { emotion: '无奈' });
  const future = Date.now() + 11 * 60 * 1000;
  assert.equal(peekInjection('/s/x.jsonl', future), null);
});

test('注入登记：标记已发图后状态变成 delivered', () => {
  __resetInjectionsForTests();
  rememberInjection('/s/y.jsonl', { emotion: '得意' });
  markInjectionDelivered('/s/y.jsonl');
  assert.equal(peekInjection('/s/y.jsonl').status, 'delivered');
});

test('注入登记：同一会话再记一次覆盖上一轮', () => {
  __resetInjectionsForTests();
  rememberInjection('/s/z.jsonl', { emotion: '开心', source: 'ritual' });
  rememberInjection('/s/z.jsonl', { emotion: '委屈', source: 'emotion' });
  const rec = peekInjection('/s/z.jsonl');
  assert.equal(rec.emotion, '委屈');
  assert.equal(rec.source, 'emotion');
});

test('注入登记：没有会话路径时不崩、也不落记录', () => {
  __resetInjectionsForTests();
  rememberInjection('', { emotion: '开心' });
  rememberInjection(null, { emotion: '开心' });
  assert.equal(peekInjection(''), null);
  assert.equal(peekInjection(null), null);
  markInjectionDelivered('');
  clearInjection(undefined);
});
