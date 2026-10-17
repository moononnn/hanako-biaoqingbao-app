import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// All fault injection stays inside this disposable gallery, before importing production modules.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-gallery-integrity-'));
process.env.BQB_DATA_DIR = root;
process.env.HANA_HOME = root;
const shared = await import('../lib/shared.js');
const { default: registerRoutes } = await import('../server/api.js');
const { execute: addSticker } = await import('../tools/add-sticker.js');
const { execute: updateTags } = await import('../tools/update-sticker-tags.js');
const { writeStoredZip } = await import('../lib/zip-images.js');
const { resetFingerprintIndex } = await import('../lib/image-fingerprints.js');
const handlers = new Map();
let onError;
let app;
app = new Proxy({}, { get(_target, method) {
  if (method === 'onError') return (handler) => { onError = handler; };
  return (route, handler) => { handlers.set(`${String(method).toUpperCase()} ${route}`, handler); return app; };
} });
await registerRoutes(app, { log: { info() {}, warn() {}, error() {} } });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const incomingPng = Buffer.concat([png, Buffer.from('new-picture')]);
const metaPath = path.join(root, 'stickers.json');
const images = path.join(root, 'stickers');
const original = { id: 'stk_001', file: 'stk_001.png', description: 'original', tags: { emotion: ['happy'], scene: [], keywords: [] } };
function reset(meta = [original]) {
  resetFingerprintIndex();
  for (const entry of fs.readdirSync(root)) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  fs.mkdirSync(images, { recursive: true });
  if (meta !== undefined) fs.writeFileSync(metaPath, typeof meta === 'string' ? meta : JSON.stringify(meta));
  fs.writeFileSync(path.join(images, original.file), png);
}
function bytes(file) { return fs.readFileSync(file); }
async function request(method, route, body = {}) {
  try { return await handlers.get(`${method} ${route}`)({ req: { json: async () => body, param: (key) => body[key], query: (key) => body[key] } }); }
  catch (error) { return onError(error); }
}
async function upload() {
  return request('POST', '/api', { action: 'upload', fileName: 'new.png', imageBase64: incomingPng.toString('base64') });
}
function toolResult(result) { return JSON.parse(result.content[0].text); }
after(() => fs.rmSync(root, { recursive: true, force: true }));

for (const bad of ['{broken', '{}', 'null']) {
  test(`unreadable index is not an empty gallery: ${bad}`, () => {
    reset(bad);
    assert.throws(() => shared.readMeta(), /图库|索引/);
    assert.equal(bytes(metaPath).toString(), bad);
  });
}

test('first-use missing index is empty, but a missing index with existing pictures is an error', () => {
  reset();
  fs.unlinkSync(metaPath);
  assert.throws(() => shared.readMeta(), /图库|索引/);
  fs.unlinkSync(path.join(images, original.file));
  assert.deepEqual(shared.readMeta(), []);
});

test('upload refuses corrupt metadata without replacing the index or old picture', async () => {
  reset('{broken');
  const before = bytes(path.join(images, original.file));
  const result = await (await upload()).json();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(bytes(metaPath).toString(), '{broken');
  assert.deepEqual(bytes(path.join(images, original.file)), before);
});

test('preference cleanup stops on index errors and preserves accumulated feedback', async () => {
  reset('{broken');
  const prefsFile = path.join(root, 'preferences.json');
  const prefs = { version: 1, users: { sample: { mappings: [{ emotion: 'happy', preferred_ids: ['stk_001'], vetoed_ids: ['stk_002'], dislike_counts: { stk_002: 2 } }] } } };
  fs.writeFileSync(prefsFile, JSON.stringify(prefs));
  const before = bytes(prefsFile);
  const result = await (await request('POST', '/api/preferences/cleanup')).json();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(bytes(prefsFile), before);
  assert.equal(bytes(metaPath).toString(), '{broken');
});

test('ID allocation skips picture IDs missing from an otherwise valid index', () => {
  reset([]);
  fs.writeFileSync(path.join(images, 'stk_002.gif'), 'orphan');
  assert.equal(shared.genId([]), 'stk_003');
});

