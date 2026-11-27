// 场景正反馈账本：记录“这次很应景”，不污染全局图片偏好。
// 负向场景修订仍走“和小花聊一聊”现有链路，当前模块只处理正向适配信号。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson } from './shared.js';

export const CONTEXT_FEEDBACK_FILE_NAME = 'context-feedback.json';
export const CONTEXT_FEEDBACK_VERSION = 1;
export const CONTEXT_FIT_MAX_COUNT = 3;
// v0.7.7 - 场景负向：用户点「这次不应景」，只压这个场景下的这张图，不动图库全局权重。
// 量级比整图「不喜欢」轻一档（整图 -5 起、五次出局；场景 -3、封顶 -6），
// 理由：场合不对是这一手的事，不该按整张图退役来罚。
export const CONTEXT_MISFIT_MAX_COUNT = 2;
export const CONTEXT_MISFIT_STEP = 3;
// v0.7.8 - 没有记下情绪时「不应景」也得能记：落到这个桶，对所有情绪都生效（轻度）。
// 之前这种情况直接 400，用户点了没反应，只能干看着。
export const CONTEXT_MISFIT_UNSCOPED = '未分场景';

const writeChains = new Map();

function resolveDataDir(dataDir) {
  return path.resolve(dataDir || DATA_DIR);
}

function filePathOf(dataDir) {
  return path.join(resolveDataDir(dataDir), CONTEXT_FEEDBACK_FILE_NAME);
}

function clean(value, maxLength = 80) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function agentIdOf(value) {
  return clean(value, 100) || 'default';
}

function stickerIdOf(value) {
  return clean(value, 120);
}

function contextOf(value) {
  return clean(value, 80);
}

function emptyData() {
  return { version: CONTEXT_FEEDBACK_VERSION, byAgent: {} };
}

function normalizeData(raw) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : emptyData();
  data.version = CONTEXT_FEEDBACK_VERSION;
  if (!data.byAgent || typeof data.byAgent !== 'object' || Array.isArray(data.byAgent)) data.byAgent = {};
  // v0.7.7 - 场景负向账与正向应景同文件、同结构，只是分开放，互不覆盖。
  if (!data.misfits || typeof data.misfits !== 'object' || Array.isArray(data.misfits)) data.misfits = {};
  return data;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return emptyData();
  }
}

function enqueue(filePath, task) {
  const previous = writeChains.get(filePath) || Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(filePath, next.catch(() => {}));
  return next;
}

