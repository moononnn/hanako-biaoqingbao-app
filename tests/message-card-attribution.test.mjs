// v0.1.24 回归：伙伴配图 与 用户发图 的注入文案必须分开（归属问题）
//
// 背景：App 迁移时两张卡共用了一段「请结合这些语义理解用户消息」的文案。
// 结果伙伴自己发出去的表情包，在下一轮被读成「用户发来的图」——
// 伙伴会把自己的图当成用户抛来的新话题来回应，也会说「你发来的这张图」。
// 插件版本来有专门一段（「你发出了这张表情包…这张图就是你自己的表达」），迁移时没接上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSemanticContext, buildPartnerStickerContext } from '../lib/ball-core.js';

const sticker = {
  description: '卡通角色闭眼大笑露出小虎牙',
  tags: { emotion: ['开心'], scene: ['闲聊'], keywords: ['大笑'] },
};

test('伙伴配图的注入文案把归属写成「你自己发出的」，不再说「理解用户消息」', () => {
  const ctx = buildPartnerStickerContext({ sticker });
  assert.match(ctx, /你自己刚发出/, '必须写明这张图是伙伴自己发出的');
  assert.ok(!/理解用户消息/.test(ctx), '不得沿用纸飞机那套「理解用户消息」的归属');
  assert.ok(ctx.includes('卡通角色闭眼大笑露出小虎牙'), '档案里要带图片描述');
  assert.match(ctx, /别把它当成新话题/, '要提示别把这张图当新话题回应');
});

test('纸飞机（用户发来的图）文案保持原样', () => {
  const ctx = buildSemanticContext({ sticker });
  assert.match(ctx, /理解用户消息/, '用户发的图仍然是「结合语义理解用户消息」');
});

test('卡片 payload 按 sender 选择注入文案（两张卡不再共用同一段）', () => {
  const src = fs.readFileSync(new URL('../lib/ball-message-card.js', import.meta.url), 'utf8');
  assert.ok(src.includes('isPartner ? buildPartnerStickerContext({ sticker }) : buildSemanticContext({ sticker })'),
    'payload 必须按 sender 分支选文案');
  assert.ok(src.includes("isPartner ? '你刚刚发出了这张表情包。'"),
    '伙伴卡的首句要写明是它自己发出的，不能复述图片描述当正文');
});
