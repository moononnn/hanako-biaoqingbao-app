// tests/style-diff.test.mjs
//
// 「学我说话」的历史版本对比：把旧版和新版逐句比出来，标出这次新增了什么、去掉了什么。
// 纯字符串处理，不碰宿主、不碰模型、不读写真实数据。
//
// 覆盖：
//   1. 切句（含引号/括号内的句末标点不该断——这是真实文案踩出来的坑）
//   2. 逐句对比：相同句原样保留，改动句各自标记
//   3. 统计数字对得上
//   4. 两版一模一样时不给「对比」（没什么可比就别占地方）
//   5. 边界：空文案、找不到的历史版本、成对引号被拆散
//
// 引号那个坑值得记一笔：最初把右引号 ” 误写进了「开引号」集合，
// 计数只增不减，600 字只切出 2 句，几乎所有文字都被当成「新增」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, diffTexts, diffStats, compareWithVersion } from '../lib/style-diff.js';

// ── 切句 ──────────────────────────────────────────────────

test('切句：按句末标点断开并保留标点', () => {
  assert.deepEqual(splitSentences('第一句。第二句！第三句？'), ['第一句。', '第二句！', '第三句？']);
});

test('切句：引号里的感叹号不断句', () => {
  // 真实文案里的原句。断在这里会让 diff 把半句话标红，看着像删了一半。
  const text = '夸东西时感叹号就冒出来了，“这个也太好看了！”情绪上来时，感叹号偶尔会多点。';
  const parts = splitSentences(text);
  assert.equal(parts.length, 1, '整句只有一个句号在末尾（引号内的感叹号不算），不该被劈开');
  assert.ok(parts[0].includes('“这个也太好看了！”情绪上来时'), '引号内的感叹号不该把句子劈开');
});

test('切句：引号内的句子是完整一句', () => {
  const text = '夸东西时感叹号就冒出来了，“这个也太好看了！”情绪上来时，感叹号偶尔会多点。';
  const joined = splitSentences(text).join('');
  assert.equal(joined, text, '切完拼回去必须和原文一字不差');
  assert.ok(splitSentences(text).some((s) => s.includes('“这个也太好看了！”情绪上来时')), '引号内不该断');
});

test('切句：括号内的句号也不断', () => {
  const parts = splitSentences('他说（就这样）然后就走了。');
  assert.equal(parts.length, 1);
});

test('切句：引号成对时计数能归零，后面照常断句', () => {
  const parts = splitSentences('带引号的句子“里面有句号。这个也有。”结束了。第二句。');
  assert.equal(parts.length, 2);
  assert.equal(parts[0], '带引号的句子“里面有句号。这个也有。”结束了。', '引号内的句号不断句');
  assert.equal(parts[1], '第二句。', '引号闭合后要能正常断句');
});

test('切句：引号被拆散也不崩', () => {
  // 引号没闭合时宁可句子粗一点，也不报错。拼接必须仍然还原原文。
  const text = '有个没闭合的引号“在这里。第二句。';
  const parts = splitSentences(text);
  assert.ok(Array.isArray(parts) && parts.length >= 1);
  assert.equal(parts.join(''), text, '切完拼回去必须一字不差');
});

test('切句：引号不闭合时有长度兵底，不会把 600 字粘成一坨', () => {
  // 模型偶尔吐个孤立引号。没有兵底时下面这段只会切出 1 句，diff 粒度就没了。
  const text = '开头有个没闭合的引号“' + '这是一句比较长的内容。'.repeat(30);
  const parts = splitSentences(text);
  assert.ok(parts.length >= 2, `至少要切出几块，实际 ${parts.length} 块`);
  assert.equal(parts.join(''), text);
  for (const p of parts) assert.ok(p.length <= 201, `单块不该无限长，实际 ${p.length}`);
});

test('切句：空输入不炸', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
  assert.deepEqual(splitSentences(null), []);
  assert.deepEqual(splitSentences(undefined), []);
});

// ── 逐句对比 ──────────────────────────────────────────────

test('对比：相同的句两边都原样保留', () => {
  const { oldParts, newParts } = diffTexts('一样的句子。另一句一样的。', '一样的句子。另一句一样的。');
  assert.equal(oldParts.every((p) => p.type === 'same'), true);
  assert.equal(newParts.every((p) => p.type === 'same'), true);
});

test('对比：新版多出来的标 added，旧版多出来的标 removed', () => {
  const { oldParts, newParts } = diffTexts('留下的。去掉的这句。', '留下的。新加的这句。');
  assert.ok(newParts.some((p) => p.type === 'added' && p.text === '新加的这句。'));
  assert.ok(oldParts.some((p) => p.type === 'removed' && p.text === '去掉的这句。'));
  assert.ok(newParts.some((p) => p.type === 'same' && p.text === '留下的。'));
});

test('对比：两边拼回去各自等于原文（顺序不能乱）', () => {
  const a = '第一句。第二句。第三句。';
  const b = '第一句。第二句改。第四句。';
  const { oldParts, newParts } = diffTexts(a, b);
  assert.equal(oldParts.map((p) => p.text).join(''), a);
  assert.equal(newParts.map((p) => p.text).join(''), b);
});

test('统计：新增/去掉/相同的句数对得上', () => {
  const { oldParts, newParts } = diffTexts('甲。乙。', '甲。丙。');
  const stats = diffStats(oldParts, newParts);
  assert.equal(stats.added, 1);
  assert.equal(stats.removed, 1);
  assert.equal(stats.unchanged, 1);
});

test('对比：一头是空的也给出可用结果', () => {
  const { newParts } = diffTexts('', '全新的一句话。第二句。');
  assert.equal(newParts.filter((p) => p.type === 'added').length, 2);
});

// ── 给接口用的一层 ────────────────────────────────────────

test('对比版本：两版一模一样时返回 null，不占地方', () => {
  const tpl = { current: '一模一样。', history: [{ version: 2, content: '一模一样。', saved_at: 'x' }] };
  assert.equal(compareWithVersion(tpl, 2), null);
});

test('对比版本：内容不同才给对比，并带上历史那版的元信息', () => {
  const tpl = {
    current: '新版内容。',
    history: [{ version: 3, content: '旧版内容。', saved_at: '2026-08-26T00:00:00.000Z', level: 'balanced', source_agent: '' }],
  };
  const out = compareWithVersion(tpl, 3);
  assert.ok(out);
  assert.equal(out.version, 3);
  assert.equal(out.level, 'balanced');
  assert.equal(out.stats.added, 1);
  assert.equal(out.stats.removed, 1);
});

test('对比版本：找不到那一版就返回 null，不编', () => {
  const tpl = { current: '新版。', history: [{ version: 2, content: '旧版。' }] };
  assert.equal(compareWithVersion(tpl, 99), null);
  assert.equal(compareWithVersion({ current: 'x', history: [] }, 2), null);
  assert.equal(compareWithVersion(null, 2), null);
  assert.equal(compareWithVersion({ current: '', history: [{ version: 1, content: 'a' }] }, 1), null);
});