// tests/occasion-endpoint.test.mjs
// v0.8.5 - 场合锁的接口层验证：直接打真实路由，不经过界面也不依赖真实图库。
//
// 为什么要有这一层：结构断言只能证明「代码里有这行」，证明不了「这条链路真的通」。
// 这里挂的是真正的 server/api.js 路由，数据落在一次性目录，覆盖六件会静默出错的事：
//   1) 列表带不带锁（界面回填靠它）
//   2) 保存带锁能不能写进去
//   3) 老前端不带这个字段时，已有的锁会不会被冲掉（最阴的一条）
//   4) 传空串是不是真的取消了限制
//   5) 词表外的值会不会被挡住
//   6) 「按标签重判」判得准不准，且只算不写
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-occasion-api-'));
process.env.BQB_DATA_DIR = root;
process.env.HANA_HOME = root;

const metaPath = path.join(root, 'stickers.json');

const seed = [
  // 画面写着早安，带锁
  {
    id: 'stk_001',
    file: 'stk_001.png',
    description: '少女挥手微笑',
    semantic_description: '配文早安和太阳，适合早晨向朋友问好',
    tags: { emotion: ['元气'], scene: ['早安'], keywords: ['早安'] },
    occasion: ['早安'],
  },
  // 只有随手打的早安标签，画面没有字：不该被推断成锁
  {
    id: 'stk_002',
    file: 'stk_002.png',
    description: '白猫侧躺翻肚皮',
    semantic_description: '适合撒娇卖萌时发',
    tags: { emotion: ['可爱'], scene: ['早安'], keywords: ['猫咪'] },
  },
  // 画面写着晚安，当前没锁：重判应该判得出来
  {
    id: 'stk_003',
    file: 'stk_003.png',
    description: '女仆双手交握温柔微笑',
    semantic_description: '配文晚安~，适合结束聊天时发',
    tags: { emotion: ['温柔'], scene: ['晚安'], keywords: ['晚安'] },
  },
];

fs.writeFileSync(metaPath, JSON.stringify(seed, null, 2));

const handlers = new Map();
let onError;
let app;
app = new Proxy({}, {
  get(_target, method) {
    if (method === 'onError') return (handler) => { onError = handler; };
    return (route, handler) => { handlers.set(`${String(method).toUpperCase()} ${route}`, handler); return app; };
  },
});
const { default: registerRoutes } = await import('../server/api.js');
await registerRoutes(app, { log: { info() {}, warn() {}, error() {} } });

async function request(method, route, body = {}) {
  const handler = handlers.get(`${method} ${route}`);
  assert.ok(handler, `没有这条路由: ${method} ${route}`);
  try {
    const res = await handler({ req: { json: async () => body, param: (k) => body[k], query: (k) => body[k] } });
    return res && typeof res.json === 'function' ? await res.json() : res;
  } catch (error) {
    const handled = onError(error);
    return handled && typeof handled.json === 'function' ? await handled.json() : Promise.reject(error);
  }
}

async function occasionOf(id) {
  const res = await request('GET', '/api/list', { id });
  return (res.data?.[0]?.occasion) || [];
}

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('列表把锁带出来，界面回填靠它', async () => {
  assert.deepEqual(await occasionOf('stk_001'), ['早安']);
  assert.deepEqual(await occasionOf('stk_003'), [], '没锁的图不该凭空多出字段');
});

test('保存时带 occasion 能写进去，并回显实际存下的值', async () => {
  const res = await request('POST', '/api', { action: 'update', id: 'stk_001', occasion: '早安,晚安' });
  assert.equal(res.ok, true);
  assert.deepEqual([...res.data.occasion].sort(), ['早安', '晚安']);
  assert.deepEqual([...(await occasionOf('stk_001'))].sort(), ['早安', '晚安']);
});

test('老前端不带这个字段时，已有的锁不许被冲掉', async () => {
  // 只改描述，payload 里没有 occasion（0.8.3 之前的界面就是这样发的）
  await request('POST', '/api', { action: 'update', id: 'stk_001', description: '少女挥手微笑（改过）' });
  assert.deepEqual([...(await occasionOf('stk_001'))].sort(), ['早安', '晚安'], '锁被静默冲掉了');
});

test('传空串是取消限制，字段要摘掉而不是留空数组', async () => {
  await request('POST', '/api', { action: 'update', id: 'stk_001', occasion: '' });
  const list = await request('GET', '/api/list', { id: 'stk_001' });
  assert.ok(!Object.prototype.hasOwnProperty.call(list.data[0], 'occasion'), '空值应该删掉字段');
});

test('词表外的值不落库，并如实回显空', async () => {
  const res = await request('POST', '/api', { action: 'update', id: 'stk_001', occasion: '工作日' });
  assert.deepEqual(res.data.occasion, []);
  assert.deepEqual(await occasionOf('stk_001'), []);
});

test('同一场合的不同说法会被归一', async () => {
  await request('POST', '/api', { action: 'update', id: 'stk_001', occasion: '早上好' });
  assert.deepEqual(await occasionOf('stk_001'), ['早安']);
});

test('按标签重判：画面写了字的判得出来', async () => {
  const res = await request('POST', '/api', { action: 'infer_occasion', id: 'stk_003' });
  assert.deepEqual(res.data.occasion, ['晚安']);
});

test('按标签重判：只有随手标签、画面没字的不判', async () => {
  const res = await request('POST', '/api', { action: 'infer_occasion', id: 'stk_002' });
  assert.deepEqual(res.data.occasion, []);
});

test('按标签重判只算不写，落库仍要用户点保存', async () => {
  const before = await occasionOf('stk_003');
  await request('POST', '/api', { action: 'infer_occasion', id: 'stk_003' });
  assert.deepEqual(await occasionOf('stk_003'), before, '重判不该直接改库');
});

test('缺 ID 时给可读错误，不抛 500', async () => {
  const res = await request('POST', '/api', { action: 'update', occasion: '早安' });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /ID|id/);
});