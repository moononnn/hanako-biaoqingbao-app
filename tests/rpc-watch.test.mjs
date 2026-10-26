// App 侧 RPC 在飞计数
//
// 对应 2026-10-26 那次通道报忙：光有一句 APP_RPC_BUSY 不够，
// 得知道当时在飞多少条、最老一条等了多久、哪几种方法占着。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpcWatch, describeRpcBusy } from '../lib/rpc-watch.js';

const busyError = () => Object.assign(new Error('App RPC concurrency limit reached'), { code: 'APP_RPC_BUSY' });

test('包一层之后返回值原样透出，计数归零', async () => {
  const watch = createRpcWatch();
  const request = watch.wrap(async (method) => ({ ok: method }));
  const before = watch.snapshot();
  assert.equal(before.inflight, 0);
  assert.deepEqual(await request('session:get', {}), { ok: 'session:get' });
  assert.equal(watch.snapshot().inflight, 0);
  assert.equal(watch.snapshot().total, 1);
});

test('异常原样抛出，槽也照常放掉', async () => {
  const watch = createRpcWatch();
  const request = watch.wrap(async () => { throw new Error('boom'); });
  await assert.rejects(() => request('models.infer'), /boom/);
  assert.equal(watch.snapshot().inflight, 0);
  assert.equal(watch.snapshot().busy, 0);
});

test('撞上限时记下现场：方法名、在飞数、峰值、最老等待', async () => {
  let now = 0;
  const watch = createRpcWatch({ now: () => now });
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const request = watch.wrap(async (method) => {
    if (method === 'models.infer') throw busyError();
    return held;
  });
  const p1 = request('storage:get');
  const p2 = request('session:list');
  now = 5000;
  await assert.rejects(() => request('models.infer'));
  const snap = watch.snapshot();
  assert.equal(snap.busy, 1);
  const last = watch.lastBusy();
  assert.equal(last.method, 'models.infer');
  // 两条在飞 + 自己这一条，都还没落地
  assert.ok(last.inflight >= 3);
  assert.ok(last.oldestMs >= 5000);
  release('ok');
  await Promise.all([p1, p2]);
  assert.equal(watch.snapshot().inflight, 0);
});

test('按方法分组只取前四名', async () => {
  const watch = createRpcWatch();
  const hold = [];
  const request = watch.wrap((method) => new Promise((resolve) => { hold.push(resolve); }));
  request('session:get');
  request('session:get');
  request('models.infer');
  request('storage:get');
  request('storage:set');
  request('events.emit');
  const snap = watch.snapshot();
  assert.equal(snap.inflight, 6);
  assert.match(snap.top, /session:getx2/);
  assert.equal(snap.top.split(',').length, 4);
  hold.forEach((resolve) => resolve(null));
});

test('人话那一行带得上关键数字', () => {
  const line = describeRpcBusy({
    method: 'models.infer', inflight: 128, peak: 131, oldestMs: 28400, p50Ms: 9100, top: 'models.inferx96,session:getx30',
  });
  assert.match(line, /method=models\.infer/);
  assert.match(line, /inflight=128/);
  assert.match(line, /oldest=28\.4s/);
  assert.match(line, /p50=9\.1s/);
  assert.match(line, /models\.inferx96/);
  assert.match(describeRpcBusy(null), /无现场/);
});
