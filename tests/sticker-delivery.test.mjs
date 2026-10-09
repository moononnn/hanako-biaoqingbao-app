// tests/sticker-delivery.test.mjs
//
// 伙伴配图投递（v0.1.13）。盯的是 App 里唯一活的那条发图通道：
// 插件版靠 details.media / deferred 原生块，在 App 里都被桥接层吃掉，
// 只能用 session:send-custom（纸飞机同款）。

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';

const dataDir = path.join(os.tmpdir(), `bqb-delivery-test-${process.pid}`);
mkdirSync(path.join(dataDir, 'ball-message-cards'), { recursive: true });
process.env.BQB_DATA_DIR = dataDir;

const {
  extractSelectedSticker,
  deliverStickerToSession,
  __resetSessionIdCacheForTests,
} = await import('../lib/sticker-delivery.js');

// 模块级会话清单缓存会跨用例干扰，每个用例前清一次
beforeEach(() => { __resetSessionIdCacheForTests(); });

// 1x1 的真 PNG，够当图片内容用
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const imgPath = path.join(dataDir, 'test.png');
writeFileSync(imgPath, PNG);

// ── 识别工具返回 ──────────────────────────────────────────

test('认出「真的选中了一张图」', () => {
  const result = {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: true,
        data: { action: 'selected', sticker: { id: 'stk_1', filePath: imgPath, description: '测试图' } },
      }),
    }],
  };
  assert.equal(extractSelectedSticker(result)?.id, 'stk_1');
});

test('不是 selected 的返回一律不认', () => {
  const mk = (data) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] });
  assert.equal(extractSelectedSticker(mk({ action: 'no_match' })), null);
  assert.equal(extractSelectedSticker(mk({ action: 'skipped' })), null);
  assert.equal(extractSelectedSticker(mk({ action: 'selected', sticker: {} })), null, '没有文件路径不算选中');
  assert.equal(extractSelectedSticker({ content: [{ type: 'text', text: '不是 JSON' }] }), null);
  assert.equal(
    extractSelectedSticker({
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: false, data: { action: 'selected', sticker: { filePath: 'x' } } }),
      }],
    }),
    null,
    'ok=false 不算选中',
  );
});

// ── 投递 ──────────────────────────────────────────────────

// 宿主的会话清单里一个会话长这样（真实返回就带 sess_ 编号）
function fakeSdk({ sessionId = 'sess_test_1', path: p = 'C:/x/agents/hanako/sessions/a.jsonl', onSend = () => ({ ok: true, entryId: 'e_1' }) } = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      bus: {
        request: async (type, payload) => {
          calls.push({ type, payload });
          if (type === 'session:list') return [{ path: p, title: '测试会话', sessionId }];
          if (type === 'session:send-custom') return onSend(payload);
          return { ok: false };
        },
      },
    },
  };
}

