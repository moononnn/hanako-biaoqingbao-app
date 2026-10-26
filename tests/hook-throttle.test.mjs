// 钩子节流：在飞去重 + 撞上限后的退避
//
// 对应 2026-10-26 那次宿主 RPC 槽满（一小时 1150 条 adjudicator threw）。
// 这两个都是纯函数，不碰网络、不读配置，守的是“同一批工作不重复排队”。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInflightGuard, createBusyBackoff } from '../lib/hook-throttle.js';

test('同一会话在飞时，第二次进去拿不到锁', () => {
  const guard = createInflightGuard();
  const release = guard.enter('sess_a');
  assert.equal(typeof release, 'function');
  assert.equal(guard.enter('sess_a'), null);
  assert.equal(guard.size(), 1);
});

test('不同会话各走各的，互不挡', () => {
  const guard = createInflightGuard();
  guard.enter('sess_a');
  const releaseB = guard.enter('sess_b');
  assert.equal(typeof releaseB, 'function');
  assert.equal(guard.size(), 2);
});

test('释放之后同一个会话能再进，重复释放不会把别人的锁删掉', () => {
  const guard = createInflightGuard();
  const release = guard.enter('sess_a');
  release();
  release();
  assert.equal(guard.size(), 0);
  const again = guard.enter('sess_a');
  assert.equal(typeof again, 'function');
  // 别人的锁还在
  guard.enter('sess_b');
  release();
  assert.equal(guard.has('sess_b'), true);
});

test('没有会话标识时放行，不记锁', () => {
  const guard = createInflightGuard();
  const release = guard.enter('');
  assert.equal(typeof release, 'function');
  assert.equal(guard.size(), 0);
});

test('撞一次上限就退避，窗口内一律挡，过点自动放行', () => {
  let now = 1000;
  const backoff = createBusyBackoff({ windowMs: 20000, now: () => now });
  assert.equal(backoff.blocked(), false);
  backoff.trip();
  assert.equal(backoff.blocked(), true);
  assert.equal(backoff.remainingMs(), 20000);
  now += 19999;
  assert.equal(backoff.blocked(), true);
  now += 1;
  assert.equal(backoff.blocked(), false);
  assert.equal(backoff.remainingMs(), 0);
});

test('退避窗口内再撞一次会顺延，但不会把已过的时间拉回来', () => {
  let now = 0;
  const backoff = createBusyBackoff({ windowMs: 10000, now: () => now });
  backoff.trip();
  now = 5000;
  backoff.trip();
  // 撞的时候还是满额重算，不因为前面已经过一半就打折
  assert.equal(backoff.remainingMs(), 10000);
  now = 12000;
  assert.equal(backoff.blocked(), true);
  now = 15000;
  assert.equal(backoff.blocked(), false);
});