test('upload preserves orphan pictures and still creates a new indexed picture', async () => {
  reset([]);
  const before = bytes(path.join(images, original.file));
  const result = await (await upload()).json();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.data.id, original.id);
  assert.deepEqual(bytes(path.join(images, original.file)), before);
  assert.equal(shared.readMeta()[0].id, result.data.id);
});

test('add tool stops on corrupt metadata without overwriting pictures', async () => {
  reset('{broken');
  const source = path.join(root, 'incoming.png');
  fs.writeFileSync(source, png);
  const result = toolResult(await addSticker({ sourcePath: source }));
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(bytes(metaPath).toString(), '{broken');
  assert.deepEqual(bytes(path.join(images, original.file)), png);
});

test('tag tool reports index damage, rather than an empty gallery', async () => {
  reset('{broken');
  const result = toolResult(await updateTags({ id: original.id, description: 'changed' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /读取失败|损坏|索引/);
  assert.equal(bytes(metaPath).toString(), '{broken');
});

test('first use can upload successfully without an index or picture directory', async () => {
  reset();
  fs.unlinkSync(metaPath);
  fs.rmSync(images, { recursive: true });
  const result = await (await upload()).json();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.id, 'stk_001');
  assert.deepEqual(bytes(path.join(images, result.data.file)), incomingPng);
  assert.equal(shared.readMeta().length, 1);
});

test('missing index still permits the existing installation-backup recovery path', () => {
  reset();
  fs.unlinkSync(metaPath);
  const backup = path.join(root, 'plugin-backups', 'biaoqingbao', 'sample');
  fs.mkdirSync(path.join(backup, 'data'), { recursive: true });
  fs.mkdirSync(path.join(backup, 'stickers'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'data', 'stickers.json'), JSON.stringify([original]));
  fs.writeFileSync(path.join(backup, 'stickers', original.file), png);
  assert.deepEqual(shared.readMeta(), [original]);
  assert.deepEqual(bytes(path.join(images, original.file)), png);
});

test('backup recovery rejects conflicting current pictures and preferences without overwriting', () => {
  reset();
  fs.unlinkSync(metaPath);
  const backup = path.join(root, 'plugin-backups', 'biaoqingbao', 'sample');
  fs.mkdirSync(path.join(backup, 'data'), { recursive: true });
  fs.mkdirSync(path.join(backup, 'stickers'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'data', 'stickers.json'), JSON.stringify([original]));
  fs.writeFileSync(path.join(backup, 'data', 'preferences.json'), '{"old":true}');
  fs.writeFileSync(path.join(root, 'preferences.json'), '{"current":true}');
  fs.writeFileSync(path.join(backup, 'stickers', original.file), Buffer.from('old backup image'));
  assert.throws(() => shared.readMeta(), { code: 'STICKER_META_UNREADABLE' });
  assert.equal(fs.existsSync(metaPath), false);
  assert.deepEqual(bytes(path.join(images, original.file)), png);
  assert.equal(bytes(path.join(root, 'preferences.json')).toString(), '{"current":true}');
});

test('an older backup cannot hide newer surviving pictures from the recovered index', () => {
  reset();
  fs.unlinkSync(metaPath);
  fs.writeFileSync(path.join(images, 'stk_002.png'), incomingPng);
  const backup = path.join(root, 'plugin-backups', 'biaoqingbao', 'sample');
  fs.mkdirSync(path.join(backup, 'data'), { recursive: true });
  fs.mkdirSync(path.join(backup, 'stickers'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'data', 'stickers.json'), JSON.stringify([original]));
  fs.writeFileSync(path.join(backup, 'stickers', original.file), png);
  assert.throws(() => shared.readMeta(), { code: 'STICKER_META_UNREADABLE' });
  assert.equal(fs.existsSync(metaPath), false);
  assert.deepEqual(bytes(path.join(images, 'stk_002.png')), incomingPng);
});

test('failed recovery never publishes an index before pictures, and cleans only new files', () => {
  reset();
  fs.unlinkSync(metaPath);
  fs.unlinkSync(path.join(images, original.file));
  const backup = path.join(root, 'plugin-backups', 'biaoqingbao', 'sample');
  fs.mkdirSync(path.join(backup, 'data'), { recursive: true });
  fs.mkdirSync(path.join(backup, 'stickers'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'data', 'stickers.json'), JSON.stringify([original]));
  fs.writeFileSync(path.join(backup, 'data', 'preferences.json'), '{"old":true}');
  fs.writeFileSync(path.join(backup, 'stickers', original.file), png);
  const copy = fs.copyFileSync;
  fs.copyFileSync = (from, to, ...args) => {
    if (String(to) === path.join(images, original.file)) throw Object.assign(new Error('simulated restore error'), { code: 'EIO' });
    return copy(from, to, ...args);
  };
  try { assert.throws(() => shared.readMeta(), { code: 'STICKER_META_UNREADABLE' }); }
  finally { fs.copyFileSync = copy; }
  assert.equal(fs.existsSync(metaPath), false);
  assert.equal(fs.existsSync(path.join(root, 'preferences.json')), false);
  assert.deepEqual(fs.readdirSync(images), []);
  assert.deepEqual(bytes(path.join(backup, 'stickers', original.file)), png);
  assert.deepEqual(shared.readMeta(), [original], 'retry after the failure completes the recovery');
});

test('unsupported atomic recovery commit fails safely without touching pre-existing pictures', () => {
  reset();
  fs.unlinkSync(metaPath);
  const backup = path.join(root, 'plugin-backups', 'biaoqingbao', 'sample');
  fs.mkdirSync(path.join(backup, 'data'), { recursive: true });
  fs.mkdirSync(path.join(backup, 'stickers'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'data', 'stickers.json'), JSON.stringify([original]));
  fs.writeFileSync(path.join(backup, 'data', 'preferences.json'), '{"old":true}');
  fs.writeFileSync(path.join(backup, 'stickers', original.file), png);
  const link = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('simulated unsupported link'), { code: 'ENOTSUP' }); };
  try { assert.throws(() => shared.readMeta(), { code: 'STICKER_META_UNREADABLE' }); }
  finally { fs.linkSync = link; }
  assert.equal(fs.existsSync(metaPath), false);
  assert.equal(fs.existsSync(path.join(root, 'preferences.json')), false);
  assert.deepEqual(bytes(path.join(images, original.file)), png);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
});

