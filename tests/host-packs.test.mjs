// tests/host-packs.test.mjs
//
// 宿主表情包适配层（lib/host-packs.js）。
//
// 为什么必须有这组测试：这层要把宿主另一套表情包的目录读进来，而 App 子进程
// 对 <HANA_HOME> 的裸 fs 是 ERR_ACCESS_DENIED（2026-10-31 真机实测），
// 全部读操作只能靠 ctx.resources。这条通道最容易出的错是「形状认错」：
// list 回来不是字符串数组、read 回来 content 是 Buffer 不是 string、
// .notes 缺了就把整包判死。任何一种都会让面板显示空，而且不报错。
//
// 覆盖：
//   1. 正常读：包清单 + .notes 备注 + hostId 拼装
//   2. 备注缺失 / 清单内联备注优先
//   3. 目录不存在（no-packs）与授权被拒（list-failed）分开
//   4. 点开头目录（.notes）不当包；坏包只坏自己
//   5. 缓存 TTL、失效、并发合并
//   6. 60 张注入上限的截断计算

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readHostPacks,
  invalidateHostPacks,
  summarizeHostPacks,
  isHostStickerId,
  HOST_INJECT_LIMIT,
} from '../lib/host-packs.js';
import { deliverCompose, normalizeCompose } from '../lib/sticker-input-panel.js';

const DATA_DIR = path.join('X:', 'hana', 'app-data', 'biaoqingbao-app');
const HOME = path.join('X:', 'hana');
const ROOT = path.join(HOME, 'stickers');

const packDir = (id) => path.join(ROOT, id);
const manifestPath = (id) => path.join(packDir(id), 'stickers.json');
const notesPath = (id) => path.join(ROOT, '.notes', `${id}.json`);

/**
 * 假宿主：只实现这一层用到的方法。
 * dirs 是「目录路径 → 子项名数组」，files 是「文件路径 → 文本内容」。
 * contentAsBuffer 用来模拟真实宿主把 content 回成 Buffer 的情形。
 */
function fakeHost({ dirs = {}, files = {}, contentAsBuffer = false, denyList = false, denyRead = false } = {}) {
  const calls = { list: 0, read: 0 };
  const accessDenied = () => {
    const e = new Error('ERR_ACCESS_DENIED Access to this API has been restricted.');
    e.code = 'ERR_ACCESS_DENIED';
    return e;
  };
  const notFound = () => {
    const e = new Error('ENOENT: no such file or directory');
    e.code = 'ENOENT';
    return e;
  };
  return {
    calls,
    async list(ref) {
      calls.list += 1;
      if (denyList) throw accessDenied();
      const hit = dirs[ref.path];
      if (!hit) throw notFound();
      return [...hit];
    },
    async read(ref) {
      calls.read += 1;
      if (denyRead) throw accessDenied();
      const hit = files[ref.path];
      if (hit === undefined) throw notFound();
      return { content: contentAsBuffer ? Buffer.from(hit, 'utf8') : hit, version: 1 };
    },
  };
}

function baseFiles() {
  return {
    [manifestPath('pack-a')]: JSON.stringify({
      stickerPackVersion: 1,
      id: 'pack-a',
      name: '我的收藏',
      version: '1.0.0',
      stickers: [{ file: 'a1.webp' }, { file: 'a2.webp' }],
    }),
    [notesPath('pack-a')]: JSON.stringify({
      'a1.webp': { note: '斜眼看着不说话，用来表达无语', tags: ['无语'] },
      'a2.webp': { note: '举手欢呼，用在庆祝', tags: ['开心', '庆祝'] },
    }),
  };
}

// ── 1. 正常读 ────────────────────────────────────────────

test('读到包清单与备注：hostId 拼成 <packId>/<file>，note 和 tags 都在', async () => {
  invalidateHostPacks();
  const host = fakeHost({
    dirs: { [ROOT]: ['.notes', 'pack-a'] },
    files: baseFiles(),
  });
  const data = await readHostPacks({ resources: host, dataDir: DATA_DIR });

  assert.equal(data.available, true);
  assert.equal(data.reason, 'ok');
  assert.equal(data.packs.length, 1);
  assert.equal(data.total, 2);

  const first = data.stickers[0];
  assert.equal(first.hostId, 'pack-a/a1.webp');
  assert.equal(first.packId, 'pack-a');
  assert.equal(first.file, 'a1.webp');
  assert.equal(first.source, 'host');
  assert.equal(first.note, '斜眼看着不说话，用来表达无语');
  assert.deepEqual(first.tags, ['无语']);
  assert.equal(data.packs[0].name, '我的收藏');
});

test('宿主把 content 回成 Buffer 时也能解出文本', async () => {
  invalidateHostPacks();
  const host = fakeHost({
    dirs: { [ROOT]: ['pack-a'] },
    files: baseFiles(),
    contentAsBuffer: true,
  });
  const data = await readHostPacks({ resources: host, dataDir: DATA_DIR });
  assert.equal(data.total, 2);
  assert.equal(data.stickers[0].note, '斜眼看着不说话，用来表达无语');
});

