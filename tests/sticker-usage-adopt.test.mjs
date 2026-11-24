// 采用用法：跨应用服务 + 自动选图不再靠旧标签/向量 + 对外索引带出新用法。
// 数据目录先指到临时目录再导入模块，绝不碰真实图库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-usage-'));
process.env.BQB_DATA_DIR = path.join(root, 'app-data', 'biaoqingbao-app');
process.env.HANA_HOME = root;

const { registerStickerUsageAdoptService, USAGE_ADOPT_METHOD, parseAdoptUsagePayload } = await import('../lib/sticker-inbound.js');
const shared = await import('../lib/shared.js');
const { scoreStickers, applyVectorBonus } = await import('../tools/express.js');
const { buildPublicIndex } = await import('../lib/public-index.js');

function makeSdk() {
  const handlers = new Map();
  const logs = [];
  const sdk = {
    dataDir: process.env.BQB_DATA_DIR,
    bus: {
      handle: async (name, handler, options) => { handlers.set(name, { handler, options }); return () => {}; },
      request: async () => ({}),
    },
    logger: { info: async (m) => logs.push(m), warn: async (m) => logs.push(m) },
  };
  return { sdk, handlers, logs };
}

async function setup() {
  const ctx = makeSdk();
  await registerStickerUsageAdoptService({ sdk: ctx.sdk, allowedCallers: ['chahuahui'] });
  const entry = ctx.handlers.get(USAGE_ADOPT_METHOD);
  assert.ok(entry, '服务要注册上');
  return { ...ctx, entry };
}

function seedSticker({ id = 'stk_001', description = '一只猫', emotion = ['得意'], keywords = ['猫'] } = {}) {
  fs.mkdirSync(shared.STICKERS_DIR, { recursive: true });
  fs.writeFileSync(path.join(shared.STICKERS_DIR, `${id}.png`), Buffer.from(`img-${id}`));
  shared.writeMeta([{
    id,
    file: `${id}.png`,
    description,
    semantic_description: '适合被夸之后用',
    tags: { emotion, scene: [], keywords },
    added_at: '2026-01-01T00:00:00.000Z',
  }]);
  return id;
}