function contextBucket(data, agentId, contextEmotion, create = false) {
  const aid = agentIdOf(agentId);
  const context = contextOf(contextEmotion);
  if (!context) return null;
  if (!data.byAgent[aid]) {
    if (!create) return null;
    data.byAgent[aid] = {};
  }
  if (!data.byAgent[aid][context]) {
    if (!create) return null;
    data.byAgent[aid][context] = {};
  }
  return data.byAgent[aid][context];
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function readContextFeedback({ dataDir = DATA_DIR } = {}) {
  return normalizeData(readJson(filePathOf(dataDir)));
}

export function readContextFits({ dataDir = DATA_DIR, agentId = 'default', contextEmotion = '' } = {}) {
  const data = readContextFeedback({ dataDir });
  const bucket = contextBucket(data, agentId, contextEmotion, false);
  const result = {};
  if (!bucket) return result;
  for (const [stickerId, entry] of Object.entries(bucket)) {
    const count = Math.max(0, Math.min(CONTEXT_FIT_MAX_COUNT, Number(entry?.count) || 0));
    if (count > 0) result[stickerId] = count;
  }
  return result;
}

export function contextFitBonus(count) {
  return Math.max(0, Math.min(CONTEXT_FIT_MAX_COUNT, Number(count) || 0));
}

export function getContextFitSnapshot(data, { agentId = 'default', contextEmotion = '', stickerId } = {}) {
  const sid = stickerIdOf(stickerId);
  const bucket = contextBucket(data, agentId, contextEmotion, false);
  const existing = sid && bucket?.[sid];
  return {
    hadEntry: !!existing,
    count: Math.max(0, Number(existing?.count) || 0),
    lastAt: String(existing?.lastAt || ''),
    agentId: agentIdOf(agentId),
    contextEmotion: contextOf(contextEmotion),
    stickerId: sid,
  };
}

function restoreSnapshotInData(data, snapshot) {
  if (!snapshot || !snapshot.contextEmotion || !snapshot.stickerId) return;
  const bucket = contextBucket(data, snapshot.agentId, snapshot.contextEmotion, snapshot.hadEntry);
  if (!bucket) return;
  if (!snapshot.hadEntry || snapshot.count <= 0) {
    delete bucket[snapshot.stickerId];
    return;
  }
  bucket[snapshot.stickerId] = {
    count: Math.min(CONTEXT_FIT_MAX_COUNT, Math.max(0, Number(snapshot.count) || 0)),
    lastAt: String(snapshot.lastAt || ''),
  };
}

/**
 * 写入一次“这次很应景”或恢复这条反馈之前的场景账本状态。
 */
export function applyContextFit({
  dataDir = DATA_DIR,
  agentId = 'default',
  contextEmotion = '',
  stickerId,
  action = 'add',
  restoreSnapshot = null,
  now = Date.now(),
} = {}) {
  const sid = stickerIdOf(stickerId);
  const context = contextOf(contextEmotion);
  if (!sid) return Promise.resolve({ ok: false, status: 400, error: '缺少 stickerId' });
  if (!context) return Promise.resolve({ ok: false, status: 400, error: '缺少场景情绪' });
  if (!['add', 'clear', 'restore'].includes(action)) {
    return Promise.resolve({ ok: false, status: 400, error: '无效的场景反馈动作' });
  }
  const filePath = filePathOf(dataDir);
  const aid = agentIdOf(agentId);
  return enqueue(filePath, async () => {
    const data = normalizeData(readJson(filePath));
    if (action === 'restore') {
      restoreSnapshotInData(data, restoreSnapshot);
      atomicWriteJson(filePath, data);
      return { ok: true, snapshot: null, count: 0 };
    }
    const snapshot = getContextFitSnapshot(data, { agentId: aid, contextEmotion: context, stickerId: sid });
    if (action === 'clear') {
      const bucket = contextBucket(data, aid, context, false);
      const nextCount = Math.max(0, snapshot.count - 1);
      if (bucket) {
        if (nextCount > 0) {
          bucket[sid] = { count: nextCount, lastAt: snapshot.lastAt };
        } else {
          delete bucket[sid];
        }
      }
      atomicWriteJson(filePath, data);
      return { ok: true, snapshot, count: nextCount };
    }
    const bucket = contextBucket(data, aid, context, true);
    const previous = bucket[sid];
    bucket[sid] = {
      count: Math.min(CONTEXT_FIT_MAX_COUNT, Math.max(0, Number(previous?.count) || 0) + 1),
      lastAt: new Date(Number(now) || Date.now()).toISOString(),
    };
    atomicWriteJson(filePath, data);
    return { ok: true, snapshot, count: bucket[sid].count };
  });
}

/**
 * 删条目之后把空桶一起收掉。只删条目不收桶，账本里会积一堆空情绪目录，
 * 看图库管理页的人只会以为哪里坏了。
 */
function pruneEmptyBuckets(data, tableName, aid, ctx) {
  const buckets = data?.[tableName]?.[aid];
  if (!buckets || typeof buckets !== 'object') return;
  // ctx 为空时把这个助手底下的空情绪桶全收掉（删图就是这种情况）。
  const targets = ctx ? [ctx] : Object.keys(buckets);
  for (const key of targets) {
    const bucket = buckets[key];
    if (bucket && typeof bucket === 'object' && !Array.isArray(bucket) && Object.keys(bucket).length === 0) {
      delete buckets[key];
    }
  }
  if (Object.keys(buckets).length === 0) delete data[tableName][aid];
}

function pruneAllEmptyBuckets(data, tableName) {
  const table = data?.[tableName];
  if (!table || typeof table !== 'object') return;
  for (const aid of Object.keys(table)) {
    pruneEmptyBuckets(data, tableName, aid, null);
  }
}

/**
 * 删除某助手某场景下的单条应景记录（管理页手动移除用，整条删除不是递减）。
 */
export function removeContextFitEntry({ dataDir = DATA_DIR, agentId = 'default', contextEmotion = '', stickerId } = {}) {
  const sid = stickerIdOf(stickerId);
  const context = contextOf(contextEmotion);
  if (!sid || !context) return Promise.resolve({ ok: false, status: 400, error: '缺少 stickerId 或场景情绪' });
  const filePath = filePathOf(dataDir);
  const aid = agentIdOf(agentId);
  return enqueue(filePath, async () => {
    const data = normalizeData(readJson(filePath));
    const bucket = contextBucket(data, aid, context, false);
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, sid)) {
      delete bucket[sid];
      // v0.7.8 - 删完顺手收空桶
      pruneEmptyBuckets(data, 'byAgent', aid, context);
      atomicWriteJson(filePath, data);
      return { ok: true, removed: true };
    }
    return { ok: true, removed: false };
  });
}

