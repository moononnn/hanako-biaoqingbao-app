import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-app-maintenance-'));
process.env.BQB_DATA_DIR = dataDir;
process.env.HANA_HOME = dataDir;

const { default: registerRoutes } = await import('../server/api.js');
const { selectUntaggedForBatch } = await import('../server/_batch-tasks.js');

const metadata = [
  { id: 'stk_1', tagged_at: '2026-10-01T00:00:00.000Z', semantic_description: '有向量但本次不参与' },
  { id: 'stk_2', description: '需要向量 A', semantic_description: '向量测试文本 A' },
  { id: 'stk_3', description: '需要向量 B', semantic_description: '向量测试文本 B' },
];
const originalVectors = {
  version: 1,
  model: 'BAAI/bge-m3',
  dimensions: 1024,
  generated_at: '2026-10-10T00:00:00.000Z',
  vectors: { stk_1: [0.25, 0.5] },
};

fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify(metadata));
fs.writeFileSync(path.join(dataDir, 'vectors.json'), JSON.stringify(originalVectors, null, 2));
fs.writeFileSync(path.join(dataDir, 'embedding-config.json'), JSON.stringify({
  source: 'custom',
  customBaseUrl: 'https://api.siliconflow.cn/v1',
  customApiKey: 'test-key',
  customModel: 'BAAI/bge-m3',
  customDimensions: 1024,
}));

const handlers = new Map();
let app;
app = new Proxy({}, {
  get(_target, method) {
    if (method === 'onError') return () => {};
    return (...args) => {
      if (typeof args[1] === 'function') handlers.set(`${String(method).toUpperCase()} ${args[0]}`, args[1]);
      return app;
    };
  },
});

let fetchCalls = 0;
await registerRoutes(app, {
  network: {
    fetch: async () => {
      fetchCalls++;
      return new Response('upstream unavailable', { status: 503 });
    },
  },
  log: { info() {}, warn() {}, error() {} },
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('一键识图只选未识图图片，并阻止重复任务和未应用结果', () => {
  assert.deepEqual(selectUntaggedForBatch([
    { id: 'stk_1', tagged_at: 'now' },
    { id: 'stk_2' },
    { id: 'stk_2' },
    { id: '' },
  ], []), { ok: true, reason: '', ids: ['stk_2'] });

  assert.deepEqual(selectUntaggedForBatch([{ id: 'stk_2' }], [{ status: 'running' }]), {
    ok: false, reason: 'running', ids: [],
  });

  assert.deepEqual(selectUntaggedForBatch([{ id: 'stk_2' }], [{
    status: 'completed', completed: ['stk_1'], applied: [],
  }]), { ok: false, reason: 'pending-apply', ids: [] });
});

test('图库页快捷入口连接一键识图任务，索引失败分支读取后端错误', () => {
  const panel = fs.readFileSync(new URL('../ui/panel.html', import.meta.url), 'utf8');
  const ui = fs.readFileSync(new URL('../ui/assets/sticker-manager.js', import.meta.url), 'utf8');
  assert.match(panel, /id="batch-tag-untagged-btn" title="把图库里所有还没识过图的图片排成一次识图任务">一键补齐识图<\/button>/);
  assert.match(ui, /quickUntaggedButton\.addEventListener\('click', batchTagUntagged\)/);
  assert.match(ui, /API \+ '\/api\/batch-auto-tag-untagged'/);
  assert.match(ui, /Number\(d\.failed\) > 0/);
  assert.match(ui, /d\.errors/);
});

test('向量批次全失败时返回错误且不改写现有索引账本', async () => {
  const handler = handlers.get('POST /api/generate-embeddings');
  assert.equal(typeof handler, 'function');
  const response = await handler({ req: { json: async () => ({ onlyMissing: true }) } });
  const result = await response.json();

  assert.equal(fetchCalls, 1, JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.equal(result.data.total, 2);
  assert.equal(result.data.processed, 0);
  assert.equal(result.data.failed, 2);
  assert.match(result.data.errors[0], /HTTP 503: upstream unavailable/);
  assert.match(result.data.note, /现有索引未改动/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'vectors.json'), 'utf8'), JSON.stringify(originalVectors, null, 2));
});

test('老图库缺识图时间的条目会被回填，补过的不再算未识图', async () => {
  const shared = await import('../lib/shared.js');
  const stickersFile = path.join(dataDir, 'stickers.json');
  const before = JSON.parse(fs.readFileSync(stickersFile, 'utf8'));
  assert.deepEqual(before.filter((s) => s.tagged_at).map((s) => s.id), ['stk_1'], '起点：只有 stk_1 有时间');

  const filled = shared.backfillTaggedAt();
  assert.equal(filled, 2, 'stk_2 / stk_3 有标签数据却没有时间，应该被补上');

  const after = JSON.parse(fs.readFileSync(stickersFile, 'utf8'));
  const byId = new Map(after.map((s) => [s.id, s]));
  assert.equal(byId.get('stk_1').tagged_at, '2026-10-01T00:00:00.000Z', '已经有时间的条目不能被改动');
  assert.ok(byId.get('stk_2').tagged_at, 'stk_2 应该被补上时间');
  assert.ok(byId.get('stk_3').tagged_at, 'stk_3 应该被补上时间');

  assert.equal(shared.backfillTaggedAt(), 0, '再补一次不该有任何改动（否则每次启动都白写盘）');
  assert.deepEqual(selectUntaggedForBatch(after, []).ids, [], '补过时间的条目不能再算未识图');
});

test('回填接在启动流程里，落在路由注册之后，且注册要点 await（防接线断开、防被老账本迁移误读）', () => {
  const entry = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(
    entry,
    /await sdk\.routes\.register\(/,
    'sdk.routes.register 必须 await：不 await 时回调可能延后执行，回填会抢在迁移之前落盘',
  );
  const registerAt = entry.indexOf('sdk.routes.register');
  const backfillAt = entry.indexOf('backfillTaggedAt()');
  assert.ok(registerAt > 0, 'index.js 里应有路由注册');
  assert.ok(backfillAt > 0, 'index.js 启动时应调用 backfillTaggedAt');
  assert.ok(
    backfillAt > registerAt,
    'backfillTaggedAt 必须排在路由注册之后：批量任务账本的一次性迁移先按原样跑完，回填后落盘，否则那批没应用的识图结果会被误标为已应用',
  );
});