test('a read permission error is an error, never an empty gallery', () => {
  reset();
  const before = bytes(metaPath);
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (String(file) === metaPath) throw Object.assign(new Error('simulated denial'), { code: 'EACCES' });
    return read(file, ...args);
  };
  try { assert.throws(() => shared.readMeta(), { code: 'STICKER_META_UNREADABLE' }); }
  finally { fs.readFileSync = read; }
  assert.deepEqual(bytes(metaPath), before);
});

test('exclusive creation leaves an existing file untouched', () => {
  reset();
  assert.throws(() => shared.writeNewStickerFile(path.join(images, original.file), Buffer.from('replacement')), { code: 'EEXIST' });
  assert.deepEqual(bytes(path.join(images, original.file)), png);
});

test('a partial picture write removes only the newly created file', () => {
  reset();
  const target = path.join(images, 'stk_002.png');
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (typeof file === 'number') {
      write(file, Buffer.from('partial'));
      throw Object.assign(new Error('simulated picture write error'), { code: 'EIO' });
    }
    return write(file, ...args);
  };
  try { assert.throws(() => shared.writeNewStickerFile(target, png), /simulated/); }
  finally { fs.writeFileSync = write; }
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(bytes(path.join(images, original.file)), png);
});

test('upload EEXIST race does not clean up the other writer picture', async () => {
  reset();
  const target = path.join(images, 'stk_002.png');
  const other = Buffer.from('other writer');
  const open = fs.openSync;
  let injected = false;
  fs.openSync = (file, flags, ...args) => {
    if (String(file) === target && flags === 'wx' && !injected) {
      injected = true;
      fs.writeFileSync(target, other);
    }
    return open(file, flags, ...args);
  };
  let result;
  try { result = await (await upload()).json(); }
  finally { fs.openSync = open; }
  assert.equal(injected, true);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(bytes(target), other);
  assert.deepEqual(shared.readMeta(), [original]);
});

