// 小图在卡片里画多高：上下白边的根因回归测试
//
// 2026-10-25 实机：一张 120x110 的小图，卡片宽 192（三个反馈按钮撑的），
// 旧算法按内容宽 180 去算高度 → 165px，可图片本身只画 110px 高，
// 多出来的 55px 在宿主框里就被均分成上下两条白边。
// 这里守的就是「不放大时按图片自己的宽度算」这一条。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const viewSource = fs.readFileSync(new URL('../ui/assets/message-card-view.js', import.meta.url), 'utf8');
const start = viewSource.indexOf('  function imageDrawHeight(');
const end = viewSource.indexOf('\n  }\n', start) + '\n  }'.length;
assert.ok(start >= 0 && end > start, '找不到 imageDrawHeight，卡片视图改过就要同步改这个测试');
const imageDrawHeight = vm.runInNewContext(
  '(' + viewSource.slice(start, end).trim() + ')',
  { CARD_MAX_IMAGE_HEIGHT: 320 },
);

test('小图不放大：宽度取图片自己的宽，不再是内容宽', () => {
  // 内容宽 180、图片 120x110、不放大 → 画的还是 110 高（旧算法给 165，多出来就是白边）
  assert.equal(imageDrawHeight(180, 120, 110, false), 110);
});

test('开了放大：按内容宽铺满后再按比例算高', () => {
  assert.equal(imageDrawHeight(180, 120, 110, true), 165);
});

test('图比内容宽时，还是按内容宽收着算', () => {
  assert.equal(imageDrawHeight(180, 600, 400, false), 120);
});

test('竖图有 320 的高度上限', () => {
  assert.equal(imageDrawHeight(180, 100, 1000, true), 320);
});

test('自然尺寸还没量到时返回 0，交给调用方退回渲染高度', () => {
  assert.equal(imageDrawHeight(180, 0, 0, false), 0);
  assert.equal(imageDrawHeight(180, 120, 0, false), 0);
});
