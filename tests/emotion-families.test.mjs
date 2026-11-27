// tests/emotion-families.test.mjs
// v0.7.7 - 情绪家族表的守门测试。
// 起因：2026-11-26 实测图库 1973 个标签只有 39 个进了 6 大类表，500 条历史选图里
// 122 条情绪词两边都不占，标签通道长期 0 命中，全靠向量兜底硬配（「不好意思」→「不是哥们」）。
// 这层表的任务是让查询词和图标签说同一种话，所以测试重点在「不许撞车」「覆盖真实词」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMOTION_FAMILIES,
  TERM_FAMILY,
  DUPLICATE_TERMS,
  MOCK_FAMILIES,
  SINCERE_FAMILIES,
  familyOf,
  familyOfLoose,
  familiesOfEmotion,
  termsOfFamilies,
  isMockSticker,
} from '../lib/emotion-families.js';

test('一个词只能归一个家族，不许撞车', () => {
  assert.deepEqual(DUPLICATE_TERMS, [], `有词重复归类: ${DUPLICATE_TERMS.join(', ')}`);
  // 反向索引大小应等于全部词的去重数
  const all = new Set();
  for (const words of Object.values(EMOTION_FAMILIES)) for (const w of words) all.add(w);
  assert.equal(TERM_FAMILY.size, all.size);
});

test('历史里真实出现过的词都找得到家族', () => {
  const expect = {
    不好意思: '歉意',
    跃跃欲试: '兴奋',
    松了口气: '欣慰',
    哭笑不得: '无语',
    谨慎: '谨慎',
    来劲: '兴奋',
    不甘心: '挫败',
    被说服: '鼓励',
    愧疚: '歉意',
    警觉: '谨慎',
    摸鱼: '敷衍',
    嘲讽: '嘲讽',
  };
  for (const [word, family] of Object.entries(expect)) {
    assert.equal(familyOf(word), family, `「${word}」应归「${family}」`);
  }
});

test('长短语按最长命中归族', () => {
  assert.equal(familyOfLoose('被信任的欣慰'), '欣慰');
  assert.equal(familyOfLoose('心疼又无奈'), '难过', '心疼(2字)比无奈(2字)等长时先到者胜，两者都在表内');
  assert.equal(familyOfLoose('开心,搞笑'), '开心', '不拆词时按子串命中「开心」');
  assert.equal(familyOf('一个不存在的怪词'), '');
  assert.equal(familyOfLoose('宠洿'), '');
});

test('familiesOfEmotion 收单串、数组和逗号串', () => {
  assert.deepEqual(familiesOfEmotion('不好意思'), ['歉意']);
  assert.deepEqual(familiesOfEmotion('开心,搞笑').sort(), ['开心'], '「搞笑」不在家族表里，只认开心');
  assert.deepEqual(familiesOfEmotion(['谨慎', '期待']).sort(), ['谨慎', '期待'].sort());
  assert.deepEqual(familiesOfEmotion(''), []);
});

test('termsOfFamilies 展开成词集，供向量兜底按同类准入', () => {
  const terms = termsOfFamilies(['歉意']);
  assert.ok(terms.has('不好意思'));
  assert.ok(terms.has('道歉'));
  assert.ok(!terms.has('嘲讽'));
});

test('诚恳类和嘲讽类不重叠', () => {
  for (const f of SINCERE_FAMILIES) {
    assert.ok(!MOCK_FAMILIES.has(f), `「${f}」不能同时是诚恳类和嘲讽类`);
  }
});

test('isMockSticker：标了嘲讽的算，普通图不算', () => {
  const mock = {
    id: 'stk_631',
    description: '古装少女操作电脑侧眼无奈吐槽不是哥们',
    tags: { emotion: ['无奈', '困惑', '吐槽'] },
  };
  assert.equal(isMockSticker(mock), true, '描述里写着「不是哥们」的该判为怼人气质');

  const mocked = { id: 'x', description: '斜眼一脸嫌弃', tags: { emotion: ['嘲讽', '不屑'] } };
  assert.equal(isMockSticker(mocked), true);

  const sincere = { id: 'stk_442', description: '猫咪少女捂住嘴巴害羞脸红', tags: { emotion: ['害羞', '娇羞', '心动'] } };
  assert.equal(isMockSticker(sincere), false);

  // 没标签也没描述：不冤枉
  assert.equal(isMockSticker({ id: 'y', tags: { emotion: [] } }), false);
  assert.equal(isMockSticker(null), false);
});