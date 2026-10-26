// Code 窗口总开关：配置归一化 + 拦截判定的单元测试
//
// 这个开关的两层含义必须一起守住：
//   1. 配置层：code_enabled 默认 true（老配置行为不变），显式 false 时保留；
//   2. 拦截层：只有在 Code 页且开关是 false 时才拦，聊天页绝不能被顺带关掉。

import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeAgentFreqConfig, isCodeWindowEnabled } = await import('../lib/shared.js');
const { isCodeWindowBlocked } = await import('../lib/session-kind.js');

test('老配置没有 code_enabled 时默认开着', () => {
  const cfg = normalizeAgentFreqConfig({ agents: {} });
  assert.equal(cfg.code_enabled, true);
  assert.equal(isCodeWindowEnabled(cfg), true);
});

test('code_enabled=false 会被保留，不会被归一化吃掉', () => {
  const cfg = normalizeAgentFreqConfig({ code_enabled: false, agents: {} });
  assert.equal(cfg.code_enabled, false);
  assert.equal(isCodeWindowEnabled(cfg), false);
});

test('只认严格的 false，别的值都当开着', () => {
  assert.equal(normalizeAgentFreqConfig({ code_enabled: 0 }).code_enabled, true);
  assert.equal(normalizeAgentFreqConfig({ code_enabled: 'false' }).code_enabled, true);
});

test('频率两档在归一化后仍然各自保留', () => {
  const cfg = normalizeAgentFreqConfig({ code_enabled: false, agents: { hanako: { daily: 90, task: 0 } } });
  assert.equal(cfg.agents.hanako.daily, 90);
  assert.equal(cfg.agents.hanako.task, 0);
});

test('Code 页 + 总开关关 = 拦；聊天页一律不拦', () => {
  assert.equal(isCodeWindowBlocked(false, true), true);
  assert.equal(isCodeWindowBlocked(false, false), false);
  assert.equal(isCodeWindowBlocked(true, true), false);
  assert.equal(isCodeWindowBlocked(true, false), false);
});

test('开关状态拿不到时不拦（宁可少拦一次，也不误杀聊天窗口）', () => {
  assert.equal(isCodeWindowBlocked(undefined, true), false);
});
