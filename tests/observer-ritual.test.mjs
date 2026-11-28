// tests/observer-ritual.test.mjs
// v0.8.1 - 问候短路只在真的像问候时才触发。
//
// 起因（2026-11-28）：一段讨论「早安这个词怎么配图」的技术对话也含「早安」，
// 旧的 detectRitual 照样命中，于是往对话里注入了「你似乎有些开心，配一张」。
// 真问候都很短，一段长消息里的「早安」通常是在说这件事，不是在打招呼。
//
// 这里守两件事：
//   1) 短问候照样命中，并且命中词要带出去（occasion 门禁靠它解锁）
//   2) 长消息里的问候词不命中
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRitual } from '../lib/observer.js';

const userTurn = (text) => [{ role: 'user', content: text }];

test('短问候照样命中，且带回命中的那个词', () => {
  const hit = detectRitual(userTurn('早安呀'));
  assert.ok(hit);
  assert.equal(hit.word, '早安');
});

test('短问候带别的内容也算（真人在打招呼）', () => {
  const hit = detectRitual(userTurn('晚安，今天累死了'));
  assert.ok(hit);
  assert.equal(hit.word, '晚安');
});

test('英文问候走词边界，句子里的 this / while 不算 hi', () => {
  assert.equal(detectRitual(userTurn('this while something')), null);
  assert.ok(detectRitual(userTurn('hi')));
});

test('长消息里的问候词不触发：那是在聊这件事，不是在打招呼', () => {
  const long = '这张，这个也是早安的意思，还有一个欧嗨呦的表情包，这俩图好像没加入到这次改动';
  assert.ok(long.length > 20);
  assert.equal(detectRitual(userTurn(long)), null);
});

test('取最后一条用户消息，助手后来说的话不参与判断', () => {
  const messages = [
    { role: 'user', content: '早安' },
    { role: 'assistant', content: '早呀，今天想干点什么' },
    { role: 'user', content: '帮我把这个表情包的标签改一下' },
  ];
  assert.equal(detectRitual(messages), null);
});