// ── 2. 备注缺失 / 内联优先 ────────────────────────────────

test('没有 .notes 时图仍然可用，note 退化成空串而不是整包丢掉', async () => {
  invalidateHostPacks();
  const files = baseFiles();
  delete files[notesPath('pack-a')];
  const host = fakeHost({ dirs: { [ROOT]: ['pack-a'] }, files });
  const data = await readHostPacks({ resources: host, dataDir: DATA_DIR });

  assert.equal(data.total, 2);
  assert.equal(data.stickers[0].note, '');
  assert.deepEqual(data.stickers[0].tags, []);
});

test('清单里内联的 note 优先于 .notes', async () => {
  invalidateHostPacks();
  const files = baseFiles();
  files[manifestPath('pack-a')] = JSON.stringify({
    id: 'pack-a',
    name: '我的收藏',
    stickers: [{ file: 'a1.webp', note: '清单里的说法' }],
  });
  const host = fakeHost({ dirs: { [ROOT]: ['pack-a'] }, files });
  const data = await readHostPacks({ resources: host, dataDir: DATA_DIR });
  assert.equal(data.stickers[0].note, '清单里的说法');
});

// ── 3. 目录不存在 vs 授权被拒 ────────────────────────────

test('用户一个包都没装：no-packs，不算错误', async () => {
  invalidateHostPacks();
  const host = fakeHost({ dirs: {}, files: {} });
  const data = await readHostPacks({ resources: host, dataDir: DATA_DIR });

  assert.equal(data.available, false);
  assert.equal(data.reason, 'no-packs');
  assert.deepEqual(data.errors, []);
});

test('授权被拒：list-failed 并记下原因，不能伪装成没装包', async () => {
  invalidateHostPacks();
  const host = fakeHost({ denyList: true });
  const data = await readHostPacks({ resources: host, dataDir: DATA_DIR });

  assert.equal(data.available, false);
  assert.equal(data.reason, 'list-failed');
  assert.equal(data.errors.length, 1);
  assert.match(data.errors[0], /ERR_ACCESS_DENIED/);
});

test('没有 resources 通道时明确报 no-resources', async () => {
  invalidateHostPacks();
  const data = await readHostPacks({ resources: null, dataDir: DATA_DIR });
  assert.equal(data.available, false);
  assert.equal(data.reason, 'no-resources');
});

// ── 4. 点开头目录与坏包 ─────────────────────────────────

test('.notes 不当包，坏包只影响自己', async () => {
  invalidateHostPacks();
  const files = {
    ...baseFiles(),
    [manifestPath('broken')]: '{ 这不是 JSON',
    [manifestPath('empty-pack')]: JSON.stringify({ id: 'empty-pack', name: '空包', stickers: [] }),
  };
  const host = fakeHost({
    dirs: { [ROOT]: ['.notes', 'pack-a', 'broken', 'empty-pack', '.tmp'] },
    files,
  });
  const data = await readHostPacks({ resources: host, dataDir: DATA_DIR });

  assert.equal(data.packs.length, 1, '只有 pack-a 是有效包');
  assert.equal(data.packs[0].id, 'pack-a');
  assert.equal(data.errors.length, 1, '坏包记一条错误');
  assert.equal(data.errors[0].pack, 'broken');
  assert.equal(data.total, 2, '空包不进清单，但不影响别的包');
});

test('Agent 自有收藏排在前面', async () => {
  invalidateHostPacks();
  const files = {
    ...baseFiles(),
    [manifestPath('zzz-pack')]: JSON.stringify({ id: 'zzz-pack', name: '外部包', stickers: [{ file: 'z1.png' }] }),
    [manifestPath('stickers-own')]: JSON.stringify({ id: 'stickers-own', name: '收藏', stickers: [{ file: 'o1.webp' }] }),
  };
  const host = fakeHost({ dirs: { [ROOT]: ['zzz-pack', 'stickers-own'] }, files });
  const data = await readHostPacks({ resources: host, dataDir: DATA_DIR });

  assert.deepEqual(data.packs.map((p) => p.id), ['stickers-own', 'zzz-pack']);
});

// ── 5. 缓存 ─────────────────────────────────────────────

test('TTL 内复用缓存，失效后重扫', async () => {
  invalidateHostPacks();
  const host = fakeHost({ dirs: { [ROOT]: ['pack-a'] }, files: baseFiles() });

  const first = await readHostPacks({ resources: host, dataDir: DATA_DIR });
  const second = await readHostPacks({ resources: host, dataDir: DATA_DIR });
  assert.equal(first.readAt, second.readAt, 'TTL 内应是同一份');
  assert.equal(host.calls.list, 1);

  invalidateHostPacks();
  await readHostPacks({ resources: host, dataDir: DATA_DIR });
  assert.equal(host.calls.list, 2, '失效后应重扫一遍');
});