test('metadata commit failure cleans only this upload, preserving old index and pictures', async () => {
  reset();
  const before = bytes(metaPath);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === metaPath) throw Object.assign(new Error('simulated index commit error'), { code: 'EIO' });
    return rename(from, to);
  };
  let result;
  try { result = await (await upload()).json(); }
  finally { fs.renameSync = rename; }
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(bytes(metaPath), before);
  assert.deepEqual(bytes(path.join(images, original.file)), png);
  assert.deepEqual(fs.readdirSync(images), [original.file]);
});

test('ZIP import stops on a corrupt index before changing any picture', async () => {
  reset('{broken');
  const zip = path.join(root, 'incoming.zip');
  await writeStoredZip(zip, [{ name: 'new.png', data: png }]);
  const result = await (await request('POST', '/api', { action: 'import_zip', fileName: 'incoming.zip', zipBase64: bytes(zip).toString('base64') })).json();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(bytes(metaPath).toString(), '{broken');
  assert.deepEqual(fs.readdirSync(images), [original.file]);
  assert.deepEqual(bytes(path.join(images, original.file)), png);
});

test('normal ZIP import preserves orphan files and commits new metadata', async () => {
  reset([]);
  const zip = path.join(root, 'incoming.zip');
  await writeStoredZip(zip, [{ name: 'new.png', data: incomingPng }]);
  const result = await (await request('POST', '/api', { action: 'import_zip', fileName: 'incoming.zip', zipBase64: bytes(zip).toString('base64') })).json();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(bytes(path.join(images, original.file)), png);
  const meta = shared.readMeta();
  assert.equal(meta.length, 1);
  assert.equal(meta[0].id, 'stk_002');
  assert.deepEqual(bytes(path.join(images, meta[0].file)), incomingPng);
});

test('ZIP EEXIST race preserves a target never created by this import', async () => {
  reset([]);
  const zip = path.join(root, 'incoming.zip');
  await writeStoredZip(zip, [{ name: 'new.png', data: incomingPng }]);
  const target = path.join(images, 'stk_002.png');
  const other = Buffer.from('other writer');
  const open = fs.openSync;
  let injected = false;
  fs.openSync = (file, flags, ...args) => {
    if (String(file) === target && flags === 'wx' && !injected) {
      injected = true;
      fs.writeFileSync(target, other);
    }
    return open(file, flags, ...args);
  };
  let result;
  try {
    result = await (await request('POST', '/api', { action: 'import_zip', fileName: 'incoming.zip', zipBase64: bytes(zip).toString('base64') })).json();
  } finally { fs.openSync = open; }
  assert.equal(injected, true);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(bytes(target), other);
  assert.deepEqual(bytes(path.join(images, original.file)), png);
  assert.deepEqual(shared.readMeta(), []);
});

test('normal upload and queued tag updates preserve existing entries', async () => {
  reset();
  const result = await (await upload()).json();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.id, 'stk_002');
  await Promise.all([
    updateTags({ id: original.id, description: 'updated original' }),
    updateTags({ id: result.data.id, emotion: 'happy' }),
  ]);
  const meta = shared.readMeta();
  assert.equal(meta.length, 2);
  assert.equal(meta.find((s) => s.id === original.id).description, 'updated original');
  assert.deepEqual(meta.find((s) => s.id === result.data.id).tags.emotion, ['happy']);
});

test('corrupt metadata does not remove the entire batch route group during registration', async () => {
  reset('{broken');
  const seen = new Set();
  let fake;
  fake = new Proxy({}, { get(_target, method) {
    if (method === 'onError') return () => {};
    return (route) => { seen.add(`${String(method).toUpperCase()} ${route}`); return fake; };
  } });
  await registerRoutes(fake, { log: { info() {}, warn() {}, error() {} } });
  assert.ok(seen.has('POST /api/batch-auto-tag-untagged'));
  assert.equal(bytes(metaPath).toString(), '{broken');
});
