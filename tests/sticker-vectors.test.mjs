// 图库语义向量写入：跨应用收图、批量识图、纸飞机共用这一份规则。
// 数据目录先指到临时目录再导入模块，绝不碰真实向量库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-vectors-'));
process.env.BQB_DATA_DIR = path.join(root, 'app-data', 'biaoqingbao-app');
process.env.HANA_HOME = root;
fs.mkdirSync(process.env.BQB_DATA_DIR, { recursive: true });

const { writeStickerVector, writeStickerVectors, shouldAutoVectorOnSave } = await import('../lib/sticker-vectors.js');
const shared = await import('../lib/shared.js');

function writeEmbeddingCfg(patch) {
  fs.writeFileSync(
    path.join(shared.DATA_DIR, 'embedding-config.json'),
    JSON.stringify({
      source: 'custom', providerId: '', modelId: '', dimensions: 4,
      customBaseUrl: 'https://example.invalid/v1', customApiKey: 'test-key',
      customModel: 'test-embed', customDimensions: 4, autoVectorOnSave: true, ...patch,
    }),
    'utf-8',
  );
}

const okEmbed = (vector = [0.1, 0.2, 0.3, 0.4]) => async () => ({ ok: true, data: [vector] });

// 每个用例从空向量库开始：模型变更保护会拿磁盘上已有的 model 比对，上一个用例留下的会串味。
function resetVectors() {
  fs.rmSync(path.join(shared.DATA_DIR, 'vectors.json'), { force: true });
}

test('正常建向量：写进 vectors.json，记下模型与维度', async () => {
  resetVectors();
  writeEmbeddingCfg({ customModel: 'test-embed' });
  const result = await writeStickerVector(
    { id: 'stk_vec_1', semantic_description: '适合安慰人' },
    { embed: okEmbed([1, 2, 3, 4]) },
  );
  assert.equal(result.ok, true);

  const data = shared.readVectors();
  assert.deepEqual(data.vectors.stk_vec_1, [1, 2, 3, 4]);
  assert.equal(data.model, 'test-embed');
  assert.equal(data.dimensions, 4);
});

test('没有语义描述就跳过：不算失败，也不写空向量', async () => {
  resetVectors();
  writeEmbeddingCfg({ customModel: 'test-embed' });
  const result = await writeStickerVector({ id: 'stk_vec_empty', semantic_description: '   ' }, { embed: okEmbed() });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'no-semantic');
  assert.equal(shared.readVectors().vectors.stk_vec_empty, undefined);
});

test('缺编号直接拒，不去花 embedding 额度', async () => {
  let called = false;
  const result = await writeStickerVector({ semantic_description: '有描述没编号' }, {
    embed: async () => { called = true; return { ok: true, data: [[1]] }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'no-id');
  assert.equal(called, false);
});

test('向量接口失败：如实返回原因，不写坏库', async () => {
  resetVectors();
  writeEmbeddingCfg({ customModel: 'test-embed' });
  const result = await writeStickerVector({ id: 'stk_vec_fail', semantic_description: '一句话' }, {
    embed: async () => ({ ok: false, error: 'Embedding API HTTP 401' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /401/);
  assert.equal(shared.readVectors().vectors.stk_vec_fail, undefined);
});

test('向量模型换了就不混写：拒绝并指路去整体重算', async () => {
  resetVectors();
  writeEmbeddingCfg({ customModel: 'model-a' });
  await writeStickerVector({ id: 'stk_vec_a', semantic_description: '甲' }, { embed: okEmbed([1, 1, 1, 1]) });
  assert.equal(shared.readVectors().model, 'model-a');

  writeEmbeddingCfg({ customModel: 'model-b' });
  const result = await writeStickerVector({ id: 'stk_vec_b', semantic_description: '乙' }, { embed: okEmbed([2, 2, 2, 2]) });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'model-changed');
  assert.equal(shared.readVectors().vectors.stk_vec_b, undefined, '维度不同的向量不能写进旧库');
});

test('批量版：一张失败不影响其余，失败项带原因返回', async () => {
  resetVectors();
  writeEmbeddingCfg({ customModel: 'model-a' });
  const result = await writeStickerVectors(
    [
      { id: 'stk_vec_c', semantic_description: '丙' },
      { id: 'stk_vec_d', semantic_description: '丁' },
    ],
    { embed: okEmbed([3, 3, 3, 3]) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.built, 2);
  assert.deepEqual(result.failed, []);
});

test('自动建向量开关：默认关，配置 true 才算开', async () => {
  writeEmbeddingCfg({ autoVectorOnSave: false });
  assert.equal(shouldAutoVectorOnSave(), false);
  assert.equal(shouldAutoVectorOnSave({ autoVectorOnSave: true }), true);
  writeEmbeddingCfg({ autoVectorOnSave: true });
  assert.equal(shouldAutoVectorOnSave(), true);
});
