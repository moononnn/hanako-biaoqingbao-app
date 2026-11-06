// API Key 掩码回写防护
//
// 背景：设置页不回显真 key，只填掩码；写入时收到掩码就沿用磁盘旧值。
// 但 GET /api/embedding-config 吐出去的是**半截掩码**（`key.slice(0,8) + '***'`），
// 旧规则只认「整串都是星号」，认不出它。于是任何客户端只要 GET → 原样 POST，
// 真 key 就被换成这串掩码，向量/识图紧接着全报错（2026-11-06 实测踩到一次）。
//
// 规则：全星号 = 没改；「前缀对得上的半截掩码」= 也没改；其余一律当真值处理。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-secret-mask-'));
process.env.BQB_DATA_DIR = root;
process.env.HANA_HOME = root;
const shared = await import('../lib/shared.js');

const realKey = 'sk-csizfbc0123456789abcdefghijklmnopqrstuvwxycddw';
const base = {
  source: 'custom',
  providerId: '',
  modelId: '',
  dimensions: 1024,
  customBaseUrl: 'https://api.siliconflow.cn/v1',
  customModel: 'BAAI/bge-m3',
  customDimensions: 1024,
  autoVectorOnSave: false,
};

const diskKey = () => JSON.parse(fs.readFileSync(shared.EMBEDDING_CFG_FILE, 'utf-8')).customApiKey;

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('半截掩码（GET 吐出去的那一份）不会覆盖真 key', () => {
  shared.writeEmbeddingConfig({ ...base, customApiKey: realKey });
  assert.equal(diskKey(), realKey);

  const halfMask = realKey.slice(0, 8) + '***';
  shared.writeEmbeddingConfig({ ...base, customApiKey: halfMask });
  assert.equal(diskKey(), realKey, 'GET → POST 原样来回一次就把 key 写成掩码了');
});

test('全星号掩码照旧算「没改」', () => {
  shared.writeEmbeddingConfig({ ...base, customApiKey: realKey });
  shared.writeEmbeddingConfig({ ...base, customApiKey: '********' });
  assert.equal(diskKey(), realKey);
});

test('空字符串仍然是「明确清空」', () => {
  shared.writeEmbeddingConfig({ ...base, customApiKey: realKey });
  shared.writeEmbeddingConfig({ ...base, customApiKey: '' });
  assert.equal(diskKey(), '');
});

test('换成另一把真 key 要照实写进去', () => {
  shared.writeEmbeddingConfig({ ...base, customApiKey: realKey });
  const another = 'sk-anoTher000111222333444555666777888999aaa';
  shared.writeEmbeddingConfig({ ...base, customApiKey: another });
  assert.equal(diskKey(), another);
});

test('前缀对不上、又带 *** 的值不当掩码吞掉', () => {
  shared.writeEmbeddingConfig({ ...base, customApiKey: realKey });
  const stranger = 'sk-totally-different***000';
  shared.writeEmbeddingConfig({ ...base, customApiKey: stranger });
  assert.equal(diskKey(), stranger);
});

test('同一套规则也盖住视觉与文本配置', () => {
  shared.writeVisionConfig({ source: 'custom', customBaseUrl: 'https://x', customModel: 'm', customApiKey: realKey });
  const halfMask = realKey.slice(0, 8) + '***';
  shared.writeVisionConfig({ source: 'custom', customBaseUrl: 'https://x', customModel: 'm', customApiKey: halfMask });
  const vision = JSON.parse(fs.readFileSync(shared.VISION_CFG_FILE, 'utf-8'));
  assert.equal(vision.customApiKey, realKey);
});
