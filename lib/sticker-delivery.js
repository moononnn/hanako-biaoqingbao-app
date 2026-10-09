// lib/sticker-delivery.js - 把伙伴配的表情包送进对话流（App 版）
//
// 插件版发图靠两条路：工具返回 details.media 让宿主渲染，或 deferred 原生图片块。
// 在 App 地基上这两条都断了：
//   ① App 环境没有 ctx.stageFile，express 直接降级成 base64 文本返回；
//   ② 就算工具返回了 details，桥接层也只记 {bridgedTool}，media / card 全被丢掉。
// App 里唯一活的发图通道是 session:send-custom —— 纸飞机走的就是它。
// 这里复用纸飞机的卡片存储与渲染（同一个 customType / cardId），
// 只把 sender 标成 partner、triggerTurn 关掉（伙伴配图不该再触发一轮）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareMessageCard, deliverMessageCard } from './ball-message-card.js';
import { readSessionIdFromFile } from './ball-core.js';
import { STICKERS_DIR, resolveAgentId } from './shared.js';

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
};

// 会话编号必须是 sess_ 开头那套（卡片记录与卡片页归属校验都按它比对）。
// 注意：pre-step 钩子给的 sessionId 是另一套短编号（形如 01a10c08-...），不能拿来用。
function pickSessId(item) {
  const candidates = [item?.sessionId, item?.session_id, item?.sessionRef?.sessionId, item?.sessionRef?.id, item?.id];
  for (const c of candidates) {
    const id = String(c || '').trim();
    if (id.startsWith('sess_')) return id;
  }
  return '';
}

// 先拿宿主的会话清单，按路径换 sess_ 编号。
// 两个坑：① session:get 只认 sessionId / legacySessionPath，传 sessionPath 会被
// 直接回绝（"Session manifest resolution requires sessionId or legacySessionPath."）；
// ② 清单有上千条，不能每次配图都拉，所以缓存 60 秒。
let sessionListCache = { at: 0, byPath: new Map() };

// 只给自动测试用：模块级缓存会跨用例干扰，测之前先清。
export function __resetSessionIdCacheForTests() {
  sessionListCache = { at: 0, byPath: new Map() };
}

export async function resolveSessionId(sdk, sessionPath) {
  const key = String(sessionPath || '').toLowerCase();
  if (!key) return '';
  const stale = Date.now() - sessionListCache.at > 60000;
  if (stale || sessionListCache.byPath.size === 0) {
    try {
      const list = await sdk?.bus?.request?.('session:list', { scope: 'all' }, { timeoutMs: 8000 });
      const arr = Array.isArray(list) ? list : (list?.sessions || list?.data || []);
      const byPath = new Map();
      for (const item of (Array.isArray(arr) ? arr : [])) {
        const p = String(item?.path || item?.sessionPath || '').toLowerCase();
        const id = pickSessId(item);
        if (p && id) byPath.set(p, id);
      }
      if (byPath.size) sessionListCache = { at: Date.now(), byPath };
    } catch {
      // 拉不到就先用旧缓存；实在没有就落到文件兜底
    }
  }
  return sessionListCache.byPath.get(key) || readSessionIdFromFile(sessionPath) || '';
}

// 从 express 工具的返回里认出「真的选中了一张图」。
// 降级分支（App 环境走的正是这条）把结果序列化成一段 JSON 文本。
export function extractSelectedSticker(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (obj?.ok !== true) return null;
  if (obj?.data?.action !== 'selected') return null;
  const sticker = obj.data.sticker;
  if (!sticker?.filePath) return null;
  return sticker;
}

// 图片路径必须落在 App 能读的地方。
// express 会把图复制到系统临时目录再返回 filePath，但那个目录在沙箱外，
// 读它会报 "Access to this API has been restricted. Use --allow-fs-read ..."；
// 图库目录在 App 数据目录里，读得到。所以优先用图库里的原图。
function resolveReadableImage(sticker) {
  const candidates = [];
  if (sticker?.file) candidates.push(path.join(STICKERS_DIR, sticker.file));
  if (sticker?.filePath) candidates.push(sticker.filePath);
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // existsSync 本身也可能被权限拦住，试下一个候选
    }
  }
  return '';
}

/**
 * 把一张表情包作为一条自定义消息投进会话。
 * 返回 { ok, entryId } 或 { ok:false, error }；任何失败都不抛。
 */
export async function deliverStickerToSession({ sdk, dataDir, sessionPath, sticker, text, emotion = '' }) {
  if (!sdk || !dataDir || !sessionPath || !sticker) {
    return { ok: false, error: '投递信息不完整' };
  }
  const imagePath = resolveReadableImage(sticker);
  if (!imagePath) {
    return { ok: false, error: '图片读不到：图库和临时目录里都没找到这张图' };
  }
  let bytes;
  try {
    bytes = fs.readFileSync(imagePath);
  } catch (e) {
    return { ok: false, error: '图片读不到：' + (e?.message || e) };
  }
  const ext = String(imagePath).split('.').pop().toLowerCase();
  const mimeType = sticker.mime || MIME_BY_EXT[ext];
  if (!mimeType) return { ok: false, error: '图片格式不支持：' + ext };

  const sessionId = await resolveSessionId(sdk, sessionPath);
  if (!sessionId) return { ok: false, error: '拿不到这段对话的编号，图发不出去' };

  // requestId 稳定：同一段对话 + 同一张图 = 同一条记录，重复调用不会发两遍
  const requestId = 'partner-' + createHash('sha256')
    .update(sessionId + '\0' + (sticker.id || sticker.file))
    .digest('hex').slice(0, 24);

  let record;
  try {
    record = prepareMessageCard({
      dataDir, sessionId, requestId, sticker,
      text, bytes, mimeType, sender: 'partner', triggerTurn: false,
      // 卡片上的反馈要记到当前伙伴名下；会话路径里带着 agents/<id>/。
      agentId: resolveAgentId({}, { sessionPath }),
      emotion: String(emotion || ''),
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }

  return deliverMessageCard({ ctx: sdk, dataDir, record, bytes, sticker });
}
