// tests/text-model-host.test.mjs
//
// 覆盖宿主模型通道的一处适配：系统提示必须单独走 systemPrompt。
// 背景：把模型通道换成宿主托管时漏了这一步，system 混在消息数组里会被
// 宿主整份拒掉（"Each message must be a user, assistant, or toolResult message."），
// 配图观察器第一次实机就撞在这上面。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

process.env.BQB_DATA_DIR = path.join(os.tmpdir(), `bqb-textmodel-test-${process.pid}`);

const { callConfiguredTextModel } = await import('../lib/text-model.js');

/** 造一个假的宿主 ctx：把收到的 payload 记下来，回一段 NDJSON。 */
function fakeHost(body = '收到') {
  const captured = { payload: null, calls: 0 };
  const ctx = {
    models: {
      stream: async (payload) => {
        captured.calls += 1;
        captured.payload = payload;
        return [
          JSON.stringify({ type: 'text-delta', delta: body }),
          JSON.stringify({ type: 'done', assistant: { content: [{ type: 'text', text: body }] } }),
        ].join('\n');
      },
    },
  };
  return { ctx, captured };
}

const cfg = { source: 'hana', providerId: 'deepseek', modelId: 'deepseek-flash' };

test('宿主通道：system 抽到 systemPrompt，消息数组里不留 system', async () => {
  const { ctx, captured } = fakeHost();
  const result = await callConfiguredTextModel(ctx, cfg, [
    { role: 'system', content: '只返回 JSON' },
    { role: 'user', content: '最近的对话：……' },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.via, 'host');
  assert.equal(captured.calls, 1);
  assert.equal(captured.payload.systemPrompt, '只返回 JSON');
  assert.deepEqual(captured.payload.messages, [{ role: 'user', content: '最近的对话：……' }]);
  assert.ok(!captured.payload.messages.some((m) => m.role === 'system'));
});

test('宿主通道：多条 system 合并成一段', async () => {
  const { ctx, captured } = fakeHost();
  await callConfiguredTextModel(ctx, cfg, [
    { role: 'system', content: '第一条' },
    { role: 'system', content: '第二条' },
    { role: 'user', content: '问题' },
  ]);
  assert.equal(captured.payload.systemPrompt, '第一条\n\n第二条');
  assert.equal(captured.payload.messages.length, 1);
});

test('宿主通道：没有 system 时 systemPrompt 不带内容', async () => {
  const { ctx, captured } = fakeHost();
  await callConfiguredTextModel(ctx, cfg, [{ role: 'user', content: '只有用户消息' }]);
  assert.ok(!captured.payload.systemPrompt);
  assert.deepEqual(captured.payload.messages, [{ role: 'user', content: '只有用户消息' }]);
});

test('宿主通道：非标准角色一律归一到 user，不把脏角色传给宿主', async () => {
  const { ctx, captured } = fakeHost();
  await callConfiguredTextModel(ctx, cfg, [
    { role: 'custom', content: '自定义' },
    { role: 'user', content: '正常' },
  ]);
  assert.deepEqual(captured.payload.messages, [
    { role: 'user', content: '自定义' },
    { role: 'user', content: '正常' },
  ]);
});

test('宿主通道：assistant 角色保留', async () => {
  const { ctx, captured } = fakeHost();
  await callConfiguredTextModel(ctx, cfg, [
    { role: 'user', content: '问' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '再问' },
  ]);
  assert.deepEqual(captured.payload.messages.map((m) => m.role), ['user', 'assistant', 'user']);
});

test('宿主通道：拿到正文时 ok=true 且带回 via', async () => {
  const { ctx } = fakeHost('{"has_emotion":true}');
  const result = await callConfiguredTextModel(ctx, cfg, [{ role: 'user', content: 'x' }]);
  assert.equal(result.ok, true);
  assert.equal(result.data, '{"has_emotion":true}');
  assert.equal(result.via, 'host');
});

test('宿主通道：空正文报空响应，不冒充成功', async () => {
  const { ctx } = fakeHost('');
  const result = await callConfiguredTextModel(ctx, cfg, [{ role: 'user', content: 'x' }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LLM_EMPTY_RESPONSE');
});

test('宿主通道：没选模型时直接拒绝，不发请求', async () => {
  const { ctx, captured } = fakeHost();
  const result = await callConfiguredTextModel(ctx, { source: 'hana' }, [{ role: 'user', content: 'x' }]);
  assert.equal(result.ok, false);
  assert.equal(captured.calls, 0);
});

test('自定义 API 不走宿主通道（用户自己填的凭据仍走自己的路）', async () => {
  const { ctx, captured } = fakeHost();
  // 缺 customBaseUrl 等，会走自定义分支并因缺配置报错；关键是没碰宿主通道
  const result = await callConfiguredTextModel(ctx, { source: 'custom' }, [{ role: 'user', content: 'x' }]);
  assert.equal(captured.calls, 0);
  assert.equal(result.ok, false);
});
