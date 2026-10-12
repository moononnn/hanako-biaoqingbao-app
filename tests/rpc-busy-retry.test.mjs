import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { isRpcBusyError, withRpcBusyRetry } from '../lib/rpc-retry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUSY_TEXT = 'App RPC concurrency limit reached';
const noSleep = () => Promise.resolve();

test('能认出宿主 RPC 并发上限的各种形态', () => {
  assert.equal(isRpcBusyError('App RPC concurrency limit reached'), true);
  assert.equal(isRpcBusyError(new Error(BUSY_TEXT)), true);
  assert.equal(isRpcBusyError({ code: 'APP_RPC_BUSY' }), true);
  assert.equal(isRpcBusyError({ code: 'APP_MODEL_PROVIDER_ERROR', message: 'boom' }), false);
  assert.equal(isRpcBusyError('模型返回 HTTP 401'), false);
  assert.equal(isRpcBusyError(null), false);
  assert.equal(isRpcBusyError(undefined), false);
});

test('抛出来的 busy 错误会退避重试，并在成功后返回结果', async () => {
  const delays = [];
  let calls = 0;
  const value = await withRpcBusyRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error(BUSY_TEXT);
      return 'ok';
    },
    { sleep: async (ms) => { delays.push(ms); }, baseDelayMs: 400 },
  );

  assert.equal(value, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [400, 800]); // 线性退避，不无限加
});

test('重试用尽后原样抛回，不吞错也不换模型', async () => {
  let calls = 0;
  await assert.rejects(
    withRpcBusyRetry(
      async () => { calls += 1; throw new Error(BUSY_TEXT); },
      { retries: 2, sleep: noSleep },
    ),
    /concurrency limit/,
  );
  assert.equal(calls, 3); // 首次 + 2 次重试
});

test('tagImage 那种包成 { ok:false } 的 busy 也会重试，且用尽后保持原形状', async () => {
  let calls = 0;
  const value = await withRpcBusyRetry(
    async () => {
      calls += 1;
      return { ok: false, error: BUSY_TEXT };
    },
    { retries: 2, sleep: noSleep },
  );

  assert.equal(calls, 3);
  assert.deepEqual(value, { ok: false, error: BUSY_TEXT }); // 真实原因不丢，调用方照常记 failed
});

test('非 busy 错误一次都不重试', async () => {
  let calls = 0;
  const value = await withRpcBusyRetry(
    async () => { calls += 1; return { ok: false, error: 'thinking 模型未输出 JSON' }; },
    { sleep: noSleep },
  );

  assert.equal(calls, 1);
  assert.equal(value.error, 'thinking 模型未输出 JSON');
});

test('批量进度事件接住了 Promise 拒绝，不留 unhandled rejection', () => {
  const src = fs.readFileSync(path.join(here, '..', 'server', '_batch-tasks.js'), 'utf-8');
  const emitBus = src.slice(src.indexOf('function emitBus'), src.indexOf('// ═══ API 注册'));

  // 判据一：emit 的返回值被接住，不再是裸调用
  assert.match(emitBus, /pending\s*=\s*moduleCtx\?\.bus\?\.emit\?\.\(topic,\s*data\)/);
  assert.match(emitBus, /pending\.catch\(/);
  // 判据二：进度事件不重试，避免同一张图重复推、界面进度多算
  assert.doesNotMatch(emitBus, /withRpcBusyRetry/);
  // 判据三：识图调用才走退避重试
  assert.match(src, /withRpcBusyRetry\(\s*\(\)\s*=>\s*tagImage\(/);
});