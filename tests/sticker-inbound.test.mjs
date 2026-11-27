// 跨应用收图服务：白名单、入库、后台认图。
// 数据目录先指到临时目录再导入模块，绝不碰真实图库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-inbound-'));
process.env.BQB_DATA_DIR = path.join(root, 'app-data', 'biaoqingbao-app');
process.env.HANA_HOME = root;

const { registerStickerInboundService, INBOUND_METHOD, INBOUND_MAX_BYTES } = await import('../lib/sticker-inbound.js');
const shared = await import('../lib/shared.js');

function makeSdk({ tagger = async () => ({ ok: false, error: '未认图' }) } = {}) {
  const handlers = new Map();
  const logs = [];
  const sdk = {
    dataDir: process.env.BQB_DATA_DIR,
    models: null,
    bus: {
      handle: async (name, handler, options) => { handlers.set(name, { handler, options }); return () => {}; },
      request: async () => ({}),
    },
    network: null,
    logger: { info: async (m) => logs.push(m), warn: async (m) => logs.push(m) },
  };
  return { sdk, handlers, logs, tagger };
}

async function setup(tagger) {
  const ctx = makeSdk({ tagger });
  await registerStickerInboundService({ sdk: ctx.sdk, allowedCallers: ['chahuahui'], tagger: ctx.tagger });
  const entry = ctx.handlers.get(INBOUND_METHOD);
  assert.ok(entry, '服务要注册上');
  return { ...ctx, entry };
}

function tempImage(ext = 'png') {
  const file = path.join(root, `inbound-${Math.random().toString(36).slice(2)}.${ext}`);
  // 每张图内容都不同：去重用例靠同一路径调两次，别的用例不能被前面的图干扰。
  fs.writeFileSync(file, Buffer.from(`fake-image-${Math.random().toString(36).slice(2)}`));
  return file;
}

const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

test('服务只对茶话会开放，且声明允许跨应用', async () => {
  const { entry } = await setup();
  assert.equal(entry.options.allowCrossApp, true);
  const refused = await entry.handler({ sourcePath: tempImage() }, { callerAppId: 'someone-else' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /调用方/);
});

test('路径不合法一律不收：缺路径、相对路径、文件不存在、空文件、超大', async () => {
  const { entry } = await setup();
  assert.equal((await entry.handler({}, { callerAppId: 'chahuahui' })).ok, false);
  assert.equal((await entry.handler({ sourcePath: 'relative/x.png' }, { callerAppId: 'chahuahui' })).ok, false);
  assert.equal((await entry.handler({ sourcePath: path.join(root, 'nope.png') }, { callerAppId: 'chahuahui' })).ok, false);

  const empty = path.join(root, 'empty.png');
  fs.writeFileSync(empty, Buffer.alloc(0));
  assert.match((await entry.handler({ sourcePath: empty }, { callerAppId: 'chahuahui' })).error, /空/);

  // 超过上限的字节数要被拒（真的造一个 10MB+1 的文件）。
  const huge = path.join(root, 'huge.png');
  fs.writeFileSync(huge, Buffer.alloc(INBOUND_MAX_BYTES + 1, 1));
  assert.match((await entry.handler({ sourcePath: huge }, { callerAppId: 'chahuahui' })).error, /10MB/);
});

test('正常收图：入库落盘，返回编号；源文件不删（那是调用方的事）', async () => {
  const { entry } = await setup();
  const source = tempImage();
  const before = shared.readMeta().length;

  const result = await entry.handler({ sourcePath: source }, { callerAppId: 'chahuahui' });
  assert.equal(result.ok, true);
  assert.match(result.id, /^stk_/);

  const meta = shared.readMeta();
  assert.equal(meta.length, before + 1);
  const row = meta.find((item) => item.id === result.id);
  assert.equal(row.file, result.file);
  assert.ok(fs.existsSync(path.join(shared.STICKERS_DIR, row.file)), '图落进图库');
  assert.ok(fs.existsSync(source), '源文件留给调用方自己处理');
});

test('后台认图成功：标签和语义写回那一行，并盖识图时间', async () => {
  const tagger = async () => ({
    ok: true,
    data: { description: '一只猫', semantic_description: '适合安慰人', emotion: ['开心'], scene: ['安慰'], keywords: ['猫', '摸鱼'] },
  });
  const { entry } = await setup(tagger);
  const result = await entry.handler({ sourcePath: tempImage() }, { callerAppId: 'chahuahui' });
  await wait();

  const row = shared.readMeta().find((item) => item.id === result.id);
  assert.equal(row.description, '一只猫');
  assert.equal(row.semantic_description, '适合安慰人');
  assert.deepEqual(row.tags.emotion, ['开心']);
  assert.deepEqual(row.tags.keywords, ['猫', '摸鱼']);
  assert.ok(row.tagged_at, '认图成功要盖时间，不然会被当成没识过');
});

test('同一张图收两次：第二次认重复，不重复入库也不再认图', async () => {
  const tagger = async () => ({ ok: true, data: { description: 'x', emotion: ['开心'], scene: [], keywords: ['猫'] } });
  const { entry } = await setup(tagger);
  const source = tempImage();
  const first = await entry.handler({ sourcePath: source }, { callerAppId: 'chahuahui' });
  await wait();
  assert.equal(first.ok, true);

  const second = await entry.handler({ sourcePath: source }, { callerAppId: 'chahuahui' });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true, '同一张图要认出来');
  assert.equal(second.id, first.id, '指向库里那一张，不新建');

  const meta = shared.readMeta();
  assert.equal(meta.filter((item) => item.id === first.id).length, 1, '图库里只该有一张');
});

