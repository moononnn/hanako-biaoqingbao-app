// 批量识图暂停/继续
//
// 暂停和取消是两件不同的事，容易混：
//   取消 = 终态，队列作废，用户不打算要了；
//   暂停 = 可逆，pending 原封不动留着，下次接着跑。
// 所以「能不能暂停」「能不能继续」的判定必须是死的、不能看心情的，
// 否则会出现「点了暂停但点继续说没东西可跑」这种卡死。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { canPauseTask, canResumeTask, selectUntaggedForBatch } =
  await import('../server/_batch-tasks.js');

const running = (over = {}) => ({
  id: 'batch-1', status: 'running', total: 100,
  pending: ['a', 'b', 'c'], current_ids: [], completed: ['z'], ...over,
});
const paused = (over = {}) => ({ ...running(), status: 'paused', ...over });

test('只有 running 才能暂停', () => {
  assert.equal(canPauseTask(running()).ok, true);
  assert.equal(canPauseTask(paused()).ok, false);
  assert.equal(canPauseTask({ status: 'completed' }).ok, false);
  assert.equal(canPauseTask({ status: 'cancelled' }).ok, false);
  assert.equal(canPauseTask(null).ok, false);
});

test('队列空了就别暂停了，免得暂停出一个空任务', () => {
  const done = running({ pending: [], current_ids: [] });
  const res = canPauseTask(done);
  assert.equal(res.ok, false);
  assert.match(res.error, /跑完/);
});

test('手上有图在跑的也算还有活，可以暂停', () => {
  const inflight = running({ pending: ['a'], current_ids: ['b', 'c'] });
  assert.equal(canPauseTask(inflight).ok, true);
});

test('只有 paused 才能继续，且必须还剩图', () => {
  assert.equal(canResumeTask(paused()).ok, true);
  assert.equal(canResumeTask(running()).ok, false);
  assert.equal(canResumeTask({ status: 'completed' }).ok, false);
  assert.equal(canResumeTask(null).ok, false);
  // 最要命的一种：暂停后队列空了却还让用户点继续
  const empty = paused({ pending: [] });
  const res = canResumeTask(empty);
  assert.equal(res.ok, false);
  assert.match(res.error, /待识别/);
});

test('暂停中的任务挡着新任务：避免同一批图被重复识别', () => {
  const meta = [
    { id: 'stk_1', tagged_at: '2026-10-01T00:00:00.000Z' },
    { id: 'stk_2' },
  ];
  assert.equal(selectUntaggedForBatch(meta, [paused()]).ok, false);
  assert.equal(selectUntaggedForBatch(meta, [running()]).ok, false);
  // 取消过的不挡
  assert.equal(selectUntaggedForBatch(meta, [{ status: 'cancelled' }]).ok, true);
});