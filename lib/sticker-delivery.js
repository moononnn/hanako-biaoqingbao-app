// lib/sticker-delivery.js - 伙伴配图的记录与投递（App 版）。
// 普通 Hana express 返回 details.card；QQ Bridge express 另用 SessionFile + details.media 交给 BridgeManager。
// 纸飞机与定稿补发仍使用 session:send-custom；各路共用图片和反馈账本。
// 业务记录编号独立于宿主铸造的工具卡编号，不覆盖宿主身份或来源证明。

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareMessageCard, deliverMessageCard, cardImagePath } from './ball-message-card.js';
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
  const listed = sessionListCache.byPath.get(key);
  if (listed) return listed;

  // 有些宿主会把 bridge 会话排除在 session:list 外，但 session:get 仍可能
  // 通过正式的 legacySessionPath 解析器换出稳定编号。不可用时继续走原文件兜底。
  try {
    const result = await sdk?.bus?.request?.('session:get',
      { scope: 'all', legacySessionPath: sessionPath }, { timeoutMs: 8000 });
    const session = result?.session || result?.data?.session;
    const sessionId = pickSessId(session);
    if (sessionId) {
      sessionListCache.byPath.set(key, sessionId);
      return sessionId;
    }
  } catch {
    // 某些 Hana 构建尚不能按 legacySessionPath 解析，退回原有路径。
  }

  return readSessionIdFromFile(sessionPath) || '';
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

/** 为一次真实工具调用准备本地图卡和宿主可转发的 SessionFile。 */
export async function createStickerToolCard({ sdk, dataDir, sessionPath, callToken, sticker, text = '', emotion = '', requestId = randomUUID() }) {
  if (!sdk || !dataDir || !sessionPath || !sticker) return { ok: false, error: '图卡定位信息不完整' };
  try {
    const imagePath = resolveReadableImage(sticker);
    if (!imagePath) return { ok: false, error: '图片读不到：图库和临时目录里都没找到这张图' };
    const bytes = fs.readFileSync(imagePath);
    const mimeType = sticker.mime || MIME_BY_EXT[path.extname(imagePath).slice(1).toLowerCase()];
    if (!mimeType) return { ok: false, error: '图片格式不支持' };
    const sessionId = await resolveSessionId(sdk, sessionPath);
    if (!sessionId) return { ok: false, error: '拿不到这段对话的编号，图卡无法准备' };
    // 每次工具调用独立记录：同图在不同回复中再次发送不能争抢同一显示租约。
    const record = prepareMessageCard({ dataDir, sessionId, requestId: 'tool-' + requestId,
      sticker, text, bytes, mimeType, sender: 'partner', triggerTurn: false,
      agentId: resolveAgentId({}, { sessionPath }), emotion: String(emotion || '') });

    let media;
    let sessionFileError = '';
    try {
      // App tool input 不暴露 Bridge 身份；callToken 绑定当前会话，统一登记以供 Bridge 转发。
      if (!callToken) throw new Error('当前工具调用缺少文件投递令牌');
      const staged = await sdk.bus.request('session:stage-file', {
        callToken,
        path: cardImagePath(dataDir, record),
        name: path.basename(imagePath),
        mime: mimeType,
        origin: 'plugin_output',
      }, { timeoutMs: 8000 });
      const mediaItem = staged?.mediaItem || staged?.data?.mediaItem;
      if (mediaItem?.type !== 'session_file' || !(mediaItem.fileId || mediaItem.id)) {
        throw new Error('宿主未返回有效的 SessionFile 媒体项');
      }
      media = { items: [mediaItem] };
    } catch (error) {
      sessionFileError = error?.message || String(error);
    }

    return { ok: true, recordId: record.id, card: {
      pluginId: 'biaoqingbao-app', type: 'iframe',
      route: '/paper-plane-message.html?recordId=' + encodeURIComponent(record.id),
      sessionId, title: '对话内表情包', cardForm: 'flush',
    }, ...(media ? { media } : {}), ...(sessionFileError ? { sessionFileError } : {}) };
  } catch (error) { return { ok: false, error: error?.message || String(error) }; }
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