export function removeStickerContextFeedback({ dataDir = DATA_DIR, stickerId } = {}) {
  const sid = stickerIdOf(stickerId);
  if (!sid) return Promise.resolve({ ok: true, removed: false });
  const filePath = filePathOf(dataDir);
  return enqueue(filePath, async () => {
    const data = normalizeData(readJson(filePath));
    let removed = false;
    // v0.7.7 - 删图时正向应景账和场景负向账一起清，不留下只剩一边的残账。
    for (const table of [data.byAgent, data.misfits]) {
      for (const bucket of Object.values(table || {})) {
        if (!bucket || typeof bucket !== 'object') continue;
        for (const entries of Object.values(bucket)) {
          if (entries && typeof entries === 'object' && Object.prototype.hasOwnProperty.call(entries, sid)) {
            delete entries[sid];
            removed = true;
          }
        }
      }
    }
    if (removed) {
      // v0.7.8 - 删图后把两边留下的空桶一起收
      pruneAllEmptyBuckets(data, 'byAgent');
      pruneAllEmptyBuckets(data, 'misfits');
      atomicWriteJson(filePath, data);
    }
    return { ok: true, removed };
  });
}

// ── v0.7.7 场景负向账（点「这次不应景」命中的就是这里） ──
// 与正向共用文件但分表存放：正向记 byAgent[aid][context][sid]，负向记 misfits[aid][context][sid]。
// 分开的理由：同一个情绪下同一张图可以既被说过「很应景」又被说过「这次不应景」（不同场合），
// 合成一个数字就丢掉方向了。

function misfitBucket(data, agentId, contextEmotion, create = false) {
  const aid = agentIdOf(agentId);
  const context = contextOf(contextEmotion);
  if (!context) return null;
  if (!data.misfits[aid]) {
    if (!create) return null;
    data.misfits[aid] = {};
  }
  if (!data.misfits[aid][context]) {
    if (!create) return null;
    data.misfits[aid][context] = {};
  }
  return data.misfits[aid][context];
}

export function readContextMisfits({ dataDir = DATA_DIR, agentId = 'default', contextEmotion = '' } = {}) {
  const data = readContextFeedback({ dataDir });
  const result = {};
  // 当前情绪那一桶 + 未分场景那一桶，两边都算：没记情绪时记下的就是后者。
  const scopes = [...new Set([contextOf(contextEmotion), CONTEXT_MISFIT_UNSCOPED].filter(Boolean))];
  for (const scope of scopes) {
    const bucket = misfitBucket(data, agentId, scope, false);
    if (!bucket) continue;
    for (const [stickerId, entry] of Object.entries(bucket)) {
      const count = Math.max(0, Math.min(CONTEXT_MISFIT_MAX_COUNT, Number(entry?.count) || 0));
      if (count > 0) result[stickerId] = Math.min(CONTEXT_MISFIT_MAX_COUNT, (result[stickerId] || 0) + count);
    }
  }
  return result;
}

// 每次 -3，封顶两次 -6：在那个场景里明显排到后面，但不至于永远出局。
export function contextMisfitPenalty(count) {
  const n = Math.max(0, Math.min(CONTEXT_MISFIT_MAX_COUNT, Number(count) || 0));
  return -n * CONTEXT_MISFIT_STEP;
}

export function getContextMisfitSnapshot(data, { agentId = 'default', contextEmotion = '', stickerId } = {}) {
  const sid = stickerIdOf(stickerId);
  const bucket = misfitBucket(data, agentId, contextEmotion, false);
  const existing = sid && bucket?.[sid];
  return {
    hadEntry: !!existing,
    count: Math.max(0, Number(existing?.count) || 0),
    lastAt: String(existing?.lastAt || ''),
    agentId: agentIdOf(agentId),
    contextEmotion: contextOf(contextEmotion),
    stickerId: sid,
  };
}