test('并发调用共用一次扫描', async () => {
  invalidateHostPacks();
  const host = fakeHost({ dirs: { [ROOT]: ['pack-a'] }, files: baseFiles() });
  const [a, b, c] = await Promise.all([
    readHostPacks({ resources: host, dataDir: DATA_DIR }),
    readHostPacks({ resources: host, dataDir: DATA_DIR }),
    readHostPacks({ resources: host, dataDir: DATA_DIR }),
  ]);
  assert.equal(a.readAt, b.readAt);
  assert.equal(b.readAt, c.readAt);
  assert.equal(host.calls.list, 1);
});

test('force 绕过缓存', async () => {
  invalidateHostPacks();
  const host = fakeHost({ dirs: { [ROOT]: ['pack-a'] }, files: baseFiles() });
  await readHostPacks({ resources: host, dataDir: DATA_DIR });
  await readHostPacks({ resources: host, dataDir: DATA_DIR, force: true });
  assert.equal(host.calls.list, 2);
});

// ── 6. 60 张上限 ────────────────────────────────────────

test('超过宿主注入上限的图仍然进清单，但标出截断数', async () => {
  invalidateHostPacks();
  const stickers = Array.from({ length: HOST_INJECT_LIMIT + 5 }, (_, i) => ({ file: `s${i}.png` }));
  const host = fakeHost({
    dirs: { [ROOT]: ['big'] },
    files: { [manifestPath('big')]: JSON.stringify({ id: 'big', name: '大包', stickers }) },
  });
  const data = await readHostPacks({ resources: host, dataDir: DATA_DIR });

  assert.equal(data.total, HOST_INJECT_LIMIT + 5);
  assert.equal(data.injectable.length, HOST_INJECT_LIMIT);
  assert.equal(data.truncated, 5);
});

// ── 7. 摘要 ─────────────────────────────────────────────

test('摘要能看出包数、张数和不可用原因', async () => {
  invalidateHostPacks();
  const host = fakeHost({ dirs: { [ROOT]: ['pack-a'] }, files: baseFiles() });
  const data = await readHostPacks({ resources: host, dataDir: DATA_DIR });
  assert.match(summarizeHostPacks(data), /packs=1/);
  assert.match(summarizeHostPacks(data), /stickers=2/);
  assert.match(summarizeHostPacks(null), /未扫描/);
});

// ── 8. 发送分流 ─────────────────────────────────────

function sendFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-send-'));
  const payloads = [];
  const sdk = { dataDir, bus: { request: async (verb, body) => { payloads.push({ verb, body }); return { ok: true }; } } };
  return { sdk, payloads, dataDir };
}

const HOST_ID = 'pack-a/a1.webp';

function composeOf(ids) {
  return normalizeCompose({ stickerIds: ids, text: '', requestId: 'req-abcdefgh' });
}

test('宿主 id 只认出 <packId>/<file> 这一种形状', () => {
  assert.equal(isHostStickerId(HOST_ID), true);
  assert.equal(isHostStickerId('stk_009'), false, '本应用图库的 id 不带斜杠');
  assert.equal(isHostStickerId('pack-a/../../secret.webp'), false, '不许路径穿越');
  assert.equal(isHostStickerId('pack-a/'), false);
  assert.equal(isHostStickerId('pack-a/a1.exe'), false, '不是图片扩展名');
});

test('发送时宿主图走 findHostSticker 取字节，不碰本应用图库', async (t) => {
  const f = sendFixture(); t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  const bytes = Buffer.from('RIFF0000WEBP');
  const asked = [];
  const result = await deliverCompose({
    sdk: f.sdk, sessionId: 'sess_x', input: composeOf([HOST_ID]),
    findSticker: () => { throw new Error('不该走本应用图库'); },
    findHostSticker: async (id) => { asked.push(id); return { ok: true, bytes, mimeType: 'image/webp', sticker: { id, file: 'a1.webp', source: 'host' } }; },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(asked, [HOST_ID]);
  assert.equal(f.payloads.length, 1, '只有一张图，没有文字就不发第二条');
  const sent = f.payloads[0];
  assert.equal(sent.verb, 'session:send-custom');
  assert.equal(sent.body.triggerTurn, true, '纯图重发要唤起一轮');
});

test('宿主图读失败时整批拦下，不会先发一半', async (t) => {
  const f = sendFixture(); t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await assert.rejects(
    deliverCompose({
      sdk: f.sdk, sessionId: 'sess_x', input: composeOf([HOST_ID]),
      findSticker: () => null,
      findHostSticker: async () => ({ ok: false, error: '宿主资源通道不可用' }),
    }),
    /宿主资源通道不可用/,
  );
  assert.equal(f.payloads.length, 0);
});

test('没接宿主通道时宿主 id 不会静默变成别的图', async (t) => {
  const f = sendFixture(); t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await assert.rejects(
    deliverCompose({ sdk: f.sdk, sessionId: 'sess_x', input: composeOf([HOST_ID]), findSticker: () => null }),
    /已被删除/,
  );
  assert.equal(f.payloads.length, 0);
});
