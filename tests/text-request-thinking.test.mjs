// tests/text-request-thinking.test.mjs
//
// 思考开关的请求体形状。这块之前只对 DeepSeek 发 thinking，
// MiniMax 一直在默认开着思考，短任务里思考吃掉预算就只剩空正文。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

process.env.BQB_DATA_DIR = path.join(os.tmpdir(), `bqb-text-thinking-${process.pid}`);

const { buildTextRequest } = await import('../lib/text-model.js');

const baseModel = {
  api: 'openai-completions',
  baseUrl: 'https://example.test/v1',
  apiKey: 'sk-test',
  reasoning: true,
};

const messages = [{ role: 'user', content: '你好' }];

test('MiniMax 模型：发 thinking disabled，不发 reasoning_effort', () => {
  const { body } = buildTextRequest({ ...baseModel, providerId: 'minimax', modelId: 'MiniMax-M3.1-Flash-Preview' }, messages, {
    maxTokens: 1500,
    reasoningEffort: 'low',
  });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in body, false);
});

test('DeepSeek 模型：thinking 与 reasoning_effort 都照旧', () => {
  const { body } = buildTextRequest({ ...baseModel, providerId: 'deepseek', modelId: 'deepseek-v4.1-flash' }, messages, {
    maxTokens: 1500,
    reasoningEffort: 'low',
  });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, 'low');
});

test('其他供应商：不塞私有字段', () => {
  const { body } = buildTextRequest({ ...baseModel, providerId: 'openai', modelId: 'gpt-6-luna' }, messages, {
    maxTokens: 1500,
    reasoningEffort: 'low',
  });
  assert.equal('thinking' in body, false);
  assert.equal('reasoning_effort' in body, false);
});

test('模型未标记 reasoning 时不发 thinking', () => {
  const { body } = buildTextRequest({ ...baseModel, reasoning: false, providerId: 'minimax', modelId: 'MiniMax-M3.1-Flash-Preview' }, messages, {});
  assert.equal('thinking' in body, false);
});