function restoreMisfitInData(data, snapshot) {
  if (!snapshot || !snapshot.contextEmotion || !snapshot.stickerId) return;
  const aid = agentIdOf(snapshot.agentId);
  const ctx = contextOf(snapshot.contextEmotion);
  const bucket = misfitBucket(data, aid, ctx, snapshot.hadEntry);
  if (!bucket) return;
  if (!snapshot.hadEntry || snapshot.count <= 0) {
    delete bucket[snapshot.stickerId];
  } else {
    bucket[snapshot.stickerId] = {
      count: Math.min(CONTEXT_MISFIT_MAX_COUNT, Math.max(0, Number(snapshot.count) || 0)),
      lastAt: String(snapshot.lastAt || ''),
    };
  }
  // 撤干净后不留空壳：账本里堆一堆空情绪目录，看的人只会以为哪里坏了。
  if (Object.keys(bucket).length === 0 && data.misfits?.[aid]) {
    delete data.misfits[aid][ctx];
    if (Object.keys(data.misfits[aid]).length === 0) delete data.misfits[aid];
  }
}

/**
 * 写入一次「这次不应景」，或恢复这条反馈之前的场景负向账状态。
 * 只动 misfits，不碰偏好（preferences.json）里的 dislikes。
 */
export function applyContextMisfit({
  dataDir = DATA_DIR,
  agentId = 'default',
  contextEmotion = '',
  stickerId,
  action = 'add',
  restoreSnapshot = null,
  now = Date.now(),
} = {}) {
  const sid = stickerIdOf(stickerId);
  // v0.7.8 - 缺情绪不再拒绝：落到「未分场景」桶，至少这笔能记上。
  const context = contextOf(contextEmotion) || CONTEXT_MISFIT_UNSCOPED;
  if (!sid) return Promise.resolve({ ok: false, status: 400, error: '缺少 stickerId' });
  if (!['add', 'restore'].includes(action)) {
    return Promise.resolve({ ok: false, status: 400, error: '无效的场景负向动作' });
  }
  const filePath = filePathOf(dataDir);
  const aid = agentIdOf(agentId);
  return enqueue(filePath, async () => {
    const data = normalizeData(readJson(filePath));
    if (action === 'restore') {
      restoreMisfitInData(data, restoreSnapshot);
      atomicWriteJson(filePath, data);
      return { ok: true, snapshot: null, count: 0, penalty: 0 };
    }
    const snapshot = getContextMisfitSnapshot(data, { agentId: aid, contextEmotion: context, stickerId: sid });
    const bucket = misfitBucket(data, aid, context, true);
    const previous = bucket[sid];
    const count = Math.min(CONTEXT_MISFIT_MAX_COUNT, Math.max(0, Number(previous?.count) || 0) + 1);
    bucket[sid] = { count, lastAt: new Date(Number(now) || Date.now()).toISOString() };
    atomicWriteJson(filePath, data);
    return { ok: true, snapshot, count, penalty: contextMisfitPenalty(count) };
  });
}

/** 整条删掉某图在某场景下的负向记录（图库详情手动移除用） */
export function removeContextMisfitEntry({ dataDir = DATA_DIR, agentId = 'default', contextEmotion = '', stickerId } = {}) {
  const sid = stickerIdOf(stickerId);
  const context = contextOf(contextEmotion);
  if (!sid || !context) return Promise.resolve({ ok: false, status: 400, error: '缺少 stickerId 或场景情绪' });
  const filePath = filePathOf(dataDir);
  const aid = agentIdOf(agentId);
  return enqueue(filePath, async () => {
    const data = normalizeData(readJson(filePath));
    const bucket = misfitBucket(data, aid, context, false);
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, sid)) {
      delete bucket[sid];
      // v0.7.8 - 删完顺手收空桶
      pruneEmptyBuckets(data, 'misfits', aid, context);
      atomicWriteJson(filePath, data);
      return { ok: true, removed: true };
    }
    return { ok: true, removed: false };
  });
}

export { agentIdOf, contextOf, stickerIdOf, normalizeData };
