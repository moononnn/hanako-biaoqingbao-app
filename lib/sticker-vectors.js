// 图库语义向量：把一张图的语义描述写进 vectors.json。
//
// 现在有三条路会走到这里，写入规则必须是同一套（模型变更保护、维度记录、串行写入）：
//   · 纸飞机识图确认入库（lib/ball.js）
//   · 跨应用收图（lib/sticker-inbound.js，茶话会右键收进表情包）
//   · 批量识图应用完之后补建（server/_batch-tasks.js）
// 分开各写一份，很容易一边加了保护另一边没加，所以收在这一处。
//
// 两条纪律：
//   1. 联网生成向量那一步不放进写队列——排队等网络会把并发识图拖成串行。
//   2. 读改写在队列里重读磁盘，避免两个 worker 同时写掉彼此的向量。

import {
  generateEmbeddings,
  readEmbeddingConfig,
  readVectors,
  writeVectors,
  resolveEmbeddingApi,
  enqueueStickerDataWrite,
} from './shared.js';

/**
 * 入库时要不要顺手建向量（设置页「图库语义索引」下面那个开关）。
 * 默认关，避免隐性消耗付费 embedding 额度；传 cfg 时只看传进来的那份配置。
 */
export function shouldAutoVectorOnSave(cfg) {
  if (cfg && typeof cfg === 'object') return cfg.autoVectorOnSave === true;
  return readEmbeddingConfig().autoVectorOnSave === true;
}

/**
 * 给一张图建（或重建）向量。
 *
 * @param {{id?:string, semantic_description?:string}} entry 图库里的那一行
 * @param {{ctx?:object, embed?:Function}} [options]
 *   ctx 是宿主注入的 App 上下文，联网必须走它的受控出口；
 *   embed 可注入（测试用 mock），默认走真实 embedding 接口。
 * @returns {Promise<{ok:boolean, skipped?:string, error?:string}>}
 */
export async function writeStickerVector(entry, { ctx = null, embed = generateEmbeddings } = {}) {
  const id = String(entry?.id || '').trim();
  if (!id) return { ok: false, skipped: 'no-id', error: '缺少表情包编号' };
  const semantic = String(entry?.semantic_description || '').trim();
  // 没有语义描述就没有可嵌入的文本：静默跳过，不算失败（图本来就可能是纯图无字）。
  if (!semantic) return { ok: true, skipped: 'no-semantic' };

  const { model: currentModel, dimensions: currentDims } = resolveEmbeddingApi();
  try {
    const embResult = await embed(semantic, ctx);
    if (!embResult?.ok || !Array.isArray(embResult.data) || !embResult.data[0]) {
      return { ok: false, skipped: 'embedding-failed', error: embResult?.error || '向量生成失败' };
    }
    return await enqueueStickerDataWrite(() => {
      const vectorsData = readVectors();
      if (!vectorsData.vectors) vectorsData.vectors = {};
      // 模型变更保护：旧库已有不同 model 时不混写，避免维度冲突（与单图重算逻辑一致）。
      if (vectorsData.model && currentModel && vectorsData.model !== currentModel) {
        return {
          ok: false,
          skipped: 'model-changed',
          error: `向量模型已更换（${vectorsData.model} → ${currentModel}），请到图库页「图库语义索引」里整体重算`,
        };
      }
      vectorsData.vectors[id] = embResult.data[0];
      vectorsData.generated_at = new Date().toISOString();
      if (!vectorsData.model) vectorsData.model = currentModel || '';
      if (!vectorsData.dimensions) vectorsData.dimensions = currentDims || 0;
      writeVectors(vectorsData);
      return { ok: true };
    });
  } catch (error) {
    return { ok: false, skipped: 'embedding-error', error: error?.message || '向量生成失败' };
  }
}

/** 批量版：逐个建，单张失败不影响其余。返回 { ok, built, skipped, failed[] }。 */
export async function writeStickerVectors(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const failed = [];
  let built = 0;
  for (const entry of list) {
    const result = await writeStickerVector(entry, options);
    if (result.ok && !result.skipped) built += 1;
    else if (!result.ok) failed.push({ id: entry?.id || '', error: result.error || '', skipped: result.skipped || '' });
  }
  return { ok: failed.length === 0, built, skipped: list.length - built - failed.length, failed };
}
