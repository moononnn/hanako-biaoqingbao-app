import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newestStickersFirst } from '../lib/sticker-order.js';
import { moveSticker } from '../ui/assets/sticker-reorder.js';

test('newest ingestion first, not tagging time, without changing the source array', () => {
  const items = [
    { id: 'old', added_at: '2026-01-01T00:00:00Z', tagged_at: '2026-12-01T00:00:00Z' },
    { id: 'new', added_at: '2026-10-20T00:00:00Z', tagged_at: '2026-10-20T00:00:00Z' },
    { id: 'middle', added_at: '2026-07-01T00:00:00Z' },
  ];
  const before = JSON.stringify(items);
  assert.deepEqual(newestStickersFirst(items).map(item => item.id), ['new', 'middle', 'old']);
  assert.equal(JSON.stringify(items), before);
});
test('missing/broken dates sink; equal dates have stable id tie-break', () => {
  const items = [{ id: 'a' }, { id: 'b', added_at: 'invalid' }, { id: 'c', added_at: '2026-10-20' }, { id: 'd', added_at: '2026-10-20' }];
  const first = newestStickersFirst(items).map(item => item.id);
  assert.deepEqual(first, ['d', 'c', 'b', 'a']);
  assert.deepEqual(newestStickersFirst([...items].reverse()).map(item => item.id), first);
});
test('drag moves either direction without mutating input, and ignores invalid drops', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(moveSticker(ids, 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(moveSticker(ids, 'c', 'a'), ['c', 'a', 'b']);
  assert.equal(moveSticker(ids, 'a', 'a'), null);
  assert.equal(moveSticker(ids, 'missing', 'a'), null);
  assert.deepEqual(ids, ['a', 'b', 'c']);
});
test('numeric timestamps and empty input', () => {
  assert.deepEqual(newestStickersFirst([]), []);
  assert.deepEqual(newestStickersFirst([{ id: 'old', added_at: 1000 }, { id: 'new', added_at: 2000 }]).map(item => item.id), ['new', 'old']);
});
test('catalog stays newest first; paper-plane pinned list keeps saved manual order', () => {
  const server = fs.readFileSync(new URL('../lib/ball.js', import.meta.url), 'utf8');
  const python = fs.readFileSync(new URL('../python/ball_app.py', import.meta.url), 'utf8');
  assert.match(server, /stickers: newestStickersFirst\(readMeta\(\)\)\.map\(serializedSticker\)/);
  // 收藏顺序必须来自手动保存的 pinnedIds（不重排成 newest）；带分类后这步展开成多行，
  // 所以盯住来源和输出两端，而不是中间那句 map 的具体排版。
  assert.match(server, /const stickers = config\.pinnedIds\s*\.map\(/);
  assert.match(server, /pinnedIds: stickers\.map\(item => item\.id\)/);
  // 拖拽排序仍接 _on_sticker_drag，但按分类筛选时禁用（筛选态下重排语义不成立）
  assert.ok(python.includes('on_drag = None if self._category_filter else self._on_sticker_drag'));
});