test('服务只对茶话会开放，且声明允许跨应用', async () => {
  const { entry } = await setup();
  assert.equal(entry.options.allowCrossApp, true);
  const refused = await entry.handler({ stickerId: 'stk_001', meaning: '被夸之后假装不在意' }, { callerAppId: 'someone-else' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /调用方/);
});

test('载荷严格：只认 stickerId 与 meaning，多一个字段就拒', async () => {
  const { entry } = await setup();
  seedSticker();
  const cases = [
    [{}, /stickerId|meaning/],
    [{ stickerId: 'stk_001' }, /meaning/],
    [{ meaning: '被夸之后假装不在意' }, /stickerId/],
    [{ stickerId: 'stk_001', meaning: '被夸之后假装不在意', extra: 1 }, /多余/],
    [{ stickerId: 'stk_001', meaning: '' }, /用法说明/],
    [{ stickerId: 'stk_001', meaning: 123 }, /文字/],
    [{ stickerId: 'stk 001', meaning: '被夸之后假装不在意' }, /编号/],
    [{ stickerId: 123, meaning: '被夸之后假装不在意' }, /编号/],
    [{ stickerId: 'stk_001', meaning: '啊'.repeat(61) }, /太长/],
  ];
  for (const [payload, pattern] of cases) {
    const result = await entry.handler(payload, { callerAppId: 'chahuahui' });
    assert.equal(result.ok, false, `不该收：${JSON.stringify(payload)}`);
    assert.match(result.error, pattern);
  }
  // 严格校验是纯函数，单独再验一次形状。
  assert.equal(parseAdoptUsagePayload({ stickerId: 'stk_001', meaning: ' 被夸之后假装不在意 ' }).meaning, '被夸之后假装不在意');
});

test('编号必须是共享图库里真有的那一张', async () => {
  const { entry } = await setup();
  seedSticker();
  const missing = await entry.handler({ stickerId: 'stk_999', meaning: '被夸之后假装不在意' }, { callerAppId: 'chahuahui' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /图库里没有这张图/);
});

test('采纳成功：只写这一张的 usage 字段，标题/原图/标签一概不动', async () => {
  const { entry } = await setup();
  const id = seedSticker();
  const before = shared.readMeta().find((row) => row.id === id);

  const result = await entry.handler({ stickerId: id, meaning: '被夸之后假装不在意' }, { callerAppId: 'chahuahui' });
  assert.equal(result.ok, true);
  assert.equal(result.id, id);

  const row = shared.readMeta().find((item) => item.id === id);
  assert.equal(row.usage.meaning, '被夸之后假装不在意');
  assert.equal(row.usage.source, 'chahuahui');
  assert.ok(row.usage.adopted_at, '要记下什么时候采纳的');
  assert.equal(row.description, before.description, '标题不能被覆盖');
  assert.equal(row.semantic_description, before.semantic_description);
  assert.deepEqual(row.tags, before.tags, '旧标签不能被覆盖');
  assert.equal(row.file, before.file, '原图不能被换');
  assert.ok(fs.existsSync(path.join(shared.STICKERS_DIR, row.file)), '原图还在');
});

test('再次采纳：覆盖的是用法本身，别的不动', async () => {
  const { entry } = await setup();
  const id = seedSticker();
  await entry.handler({ stickerId: id, meaning: '被夸之后假装不在意' }, { callerAppId: 'chahuahui' });
  const second = await entry.handler({ stickerId: id, meaning: '其实是嘴硬' }, { callerAppId: 'chahuahui' });
  assert.equal(second.ok, true);
  const row = shared.readMeta().find((item) => item.id === id);
  assert.equal(row.usage.meaning, '其实是嘴硬');
  assert.equal(row.description, '一只猫');
  assert.deepEqual(row.tags.emotion, ['得意']);
});

test('自动选图：采用过的图不再靠旧标签被选中，只有新用法命中才参选', () => {
  const sticker = {
    id: 'stk_001',
    file: 'stk_001.png',
    description: '一只猫',
    tags: { emotion: ['得意'], scene: [], keywords: ['猫'] },
    usage: { meaning: '被夸之后假装不在意', source: 'chahuahui', adopted_at: '2026-01-01T00:00:00.000Z' },
  };
  const noPrefs = { vetoed: [], dislikes: {} };

  // 旧标签说它是「得意」：纠正过之后，这条旧标签不再算数。
  const byOldTag = scoreStickers([sticker], '得意', [], noPrefs);
  assert.deepEqual(byOldTag.map((s) => s.id), [], '旧标签不该再把它选出来');

  // 新用法本身命中：它重新有资格参选，而且分数来自用法。
  const byUsage = scoreStickers([sticker], '被夸', [], noPrefs);
  assert.equal(byUsage.length, 1);
  assert.equal(byUsage[0]._score, 40);

  // 没被采用的图不受影响：旧标签照旧能选出来。
  const plain = scoreStickers([{ ...sticker, usage: undefined }], '得意', [], noPrefs);
  assert.equal(plain.length, 1);
  assert.equal(plain[0]._score, 8);
});

test('向量通道不会把采用过的图捞回来', () => {
  const sticker = {
    id: 'stk_001',
    file: 'stk_001.png',
    description: '一只猫',
    tags: { emotion: ['得意'], scene: [], keywords: [] },
    usage: { meaning: '被夸之后假装不在意', source: 'chahuahui', adopted_at: '2026-01-01T00:00:00.000Z' },
  };
  const noPrefs = { vetoed: [], dislikes: {} };
  const emotionVec = [1, 0];
  const vectorMap = { stk_001: [0.99, 0.01] };

  // 纯向量补充通道：旧向量再近也不收。
  const scored = [];
  applyVectorBonus(scored, [sticker], emotionVec, vectorMap, [], noPrefs, null, null, {});
  assert.deepEqual(scored.map((s) => s.id), [], '旧向量不该把采用过的图捞回来');

  // 已在候选里的采用图，也不吃旧向量的加成。
  const inPool = [{ ...sticker, _score: 40 }];
  applyVectorBonus(inPool, [sticker], emotionVec, vectorMap, [], noPrefs, null, null, {});
  assert.equal(inPool[0]._score, 40, '旧向量不该给它加分');
});

test('对外索引带出新用法', () => {
  const index = buildPublicIndex({
    meta: [{
      id: 'stk_001',
      file: 'stk_001.png',
      description: '一只猫',
      tags: { emotion: ['得意'], scene: [], keywords: [] },
      usage: { meaning: '被夸之后假装不在意', source: 'chahuahui', adopted_at: '2026-01-01T00:00:00.000Z' },
    }],
    groupStore: {},
    preferences: {},
    recentMatches: {},
  });
  assert.equal(index.stickers.length, 1);
  assert.equal(index.stickers[0].usage, '被夸之后假装不在意');
  assert.equal(index.stickers[0].description, '一只猫', '标题照旧');

  const plain = buildPublicIndex({
    meta: [{ id: 'stk_002', file: 'stk_002.png', description: 'x', tags: { emotion: [], scene: [], keywords: [] } }],
    groupStore: {},
    preferences: {},
    recentMatches: {},
  });
  assert.equal(plain.stickers[0].usage, '', '没用过就是空串');
});
