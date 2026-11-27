// v0.7.7 - 「这次不应景」的场景负向账：只压当前情绪这一栏，不碰图库全局权重。
// 这几条测的是账本本身，不启动 App、不调模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyContextMisfit,
  readContextMisfits,
  removeContextMisfitEntry,
  removeStickerContextFeedback,
  contextMisfitPenalty,
  getContextMisfitSnapshot,
  readContextFeedback,
  CONTEXT_MISFIT_MAX_COUNT,
} from '../lib/context-feedback.js';
import { prefsScoreBonus } from '../lib/shared.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-misfit-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test('一次「不应景」记 -3，两次封顶 -6，再点不加罚', () => {
  assert.equal(contextMisfitPenalty(1), -3);
  assert.equal(contextMisfitPenalty(2), -6);
  assert.equal(contextMisfitPenalty(9), -6);
  assert.equal(CONTEXT_MISFIT_MAX_COUNT, 2);
});

test('add 落账：同图同情绪累加并封顶，别的情绪不受影响', async (t) => {
  const dataDir = fixture(t);
  const first = await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  assert.equal(first.ok, true);
  assert.equal(first.count, 1);
  assert.equal(first.penalty, -3);

  const second = await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  assert.equal(second.count, 2);
  assert.equal(second.penalty, -6);

  const third = await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  assert.equal(third.count, 2, '封顶后不再增长，避免连点变成出局');

  assert.deepEqual(readContextMisfits({ dataDir, agentId: 'a1', contextEmotion: '释然' }), { stk_1: 2 });
  assert.deepEqual(readContextMisfits({ dataDir, agentId: 'a1', contextEmotion: '得意' }), {});
  assert.deepEqual(readContextMisfits({ dataDir, agentId: 'a2', contextEmotion: '释然' }), {});
});

test('restore 快照可以把这一笔撤回，撤回后账本回到写入前', async (t) => {
  const dataDir = fixture(t);
  await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  const added = await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  assert.equal(added.count, 2);
  assert.equal(added.snapshot.count, 1, '快照记的是写入前的值');

  const restored = await applyContextMisfit({
    dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1',
    action: 'restore', restoreSnapshot: added.snapshot,
  });
  assert.equal(restored.ok, true);
  assert.deepEqual(readContextMisfits({ dataDir, agentId: 'a1', contextEmotion: '释然' }), { stk_1: 1 });
});

test('首笔撤回后不留空桶', async (t) => {
  const dataDir = fixture(t);
  const added = await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  await applyContextMisfit({
    dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1',
    action: 'restore', restoreSnapshot: added.snapshot,
  });
  assert.deepEqual(readContextMisfits({ dataDir, agentId: 'a1', contextEmotion: '释然' }), {});
  // 文件里也不能剩空壳：真实账本里曾留下过 {"hanako":{"服气":{}}} 这种空目录。
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'context-feedback.json'), 'utf8'));
  assert.deepEqual(raw.misfits, {});
});

test('场景负向不写偏好文件：图库权重不该被这一笔改动', async (t) => {
  const dataDir = fixture(t);
  await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  assert.equal(fs.existsSync(path.join(dataDir, 'preferences.json')), false);
});

test('缺情绪时落到「未分场景」桶，不再拒绝（v0.7.8）', async (t) => {
  const dataDir = fixture(t);
  const noEmotion = await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '', stickerId: 'stk_1' });
  assert.equal(noEmotion.ok, true, '没记情绪也要能记上这一笔');
  assert.equal(noEmotion.count, 1);

  // 任何情绪下查账都能看到这一笔（通用桶），两次封顶后对所有情绪都生效
  await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '', stickerId: 'stk_1' });
  assert.deepEqual(readContextMisfits({ dataDir, agentId: 'a1', contextEmotion: '释然' }), { stk_1: 2 });
  assert.deepEqual(readContextMisfits({ dataDir, agentId: 'a1', contextEmotion: '得意' }), { stk_1: 2 });

  const noSticker = await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: '' });
  assert.equal(noSticker.ok, false, '没给图片还是得拒绝');
});

test('当前情绪与通用桶的笔数会合并，仍然封顶两次', async (t) => {
  const dataDir = fixture(t);
  await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '', stickerId: 'stk_1' });
  assert.deepEqual(readContextMisfits({ dataDir, agentId: 'a1', contextEmotion: '释然' }), { stk_1: 2 });
  assert.deepEqual(readContextMisfits({ dataDir, agentId: 'a1', contextEmotion: '得意' }), { stk_1: 1 });
});

test('手动删单条与删图都会回收空桶，账本里不留空目录', async (t) => {
  const dataDir = fixture(t);
  await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  await removeContextMisfitEntry({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  let raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'context-feedback.json'), 'utf8'));
  assert.deepEqual(raw.misfits, {}, '手动删完不留空桶');

  await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_2' });
  await removeStickerContextFeedback({ dataDir, stickerId: 'stk_2' });
  raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'context-feedback.json'), 'utf8'));
  assert.deepEqual(raw.misfits, {}, '删图后也不留空桶');
});

test('快照能读出已有笔数，供卡片记录回填', async (t) => {
  const dataDir = fixture(t);
  await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  const data = readContextFeedback({ dataDir });
  const snapshot = getContextMisfitSnapshot(data, { agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  assert.equal(snapshot.hadEntry, true);
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.contextEmotion, '释然');
});

test('删图时正向应景账和场景负向账一起清', async (t) => {
  const dataDir = fixture(t);
  await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  await removeStickerContextFeedback({ dataDir, stickerId: 'stk_1' });
  assert.deepEqual(readContextMisfits({ dataDir, agentId: 'a1', contextEmotion: '释然' }), {});
});

test('手动删单条：删了就是删了，再查为空', async (t) => {
  const dataDir = fixture(t);
  await applyContextMisfit({ dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1' });
  const removed = await removeContextMisfitEntry({
    dataDir, agentId: 'a1', contextEmotion: '释然', stickerId: 'stk_1',
  });
  assert.equal(removed.removed, true);
  assert.deepEqual(readContextMisfits({ dataDir, agentId: 'a1', contextEmotion: '释然' }), {});
});

test('打分：场景负向只扣本场景，且比整图 dislike 轻', () => {
  const base = prefsScoreBonus('stk_1', {});
  const oneMisfit = prefsScoreBonus('stk_1', { contextMisfits: { stk_1: 1 } });
  const twoMisfit = prefsScoreBonus('stk_1', { contextMisfits: { stk_1: 2 } });
  const oneDislike = prefsScoreBonus('stk_1', { dislikes: { stk_1: 1 } });
  const otherSticker = prefsScoreBonus('stk_1', { contextMisfits: { stk_2: 1 } });

  assert.equal(oneMisfit - base, -3);
  assert.equal(twoMisfit - base, -6);
  assert.equal(oneDislike - base, -5, '整图一次 -5，场景一次 -3，轻一档');
  assert.equal(otherSticker, base, '别的图的场景账不影响这张');
});