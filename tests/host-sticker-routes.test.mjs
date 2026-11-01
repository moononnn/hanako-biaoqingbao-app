// 宿主闲聊表情包 · 路由层（lib/host-sticker-routes.js）
//
// 这轮修的核心：分类列表读不到时，界面就停在「读不到分类」。
// 现在分类列表走双路——宿主自己的接口（权威，能发）优先，
// 走不通就退回本机目录（能看，不能发），两条都断才报错。
// 这里把三种组合都钉住，别以后又退回单一路径。
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerHostStickerRoutes } from '../lib/host-sticker-routes.js';

const DATA_DIR = 'C:/hana-home/app-data/biaoqingbao-app';
const HOME = 'C:/hana-home';

/** 造一个只会注册 GET 路由的假 app，取出 handler 直接调。 */
function fakeApp() {
  const routes = new Map();
  return {
    get: (path, handler) => routes.set(path, handler),
    post: (path, handler) => routes.set(path, handler),
    handler: (path) => routes.get(path),
  };
}

/** 造一个假请求上下文：带 surface session 头、能回 JSON。 */
function fakeCtx(hasSurface = true, params = {}) {
  const out = { body: null, status: 0 };
  const all = hasSurface ? { 'x-hana-app-surface-session': 'surface-1', host: '127.0.0.1:34567' } : { host: '127.0.0.1:34567' };
  return {
    out,
    req: {
      header: (name) => {
        if (name === undefined) return all;
        return all[String(name).toLowerCase()] || '';
      },
      query: () => ({}),
      param: (name) => params[name] || '',
    },
    json: (body, status) => { out.body = body; out.status = status || 200; return out; },
  };
}

/** 宿主那边的一次响应。 */
function hostResponse(packs) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ packs }),
    json: async () => ({ packs }),
  };
}

/** 宿主里一个包的形状（跟 /api/casual/stickers 返回的一致）。 */
function hostPack(id, name, count, editable) {
  return {
    id,
    name,
    editable,
    stickers: Array.from({ length: count }, (_, i) => ({ file: `f${i}.webp` })),
  };
}

/** resources 通道的假实现：只认 stickers 目录和 server-info.json。 */
function fakeResources({ serverInfo = null, packDirs = [] } = {}) {
  const read = async ({ path }) => {
    if (String(path).endsWith('server-info.json')) {
      if (!serverInfo) throw Object.assign(new Error('读不到'), { code: 'ENOENT' });
      return { content: JSON.stringify(serverInfo) };
    }
    if (String(path).endsWith('stickers.json')) {
      const dir = String(path).split(/[\\/]/).slice(-2, -1)[0];
      return { content: JSON.stringify({ name: `包-${dir}`, version: '1.0.0', stickers: [{ file: 'a.webp' }] }) };
    }
    throw Object.assign(new Error('读不到'), { code: 'ENOENT' });
  };
  const list = async () => packDirs.map((name) => ({ name }));
  return { read, list };
}

function fakeSdk({ fetch, resources }) {
  return {
    dataDir: DATA_DIR,
    resources,
    network: { fetch },
  };
}

test('分类列表：宿主接口通 → 用它，带上可加图标记', async () => {
  const app = fakeApp();
  registerHostStickerRoutes(app, fakeSdk({
    fetch: async () => hostResponse([
      hostPack('stickers-1', '收藏', 3, true),
      hostPack('pack-installed', '装进来的', 10, false),
    ]),
    resources: fakeResources({ serverInfo: { port: 12345, token: 'tok' } }),
  }));

  const ctx = fakeCtx();
  await app.handler('/api/host-stickers/packs')(ctx);

  assert.equal(ctx.out.status, 200);
  assert.equal(ctx.out.body.ok, true);
  assert.equal(ctx.out.body.source, 'host');
  assert.equal(ctx.out.body.writable, true);
  assert.deepEqual(ctx.out.body.warnings, []);
  assert.equal(ctx.out.body.packs.length, 2);
  assert.equal(ctx.out.body.packs[0].name, '收藏');
  assert.equal(ctx.out.body.packs[0].count, 3);
  assert.equal(ctx.out.body.packs[0].editable, true);
  assert.equal(ctx.out.body.packs[1].editable, false);
});

test('分类列表：宿主接口断 → 退回本机目录，至少还能看见分类', async () => {
  const app = fakeApp();
  registerHostStickerRoutes(app, fakeSdk({
    fetch: async () => { throw new Error('连接被拒'); },
    resources: fakeResources({ packDirs: ['pack-a', 'pack-b'] }),
  }));

  const ctx = fakeCtx();
  await app.handler('/api/host-stickers/packs')(ctx);

  assert.equal(ctx.out.status, 200);
  assert.equal(ctx.out.body.ok, true);
  assert.equal(ctx.out.body.source, 'fs');
  assert.equal(ctx.out.body.writable, false);
  assert.equal(ctx.out.body.packs.length, 2);
  assert.ok(ctx.out.body.warnings.length, '断路原因要带出来，不能闷着');
});

test('分类列表：宿主接口断、目录里也没包 → 空列表 + 说清楚为什么', async () => {
  const app = fakeApp();
  registerHostStickerRoutes(app, fakeSdk({
    fetch: async () => { throw new Error('连接被拒'); },
    resources: fakeResources({ packDirs: [] }),   // 本机一个包都没有
  }));

  const ctx = fakeCtx();
  await app.handler('/api/host-stickers/packs')(ctx);

  assert.equal(ctx.out.status, 200);
  assert.equal(ctx.out.body.ok, true);
  assert.deepEqual(ctx.out.body.packs, []);
  assert.equal(ctx.out.body.writable, false);
  assert.match(ctx.out.body.warnings.join(' '), /宿主接口没读通/);
});

test('分类列表：请求没带凭据标记也放行（宿主实测就是不带），但会记一笔诊断', async () => {
  const app = fakeApp();
  registerHostStickerRoutes(app, fakeSdk({
    fetch: async () => hostResponse([hostPack('stickers-1', '收藏', 3, true)]),
    resources: fakeResources({ serverInfo: { port: 12345, token: 'tok' } }),
  }));

  const ctx = fakeCtx(false);
  await app.handler('/api/host-stickers/packs')(ctx);

  assert.equal(ctx.out.status, 200);
  assert.equal(ctx.out.body.ok, true);
});

test('分类列表：不是本机来源的请求，不接', async () => {
  const app = fakeApp();
  registerHostStickerRoutes(app, fakeSdk({
    fetch: async () => hostResponse([]),
    resources: fakeResources(),
  }));

  const ctx = fakeCtx(true);
  ctx.req.header = (name) => (name.toLowerCase() === 'host' ? 'evil.example.com' : '');
  await app.handler('/api/host-stickers/packs')(ctx);

  assert.equal(ctx.out.body.ok, false);
  assert.match(ctx.out.body.error, /只接本机/);
});
