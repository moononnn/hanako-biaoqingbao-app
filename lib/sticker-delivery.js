// lib/sticker-delivery.js - 伙伴配图的记录与投递（App 版）。
// Hana express 使用 session:send-custom；QQ Bridge 另用 SessionFile + details.media 交给 BridgeManager。
// 不从工具结果返回 iframe 卡，避免桥接工具全名与宿主卡片来源凭据短名不匹配。
// 业务记录编号独立于宿主铸造的工具卡编号，不覆盖宿主身份或来源证明。
//
// v0.2.17 - 会话附件登记与会话编号解耦（桥接会话发不出图的根治）。
// session:stage-file 只认当前工具调用的 callToken，不需要 sess_ 编号；而桥接会话的
// sess_ 编号在宿主侧本来就取不到（session:list 的投影过滤掉 domain !== "desktop"，
// session:get 的按路径解析又存在键名不匹配）。此前把「先拿编号」当成前置条件，
// 于是编号一空整条投递就失败，图卡和附件一起没了。现在编号只服务本地图卡：
// 拿得到就照旧出卡，拿不到就只登记会话附件——桥接通道要的本来就只有后者。

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareMessageCard, deliverMessageCard, readMessageCard } from './ball-message-card.js';
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

  // 有些宿主会把 bridge 会话排除在 session:list 外，但 session:get 仍可能按路径换出编号。
  // 宿主解析器读的是 sessionPath / path 两个键，只传 legacySessionPath 会被忽略
  // （报 "Session manifest resolution requires sessionId or legacy sessionPath"），
  // 所以两个键都带上，让它自己挑能认的那个。这条只是尽力而为：拿不到编号不再挡投递。
  try {
    const result = await sdk?.bus?.request?.('session:get',
      { scope: 'all', sessionPath, legacySessionPath: sessionPath }, { timeoutMs: 8000 });
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

/** 为一次真实工具调用准备本地图卡和宿主可转发的 SessionFile。
 *
 * 会话编号只服务本地图卡。桥接会话（QQ 等）拿不到 sess_ 编号，但那条通道要的本来
 * 就只有 SessionFile——所以编号为空时跳过图卡，照样把图登记成会话附件送出去。
 */
export async function createStickerToolCard({ sdk, dataDir, sessionPath, callToken, sticker, text = '', emotion = '', requestId = randomUUID() }) {
  if (!sdk || !dataDir || !sessionPath || !sticker) return { ok: false, error: '图卡定位信息不完整' };
  // 2026-10-17 - 分段打点：实测工具内部 175ms 就选完了，卡片却再花6 秒，口径得设在这里。
  const cardT0 = Date.now();
  const lap = (label) => {
    try {
      fs.appendFileSync(path.join(dataDir, 'probe.log'), `${new Date().toISOString()} [card] ${label} +${Date.now() - cardT0}ms\n`, 'utf-8');
    } catch { /* 日志写不进去不影响发图 */ }
  };
  lap('start');
  try {
    const imagePath = resolveReadableImage(sticker);
    if (!imagePath) return { ok: false, error: '图片读不到：图库和临时目录里都没找到这张图' };
    const bytes = fs.readFileSync(imagePath);
    const mimeType = sticker.mime || MIME_BY_EXT[path.extname(imagePath).slice(1).toLowerCase()];
    if (!mimeType) return { ok: false, error: '图片格式不支持' };

    // 登记用的图必须在 App dataDir 里（宿主只收这个范围）。express 选中的图本来就在
    // 图库里；万一只剩系统临时目录那份，就写一份到 dataDir 再交出去。
    let stagePath = imagePath;
    try {
      const inDataDir = path.resolve(imagePath).toLowerCase().startsWith(path.resolve(dataDir).toLowerCase() + path.sep);
      if (!inDataDir) {
        const stagingDir = path.join(dataDir, 'staged');
        fs.mkdirSync(stagingDir, { recursive: true });
        stagePath = path.join(stagingDir, path.basename(imagePath));
        fs.writeFileSync(stagePath, bytes);
      }
    } catch { stagePath = imagePath; }

    // 会话编号只用来给本地图卡定位；拿不到不拦投递。
    let sessionId = '';
    try { sessionId = await resolveSessionId(sdk, sessionPath); } catch { sessionId = ''; }
    lap(`session ${sessionId ? 'ok' : 'none'}`);

    // 先登记会话附件：桥接通道认的就是它，且它只需要 callToken。
    let media;
    let sessionFileError = '';
    try {
      // App tool input 不暴露 Bridge 身份；callToken 绑定当前会话，统一登记以供 Bridge 转发。
      if (!callToken) throw new Error('当前工具调用缺少文件投递令牌');
      const staged = await sdk.bus.request('session:stage-file', {
        callToken,
        path: stagePath,
        name: path.basename(imagePath),
        mime: mimeType,
        origin: 'plugin_output',
      }, { timeoutMs: 10000 });
      const mediaItem = staged?.mediaItem || staged?.data?.mediaItem;
      if (mediaItem?.type !== 'session_file' || !(mediaItem.fileId || mediaItem.id)) {
        throw new Error('宿主未返回有效的 SessionFile 媒体项');
      }
      media = { items: [mediaItem] };
    } catch (error) {
      sessionFileError = error?.message || String(error);
    }
    lap(`stage-file ${media ? 'ok' : 'fail'}`);

    // 本地图卡要有编号才能建；没有编号就只出附件（桥接无 UI，本来也不看图卡）。
    let preparedRecord = null;
    let messageError = '';
    let recordId = '';
    if (sessionId) {
      try {
        // 每次工具调用独立记录：同图在不同回复中再次发送不能争抢同一显示租约。
        const record = prepareMessageCard({ dataDir, sessionId, requestId: 'tool-' + requestId,
          sticker, text, bytes, mimeType, sender: 'partner', triggerTurn: false,
          agentId: resolveAgentId({}, { sessionPath }), emotion: String(emotion || '') });
        recordId = record.id;
        // 工具执行期间只准备，交给定稿队列等空闲后再投，避免变成当前回合的追加输入。
        preparedRecord = record;
      } catch (error) {
        messageError = error?.message || String(error);
      }
    }

    // 附件和图卡都没有，才算真失败。
    lap(`record ${preparedRecord ? 'ok' : 'none'}`);
    if (!media && !preparedRecord) {
      return { ok: false, error: messageError || sessionFileError || '会话附件和图卡都没能建立' };
    }

    return { ok: true, recordId, preparedRecord, ...(media ? { media } : {}),
      ...(messageError ? { messageError } : {}),
      ...(sessionFileError ? { sessionFileError } : {}), ...(sessionId ? {} : { noSessionId: true }) };
  } catch (error) { return { ok: false, error: error?.message || String(error) }; }
}

/**
 * 把一张表情包作为一条自定义消息投进会话。
 * 返回 { ok, entryId } 或 { ok:false, error }；任何失败都不抛。
 */
export async function deliverStickerToSession({ sdk, dataDir, sessionPath, sticker, text, emotion = '', preparedRecord = null }) {
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
    if (preparedRecord && (preparedRecord.sessionId !== sessionId || preparedRecord.stickerId !== String(sticker.id || ''))) {
      throw new Error('待投图片记录与当前会话或表情包不一致');
    }
    if (preparedRecord && !readMessageCard(dataDir, preparedRecord.id)) throw new Error('待投图片记录已不可用');
    record = (preparedRecord && readMessageCard(dataDir, preparedRecord.id)) || prepareMessageCard({
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
