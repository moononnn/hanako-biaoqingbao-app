// tests/sticker-gate.test.mjs
//
// 配图准入的统一判定：Code 总闸、伙伴自己的 Code 档、窗口判不出来时的取向。
// 起因：2026-10-25 实测 Code 总闸关着，模型调 express 仍发出去了一张图。
// 这里把「该拒的都拒、不该拒的别误杀」逐条钉住。

import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeAgentFreqConfig } = await import('../lib/shared.js');
const { decideStickerAccess, skippedToolResult } = await import('../lib/sticker-gate.js');

const cfg = (patch = {}) => normalizeAgentFreqConfig({
  agents: {
    hanako: { enabled: true, daily: 90, task: 0 },
    other: { enabled: true, daily: 50, task: 20 },
  },
  ...patch,
});

test('Code 窗口 + 总闸关：拒，理由是 code_window_off', () => {  const d = decideStickerAccess({ namespace: 'code', agentId: 'other', config: cfg({ code_enabled: false }) });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'code_window_off');
  assert.equal(d.window, 'code');
});

test('Code 窗口 + 总闸开 + 伙伴 task=0：拒，理由是 code_freq_zero', () => {
  const d = decideStickerAccess({ namespace: 'code', agentId: 'hanako', config: cfg({ code_enabled: true }) });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'code_freq_zero');
});

test('Code 窗口 + 总闸开 + 伙伴 task>0：放行', () => {
  const d = decideStickerAccess({ namespace: 'code', agentId: 'other', config: cfg({ code_enabled: true }) });
  assert.equal(d.allowed, true);
  assert.equal(d.freq, 20);
});

test('聊天窗口不吃 Code 那套：task=0 的人在聊天页照常放行', () => {
  const d = decideStickerAccess({ namespace: 'home', agentId: 'hanako', config: cfg({ code_enabled: false }) });
  assert.equal(d.allowed, true);
  assert.equal(d.window, 'chat');
  assert.equal(d.freq, 90);
});

test('伙伴自己关了配图：拒', () => {
  const d = decideStickerAccess({
    namespace: 'home',
    agentId: 'hanako',
    config: cfg({ agents: { hanako: { enabled: false, daily: 90, task: 0 } } }),
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'agent_off');
});

test('全局总闸关：哪个窗口都拒', () => {
  const d = decideStickerAccess({ namespace: 'home', agentId: 'other', config: cfg({ global_enabled: false }) });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'global_off');
});

test('窗口判不出来 + Code 总闸关：从严，拒', () => {
  const d = decideStickerAccess({ namespace: '', agentId: 'hanako', config: cfg({ code_enabled: false }) });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'window_unknown');
});

test('窗口判不出来 + Code 总闸开：按聊天页放行，别误杀', () => {
  const d = decideStickerAccess({ namespace: '', agentId: 'other', config: cfg({ code_enabled: true }) });
  assert.equal(d.allowed, true);
  assert.equal(d.window, 'chat');
});

test('窗口判不出来 + 聊天档也是 0：拒', () => {
  const d = decideStickerAccess({
    namespace: '',
    agentId: 'hanako',
    config: cfg({ code_enabled: true, agents: { hanako: { enabled: true, daily: 0, task: 0 } } }),
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'freq_zero');
});

test('没配过的伙伴退回默认档，不当作关闭', () => {
  const d = decideStickerAccess({ namespace: 'home', agentId: 'nobody', config: cfg({ code_enabled: false }) });
  assert.equal(d.allowed, true);
  assert.equal(d.freq, 50);
});

test('拒绝结果包成 ok:true + skipped，模型不会当成失败重试', () => {
  const result = skippedToolResult({ reason: 'code_freq_zero', text: '这里不碰表情包。' });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.action, 'skipped');
  assert.equal(payload.data.reason, 'code_freq_zero');
  assert.match(payload.data.message, /不用再试/);
});

test('子代理会话一律不配图，总闸开着也一样', () => {
  const d = decideStickerAccess({
    namespace: 'home',
    agentId: 'hanako',
    config: cfg({ code_enabled: true }),
    sessionPath: 'C:/app-home/.hanako/agents/hanako/subagent-sessions/direct/2026-10-26T00-00-00Z_abc.jsonl',
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'subagent');
});

test('子代理会话的判定看路径，不看 namespace 能不能查到', () => {
  // 2026-10-26 实机：子代理会话的 session:get 全部查不到，namespace 是空的。
  const d = decideStickerAccess({
    namespace: '',
    agentId: 'nobody',
    config: cfg({ code_enabled: false }),
    sessionPath: 'D:\\app-home\\.hanako\\agents\\hanako\\subagent-sessions\\direct\\a.jsonl',
  });
  assert.equal(d.reason, 'subagent');
});

test('主会话路径不是子代理，该发还是发', () => {
  const d = decideStickerAccess({
    namespace: 'home',
    agentId: 'hanako',
    config: cfg({ code_enabled: false }),
    sessionPath: 'C:/app-home/.hanako/agents/hanako/sessions/2026-10-26T00-00-00Z_abc.jsonl',
  });
  assert.equal(d.allowed, true);
});
