// 批量识图耗时估算
//
// 这条规则的价值全在新用户身上：作者自己几张几张加，看不到「点了之后要等一晚上、
// 中途关掉白花模型钱」。所以大批量起跑前那句提示、进度条上那句「还要多久」，
// 都必须给出可信的耗时——可信的意思是：能用历史实测就用实测，别拿固定数字糊弄人。
//
// 曾经栽在这里一次：账本里的 duration_ms 是整批的墙钟时间，除以完成张数得到的是
// 「已含并发的单张摊薄耗时」。直接拿它当单张耗时、再除一次并发，等于把并发算了两遍——
// 15 张、并发 5、实跑 152 秒的任务，被估成 30 秒，正好差 5 倍。
// 所以这里把历史并发乘回去，得到单张纯耗时，换并发时再用同一个数重算。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { avgMsPerImage, estimateTagTiming, DEFAULT_MS_PER_IMAGE } =
  await import('../lib/batch-timing.js');

test('没有历史任务时退回保守默认', () => {
  assert.deepEqual(avgMsPerImage([]), { msPerImage: DEFAULT_MS_PER_IMAGE, source: 'default' });
  assert.deepEqual(avgMsPerImage(undefined), { msPerImage: DEFAULT_MS_PER_IMAGE, source: 'default' });
  // 只有跑着的任务，还没速度可言
  assert.equal(avgMsPerImage([{ status: 'running', duration_ms: 60000, completed: 0 }]).source, 'default');
  // 有耗时但一张没跑完，均摊没有意义
  assert.equal(avgMsPerImage([{ status: 'completed', duration_ms: 60000, completed: 0 }]).source, 'default');
});

test('用历史实测反推单张纯耗时（把历史并发乘回去）', () => {
  // 15 张、并发 5、跑了 152.2 秒 → 墙钟摊薄 10.1s/张，单张纯耗时 50.7s
  const got = avgMsPerImage([{ status: 'completed', duration_ms: 152200, completed: 15, concurrency: 5 }]);
  assert.equal(got.source, 'history');
  assert.equal(got.msPerImage, Math.round(152200 / 15 * 5));
});

test('历史并发为 1 时不做额外换算', () => {
  const got = avgMsPerImage([{ status: 'completed', duration_ms: 600000, completed: 20, concurrency: 1 }]);
  assert.deepEqual(got, { msPerImage: 30000, source: 'history' });
});

test('多条历史取最近的一条可用', () => {
  const tasks = [
    { status: 'completed', duration_ms: 600000, completed: 10, concurrency: 3 },
    { status: 'completed', duration_ms: 120000, completed: 10, concurrency: 2 }, // 墙钟 12s → 纯 24s
    { status: 'running', duration_ms: 999999, completed: 5, concurrency: 3 },
  ];
  assert.deepEqual(avgMsPerImage(tasks), { msPerImage: 24000, source: 'history' });
});

test('离谱的速度不参与取样', () => {
  // 墙钟摊薄 1 秒/张，快到不像真调了模型
  assert.equal(avgMsPerImage([{ status: 'completed', duration_ms: 10000, completed: 10, concurrency: 1 }]).source, 'default');
  // 慢到像卡死
  assert.equal(avgMsPerImage([{ status: 'completed', duration_ms: 5400000, completed: 3, concurrency: 1 }]).source, 'default');
});

test('并发越大估得越快，但不许把并发算两遍', () => {
  // 单张纯耗时 60s：并发 3 → 20s/张；并发 6 → 10s/张
  const tasks = [{ status: 'completed', duration_ms: 600000, completed: 30, concurrency: 3 }];
  const slow = estimateTagTiming({ tasks, count: 100, concurrency: 3 });
  const fast = estimateTagTiming({ tasks, count: 100, concurrency: 6 });
  assert.equal(slow.msPerImage, 60000);
  assert.equal(slow.msTotal, 100 * 60000 / 3);
  assert.equal(fast.msTotal, 100 * 60000 / 6);
  assert.equal(slow.modelCalls, 100);
});

test('15 张并发 5 实测 152 秒的账，估算应当对得上（不再差 5 倍）', () => {
  const tasks = [{ status: 'completed', duration_ms: 152200, completed: 15, concurrency: 5 }];
  const got = estimateTagTiming({ tasks, count: 15, concurrency: 5 });
  assert.ok(Math.abs(got.msTotal - 152200) < 152200 * 0.2,
    `估算 ${got.msTotal}ms 与实测 152200ms 差太多`);
});

test('没有历史时退回每张 30 秒的保守默认', () => {
  const got = estimateTagTiming({ count: 300, concurrency: 3 });
  assert.equal(got.msPerImage, DEFAULT_MS_PER_IMAGE);
  assert.equal(got.source, 'default');
  assert.equal(got.msTotal, 300 * DEFAULT_MS_PER_IMAGE / 3);
});

test('并发被夹在 1~8，脏输入不炸', () => {
  assert.equal(estimateTagTiming({ count: 10, concurrency: 0 }).concurrency, 5);
  assert.equal(estimateTagTiming({ count: 10, concurrency: 'x' }).concurrency, 5);
  assert.equal(estimateTagTiming({ count: 10, concurrency: 99 }).concurrency, 8);
  assert.equal(estimateTagTiming({ count: 10, concurrency: -3 }).concurrency, 1);
  assert.equal(estimateTagTiming({}).count, 0);
  assert.equal(estimateTagTiming({ count: -5 }).count, 0);
});