test('后台认图失败：图留着，只缺标签，不影响收图结果', async () => {
  const tagger = async () => ({ ok: false, error: '未配置视觉模型' });
  const { entry } = await setup(tagger);
  const result = await entry.handler({ sourcePath: tempImage() }, { callerAppId: 'chahuahui' });
  assert.equal(result.ok, true, '认图失败不该让收图失败');
  await wait();

  const row = shared.readMeta().find((item) => item.id === result.id);
  assert.ok(row, '图还在');
  assert.equal(row.tagged_at, undefined);
  assert.deepEqual(row.tags.emotion, []);
});

test('认图撞上瞬时错误：退避重试一次就救回来，不再扔进未识图', async () => {
  let calls = 0;
  const tagger = async () => {
    calls += 1;
    // 第一次模拟模型超时（rpc-retry 认这类可重试），第二次正常返回
    if (calls === 1) return { ok: false, error: 'MODEL_TIMEOUT 模型调用超时' };
    return {
      ok: true,
      data: { description: '重试后成功', semantic_description: '适合安慰人', emotion: ['心疼'], scene: [], keywords: ['抱抱'] },
    };
  };
  const { entry } = await setup(tagger);
  const result = await entry.handler({ sourcePath: tempImage() }, { callerAppId: 'chahuahui' });
  assert.equal(result.ok, true);
  await wait(2400);

  const row = shared.readMeta().find((item) => item.id === result.id);
  assert.equal(calls, 2, '超时这类错误要重试一次');
  assert.equal(row.description, '重试后成功');
  assert.ok(row.tagged_at, '重试成功后要盖识图时间');
});

test('认图撞上确定性错误：不白花钱重试', async () => {
  let calls = 0;
  const tagger = async () => {
    calls += 1;
    return { ok: false, error: '未配置视觉模型，请先在设置里选择或填写模型' };
  };
  const { entry } = await setup(tagger);
  await entry.handler({ sourcePath: tempImage() }, { callerAppId: 'chahuahui' });
  await wait(200);
  assert.equal(calls, 1, '配置类错误重试也只会得到同一个结果');
});
