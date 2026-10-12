import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-vision-host-test-'));
process.env.BQB_DATA_DIR = dataDir;

const { tagImage, writeVisionConfig } = await import('../lib/shared.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const imageBase64 = Buffer.from('test image bytes').toString('base64');
const tags = JSON.stringify({
  description: '测试图片',
  semantic_description: '用于测试识图模型路由',
  emotion: ['测试'],
  scene: ['测试'],
  keywords: ['测试图片'],
  atmosphere: ['测试'],
});

function fakeHost(body = tags) {
  const captured = { calls: 0, payload: null };
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

test('Hana 视觉模型：有宿主通道和模型选择时，不要求读取 provider API 凭据', async () => {
  writeVisionConfig({ source: 'hana', providerId: 'test-provider', modelId: 'test-vision-model' });
  const { ctx, captured } = fakeHost();

  const result = await tagImage(imageBase64, 'test.png', { ctx });

  assert.equal(result.ok, true, result.error);
  assert.equal(captured.calls, 1);
  assert.equal(captured.payload.provider, 'test-provider');
  assert.equal(captured.payload.model, 'test-vision-model');
  assert.ok(captured.payload.messages[0].content.some((item) => item.type === 'image' && item.data === imageBase64));
});

test('Hana 视觉模型：没有宿主通道且没有 API 凭据时仍明确提示未配置', async () => {
  writeVisionConfig({ source: 'hana', providerId: 'test-provider', modelId: 'test-vision-model' });

  const result = await tagImage(imageBase64, 'test.png');

  assert.equal(result.ok, false);
  assert.equal(result.error, '未配置视觉模型，请先在设置里选择或填写模型');
});

test('思考型视觉模型的输出预算不得再被思考吃光（2026-10-12 实测 2500 不够）', async () => {
  writeVisionConfig({ source: 'hana', providerId: 'test-provider', modelId: 'test-thinking-model' });
  const { ctx, captured } = fakeHost();

  const result = await tagImage(imageBase64, 'test.png', { ctx });

  assert.equal(result.ok, true, result.error);
  assert.equal(captured.payload.maxTokens, 12000);
});

test('自定义视觉 API：即使宿主通道可用，也必须走用户填写的 API', async () => {
  writeVisionConfig({
    source: 'custom',
    providerId: 'stale-provider',
    modelId: 'stale-model',
    customBaseUrl: 'https://vision.example.test/v1',
    customApiKey: 'custom-secret',
    customModel: 'custom-vision-model',
  });
  const { ctx, captured } = fakeHost();
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: tags } }] }),
    };
  };

  try {
    const result = await tagImage(imageBase64, 'test.png', { ctx });
    assert.equal(result.ok, true, result.error);
    assert.equal(captured.calls, 0);
    assert.equal(request.url, 'https://vision.example.test/v1/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer custom-secret');
    assert.equal(JSON.parse(request.options.body).model, 'custom-vision-model');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
