// tests/host-context.test.mjs
//
// App 沙箱里有两样东西拿不到：宿主的模型通道、宿主的网络出口。
// 这两处都属于「同一份代码在插件环境和 App 环境走不同分支」，搬迁时最容易漏传。
// v0.1.10 漏了模型通道的 system 抽取，v0.1.11 漏了两处宿主上下文传递，
// 这个文件把两类都钉住。
//
//   1. 分析调用的总预算：pre-step 钩子有宿主硬超时，观察器必须自己先收手
//   2. Jev 旁路必须把 ctx 传下去，否则回退全局 fetch，在 App 里必挂

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';

const dataDir = path.join(os.tmpdir(), `bqb-hostctx-test-${process.pid}`);
mkdirSync(dataDir, { recursive: true });
process.env.BQB_DATA_DIR = dataDir;
// 配置文件要在 import 之前落盘：lib 层会在模块加载时就把路径定下来
writeFileSync(
  path.join(dataDir, 'text-config.json'),
  JSON.stringify({ enabled: true, source: 'hana', providerId: 'deepseek', modelId: 'deepseek-flash' }),
);

const { analyzeConversation } = await import('../lib/text-analysis.js');
const { runJevShadow } = await import('../lib/jev-shadow.js');
const { readTextConfig, DATA_DIR } = await import('../lib/shared.js');

// ── 分析调用的总预算 ──────────────────────────────────────

test('总预算：第一次就吃掉预算时，不再起第二次', async () => {
  assert.equal(DATA_DIR, dataDir, '数据目录必须是临时目录，不能落到真实 app-data 上');
  assert.equal(readTextConfig().providerId, 'deepseek', '配置要读得到，否则根本走不到调模型那一步');
  let calls = 0;
  const ctx = {
    models: {
      stream: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 800));
        return ''; // 空正文本来是「可重试」的错误
      },
    },
  };
  const result = await analyzeConversation({
    ctx,
    messages: [{ role: 'user', content: '考核一下' }],
    totalBudgetMs: 1000, // 第一次吃掉 800ms，剩余 200ms 不足以再赌一次
  });
  assert.equal(calls, 1, '预算见底时不该再发第二次');
  assert.equal(result.ok, false);
});

test('总预算：不传预算时保持原来的重试行为（空正文重试一次）', async () => {
  let calls = 0;
  const ctx = {
    models: {
      stream: async () => {
        calls += 1;
        return '';
      },
    },
  };
  await analyzeConversation({ ctx, messages: [{ role: 'user', content: '考核一下' }] });
  assert.equal(calls, 2, '路由层的手动测试仍是原来的一共两次');
});

test('总预算：预算充裕时该重试还是重试', async () => {
  let calls = 0;
  const ctx = {
    models: {
      stream: async () => {
        calls += 1;
        return '';
      },
    },
  };
  await analyzeConversation({
    ctx,
    messages: [{ role: 'user', content: '考核一下' }],
    totalBudgetMs: 20000,
  });
  assert.equal(calls, 2);
});

test('总预算：拿到正文时一次就收工', async () => {
  let calls = 0;
  const ctx = {
    models: {
      stream: async () => {
        calls += 1;
        return [JSON.stringify({ type: 'text-delta', delta: '{"has_emotion":false}' })].join('\n');
      },
    },
  };
  const result = await analyzeConversation({
    ctx,
    messages: [{ role: 'user', content: '考核一下' }],
    totalBudgetMs: 20000,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { has_emotion: false });
});

// ── Jev 旁路的宿主网络出口 ────────────────────────────────

writeFileSync(
  path.join(dataDir, 'jev-config.json'),
  JSON.stringify({
    enabled: true,
    shadowEnabled: true,
    apiKey: 'test-key',
    baseUrl: 'https://api.typesafe.ai',
    model: 'jev-latest',
    shadowMaxCalls: 999,
  }),
);

test('Jev 旁路：走传入的宿主网络出口，而不是全局 fetch', async () => {
  const seen = [];
  const ctx = {
    network: {
      fetch: async (url) => {
        seen.push(String(url));
        return { ok: true, status: 200, text: async () => JSON.stringify({ answers: {} }) };
      },
    },
  };
  const result = await runJevShadow({
    state: '用户：在吗\n助手：在的',
    actual: { decision: 'injected', has_emotion: true, emotion: '开心' },
    agentId: 'hanako',
    sessionId: 'sess-x',
    positive: true,
    ctx,
  });
  assert.equal(seen.length, 1, '必须走宿主出口发出去一次');
  assert.match(seen[0], /api\.typesafe\.ai/);
  assert.equal(result.ok, true);
});

test('Jev 旁路：配置不全时直接跳过，不发请求', async () => {
  const backup = JSON.parse(
    (await import('node:fs')).readFileSync(path.join(dataDir, 'jev-config.json'), 'utf8'),
  );
  writeFileSync(
    path.join(dataDir, 'jev-config.json'),
    JSON.stringify({ ...backup, enabled: false }),
  );
  const seen = [];
  const result = await runJevShadow({
    state: 'x',
    actual: {},
    ctx: { network: { fetch: async (url) => { seen.push(String(url)); return { ok: true, status: 200, text: async () => '{}' }; } } },
  });
  assert.equal(result.skipped, true);
  assert.equal(seen.length, 0);
  writeFileSync(path.join(dataDir, 'jev-config.json'), JSON.stringify(backup));
});
