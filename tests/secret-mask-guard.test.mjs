// API Key 占位符防护
//
// 事故经过：设置页不回显真 key，只在输入框里填 ********。用户（和应用作者自己）
// 打开设置页动了别的设置、点一次保存，这份表单就把 ******** 当真 key 提交并落盘，
// 覆盖掉真 key。表现是「刚配好能用，过一阵又报错」，实际从第二次打开设置页那刻起就已经坏了。
//
// 修法：写入时收到掩码 = 「这个字段用户没动」，沿用磁盘上的旧值；
// 空字符串仍表示「明确清空」。所以三种操作都对：
//   开页面点保存 → 保留旧 key；填新 key 保存 → 覆盖；删空保存 → 清掉。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-secret-mask-'));
process.env.BQB_DATA_DIR = dataDir;
process.env.HANA_HOME = dataDir;

const { isMaskedSecret, writeEmbeddingConfig, readEmbeddingConfig, writeTextConfig, readTextConfig } =
  await import('../lib/shared.js');

const CFG_FILE = path.join(dataDir, 'embedding-config.json');
const REAL_KEY = 'sk-real-0123456789abcdef';
const base = {
  source: 'custom', providerId: '', modelId: '',
  dimensions: 1024, customBaseUrl: 'https://api.siliconflow.cn/v1',
  customApiKey: REAL_KEY, customModel: 'BAAI/bge-m3', customDimensions: 1024,
};

test('认得出哪些字符串是占位符', () => {
  assert.equal(isMaskedSecret('********'), true);
  assert.equal(isMaskedSecret('  ****  '), true);
  assert.equal(isMaskedSecret('****'), true);
  assert.equal(isMaskedSecret(REAL_KEY), false);
  assert.equal(isMaskedSecret(''), false);
  assert.equal(isMaskedSecret('sk-****abcd'), false);
  assert.equal(isMaskedSecret(undefined), false);
  assert.equal(isMaskedSecret(null), false);
  assert.equal(isMaskedSecret(123), false);
});

test('开过设置页点保存不会把真 key 洗成占位符', () => {
  writeEmbeddingConfig(base);
  assert.equal(readEmbeddingConfig().customApiKey, REAL_KEY);

  // 模拟：重新打开设置页（表单里是 ********），改了 autoVectorOnSave，然后保存
  writeEmbeddingConfig({ ...base, customApiKey: '********', autoVectorOnSave: true });

  const after = readEmbeddingConfig();
  assert.equal(after.customApiKey, REAL_KEY, '占位符必须原样保留旧 key');
  assert.equal(after.autoVectorOnSave, true, '同一次保存里的其他改动要照常生效');
});

test('填了新 key 就正常覆盖', () => {
  writeEmbeddingConfig({ ...base, customApiKey: 'sk-new-key-xyz' });
  assert.equal(readEmbeddingConfig().customApiKey, 'sk-new-key-xyz');
});

test('清空 key 仍然清得掉（掩码保留不能变成删不掉）', () => {
  writeEmbeddingConfig({ ...base, customApiKey: REAL_KEY });
  writeEmbeddingConfig({ ...base, customApiKey: '' });
  assert.equal(readEmbeddingConfig().customApiKey, '');
});

test('磁盘上本来就是占位符时，不会凭空继承出假 key', () => {
  // 老版本已经写坏的存量数据：磁盘是 ********，再保存一次仍然只能是 ********
  fs.writeFileSync(CFG_FILE, JSON.stringify({ ...base, customApiKey: '********' }));
  writeEmbeddingConfig({ ...base, customApiKey: '********' });
  assert.equal(readEmbeddingConfig().customApiKey, '********');
});

test('文本模型配置同样受保护', () => {
  writeTextConfig({ enabled: true, source: 'custom', providerId: '', modelId: '',
    customBaseUrl: 'https://example.com/v1', customApiKey: 'sk-text-real', customModel: 'gpt-x' });
  writeTextConfig({ enabled: true, source: 'custom', providerId: '', modelId: '',
    customBaseUrl: 'https://example.com/v1', customApiKey: '********', customModel: 'gpt-y' });
  const after = readTextConfig();
  assert.equal(after.customApiKey, 'sk-text-real');
  assert.equal(after.customModel, 'gpt-y');
});

test('resolveEmbeddingApi 不再拿占位符去请求（不再换来一个看不懂的 401）', async () => {
  const { resolveEmbeddingApi } = await import('../lib/shared.js');
  fs.writeFileSync(CFG_FILE, JSON.stringify({ ...base, customApiKey: '********' }));
  assert.equal(resolveEmbeddingApi().apiKey, '');
});