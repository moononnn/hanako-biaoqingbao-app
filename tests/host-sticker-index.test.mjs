// tests/host-sticker-index.test.mjs
// 宿主表情包去重索引（lib/host-sticker-index.js）。
// 索引只是加速和辅助判断：缺了不影响发图，只是要多传一次再比字节。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  emptyIndex,
  loadIndex,
  saveIndex,
  reconcile,
  lookup,
  record,
  countFor,
} from '../lib/host-sticker-index.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bq-host-index-'));
}

test('空索引：结构对，packs 是对象', () => {
  const index = emptyIndex();
  assert.equal(index.version, 1);
  assert.deepEqual(index.packs, {});
});

test('写进去再读出来，记的还在', () => {
  const dir = tempDir();
  const index = emptyIndex();
  record(index, 'pack-1', 'hash-a', 'a.webp');
  assert.equal(saveIndex(dir, index), true);

  const loaded = loadIndex(dir);
  assert.equal(lookup(loaded, 'pack-1', 'hash-a'), 'a.webp');
  assert.equal(countFor(loaded, 'pack-1'), 1);
});

test('读不到索引文件就当空索引，不报错', () => {
  const index = loadIndex(path.join(tempDir(), 'nope'));
  assert.deepEqual(index.packs, {});
});

test('索引文件坏了也当空索引', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'host-sticker-index.json'), '{ 坏掉的 json');
  const index = loadIndex(dir);
  assert.deepEqual(index.packs, {});
});

test('查一个没记过的：返回空串', () => {
  const index = emptyIndex();
  record(index, 'pack-1', 'hash-a', 'a.webp');
  assert.equal(lookup(index, 'pack-1', 'hash-b'), '');
  assert.equal(lookup(index, 'pack-2', 'hash-a'), '');
});

test('对账：宿主里已经删掉的记录要清掉（不然会误判成重复）', () => {
  const index = emptyIndex();
  record(index, 'pack-1', 'hash-a', 'a.webp');
  record(index, 'pack-1', 'hash-b', 'b.webp');
  const dropped = reconcile(index, 'pack-1', ['a.webp']);
  assert.equal(dropped, 1);
  assert.equal(lookup(index, 'pack-1', 'hash-b'), '');
  assert.equal(lookup(index, 'pack-1', 'hash-a'), 'a.webp');
});

test('对账：这个包的记录全没了，包本身也从索引里抹掉', () => {
  const index = emptyIndex();
  record(index, 'pack-1', 'hash-a', 'a.webp');
  reconcile(index, 'pack-1', []);
  assert.equal(index.packs['pack-1'], undefined);
});

test('对账：包里没有这个包 → 不动索引', () => {
  const index = emptyIndex();
  record(index, 'pack-1', 'hash-a', 'a.webp');
  const dropped = reconcile(index, 'pack-x', ['a.webp']);
  assert.equal(dropped, 0);
  assert.equal(lookup(index, 'pack-1', 'hash-a'), 'a.webp');
});

test('记一笔：空哈希或空文件名不记', () => {
  const index = emptyIndex();
  record(index, 'pack-1', '', 'a.webp');
  record(index, 'pack-1', 'hash-a', '');
  assert.equal(countFor(index, 'pack-1'), 0);
});