test('投递：走 session:send-custom，卡片 id 正确，且不触发新一轮', async () => {
  const p = 'C:/x/agents/hanako/sessions/a.jsonl';
  const { sdk, calls } = fakeSdk({ path: p });
  const r = await deliverStickerToSession({
    sdk,
    dataDir,
    sessionPath: p,
    sticker: { id: 'stk_9', filePath: imgPath, description: '被萌到' },
    text: '被萌到',
  });
  assert.equal(r.ok, true);
  assert.equal(r.entryId, 'e_1');
  const send = calls.find((c) => c.type === 'session:send-custom');
  assert.ok(send, '必须走 send-custom');
  assert.equal(send.payload.customType, 'partner-sticker', '伙伴配图必须走自己的 customType，不能复用用户那张卡的标题');
  assert.equal(send.payload.triggerTurn, false, '伙伴配图不该再触发一轮');
  assert.equal(send.payload.display, true);
  assert.match(send.payload.details.cardInstanceId, /^a_[0-9a-f]{20}$/);
  // v0.1.44：伙伴配的图不再把像素写进会话记录（base64 会触发宿主 1MB 投影，
  // 之后那个窗口每轮都报 Invalid base64）。改成只送一行路径引用。
  assert.equal(send.payload.content.some((x) => x.type === 'image'), false, '伙伴配的图不该把像素写进会话记录');
  assert.ok(send.payload.content.some((x) => x.type === 'text' && /\[attached_image: /.test(x.text)), '必须留一行图片路径引用');
  assert.ok(send.payload.content.some((x) => x.type === 'text' && /被萌到/.test(x.text)));
});

test('投递：同一段对话 + 同一张图重复调用，不会发两遍', async () => {
  let sendCount = 0;
  const p = 'C:/x/agents/hanako/sessions/b.jsonl';
  const { sdk } = fakeSdk({ sessionId: 'sess_test_2', path: p, onSend: () => { sendCount += 1; return { ok: true, entryId: 'e_2' }; } });
  const args = { sdk, dataDir, sessionPath: p, sticker: { id: 'stk_8', filePath: imgPath }, text: '开心' };
  const first = await deliverStickerToSession(args);
  const second = await deliverStickerToSession(args);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(sendCount, 1, '第二次应命中已送达记录，不重复投递');
});

test('投递：宿主不确认时明确失败，不假装成功', async () => {
  const p = 'C:/x/agents/hanako/sessions/c.jsonl';
  const { sdk } = fakeSdk({ sessionId: 'sess_test_3', path: p, onSend: () => ({ ok: false, error: '宿主拒绝' }) });
  const r = await deliverStickerToSession({
    sdk, dataDir, sessionPath: p, sticker: { id: 'stk_5', filePath: imgPath }, text: '',
  });
  assert.equal(r.ok, false);
});

test('投递：清单里没有这段对话时明确失败，不瞎猜编号', async () => {
  const sdk = {
    bus: {
      request: async (type) => (type === 'session:list' ? [{ path: 'C:/other.jsonl', sessionId: 'sess_other' }] : { ok: true }),
    },
  };
  const r = await deliverStickerToSession({
    sdk, dataDir, sessionPath: 'C:/x/agents/hanako/sessions/zzz.jsonl', sticker: { id: 'stk_7', filePath: imgPath }, text: '',
  });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /编号/);
});

test('投递：清单里那串短编号（不是 sess_ 那套）不会被当成会话编号', async () => {
  const p = 'C:/x/agents/hanako/sessions/d.jsonl';
  const sdk = {
    bus: {
      request: async (type) => (type === 'session:list'
        ? [{ path: p, sessionId: '01a10c08-7eb7-7a93-beca-097f948113ba' }]
        : { ok: true }),
    },
  };
  const r = await deliverStickerToSession({
    sdk, dataDir, sessionPath: p, sticker: { id: 'stk_4', filePath: imgPath }, text: '',
  });
  assert.equal(r.ok, false, '短编号不能当会话编号用');
});

test('投递：图片文件不存在时明确失败', async () => {
  const p = 'C:/x/agents/hanako/sessions/e.jsonl';
  const { sdk } = fakeSdk({ sessionId: 'sess_test_4', path: p, onSend: () => ({ ok: true }) });
  const r = await deliverStickerToSession({
    sdk, dataDir, sessionPath: p, sticker: { id: 'stk_6', filePath: path.join(dataDir, '不存在.png') }, text: '',
  });
  assert.equal(r.ok, false);
});

test('投递：缺会话路径或缺图片时直接拒绝，不碰宿主通道', async () => {
  const { sdk, calls } = fakeSdk();
  const a = await deliverStickerToSession({ sdk, dataDir, sessionPath: null, sticker: { filePath: imgPath }, text: '' });
  const b = await deliverStickerToSession({ sdk, dataDir, sessionPath: 'C:/x/agents/hanako/sessions/f.jsonl', sticker: null, text: '' });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(calls.length, 0);
});
