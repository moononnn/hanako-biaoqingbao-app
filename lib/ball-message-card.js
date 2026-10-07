// Paper-plane messages: immutable image/caption snapshots bound to one stream card.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from './atomic-store/index.js';
import { buildSemanticContext, buildPartnerStickerContext, sanitizeBallText } from './ball-core.js';
import { readAgentName } from './agent-name.js';

export const BALL_MESSAGE_TYPE = 'paper-plane-image';
// 伙伴自己配的图走另一个 customType：卡片标题是宿主从清单里读的静态字段，
// 复用用户那张卡会把「你发出的表情包」安到伙伴头上。
export const PARTNER_MESSAGE_TYPE = 'partner-sticker';
// Host card ids must use this public runtime format; prefix/hash also includes the App namespace.
const ID = /^a_[0-9a-f]{20}$/;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };
// v0.1.28 - 内联像素闸门，见 buildMessageCardPayload 里的长注释。
export const MAX_INLINE_IMAGE_BASE64 = 384 * 1024;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const rootOf = (dataDir) => path.join(dataDir, 'ball-message-cards');

export function readMessageCard(dataDir, id) {
  if (!ID.test(String(id || ''))) return null;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(rootOf(dataDir), id + '.json'), 'utf8'));
    if (record.id !== id || !HASH.test(record.imageHash) || !record.sessionId || !IMAGE_EXT[record.mimeType]) return null;
    return record;
  } catch { return null; }
}

export function cardImagePath(dataDir, record) {
  if (!HASH.test(String(record?.imageHash || '')) || !IMAGE_EXT[record.mimeType]) throw new Error('无效的图片记录');
  return path.join(rootOf(dataDir), 'images', record.imageHash + IMAGE_EXT[record.mimeType]);
}

export function prepareMessageCard({ dataDir, sessionId, requestId, sticker, text, bytes, mimeType, sender = 'user', triggerTurn = true, agentId = '', emotion = '' }) {
  if (!dataDir || !sessionId || !requestId) throw new Error('消息定位信息不完整');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('图片为空或超过 20MB');
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(mimeType)) throw new Error('不支持的图片类型');
  const id = 'a_' + digest('biaoqingbao-app\0' + sessionId + '\0' + requestId).slice(0, 20);
  const imageHash = digest(bytes);
  const textValue = sanitizeBallText(text, 2000);
  const senderValue = sender === 'partner' ? 'partner' : 'user';
  const existing = readMessageCard(dataDir, id);
  if (!existing && fs.existsSync(path.join(rootOf(dataDir), id + '.json'))) throw new Error('旧发送记录损坏，不能确认是否已经送达');
  if (existing) {
    if (existing.imageHash !== imageHash || existing.text !== textValue) throw new Error('同一个发送编号对应了不同内容，请重新发送');
    return existing;
  }
  const record = { id, sessionId, imageHash, mimeType, text: textValue, sender: senderValue,
    customType: senderValue === 'partner' ? PARTNER_MESSAGE_TYPE : BALL_MESSAGE_TYPE,
    stickerId: String(sticker?.id || ''), agentId: String(agentId || ''), emotion: String(emotion || ''),
    feedback: null, feedbackKind: null, feedbackBase: null,
    createdAt: new Date().toISOString(), state: 'prepared',
    triggerTurn: triggerTurn !== false };
  fs.mkdirSync(path.join(rootOf(dataDir), 'images'), { recursive: true });
  try { fs.writeFileSync(cardImagePath(dataDir, record), bytes, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  writeFileAtomic(path.join(rootOf(dataDir), id + '.json'), JSON.stringify(record));
  return record;
}

export function setMessageCardState(dataDir, record, state, entryId = null) {
  const next = { ...record, state, entryId };
  writeFileAtomic(path.join(rootOf(dataDir), record.id + '.json'), JSON.stringify(next));
  return next;
}

// v0.1.17 - 卡片上的喜欢/应景/不喜欢直接把反馈状态写回记录本身（卡片是它自己的账本）。
export function setMessageCardFeedback(dataDir, record, patch = {}) {
  const next = { ...record, ...patch };
  writeFileAtomic(path.join(rootOf(dataDir), record.id + '.json'), JSON.stringify(next));
  return next;
}

// 三键状态机（与悬浮球、旧卡一致）：同维度再点=取消，跨维度=叠加成 both，both 再点某维度=只剩另一维度。
export function nextPositiveKind(prevFeedback, prevKind, tapped) {
  const kind = prevKind === 'context' || prevKind === 'both' ? prevKind : 'image';
  if (prevFeedback !== 'positive') return tapped;
  if (kind === tapped) return null;
  if (kind === 'both') return tapped === 'image' ? 'context' : 'image';
  return 'both';
}

// v0.1.30 - 卡片上的聊天记录。它的命只在「还没确认修改」这段时间里：
// 它是这次调整的案卷（聊了啥、当时给的建议、哪几条不要了），确认写完标签就没用了，
// 所以确认成功时清空、不长期存。读的时候一律重新过一遍，不信任盘上的形状。
export function readMessageCardChat(record) {
  const chat = record?.chat;
  if (!chat || typeof chat !== 'object') return null;
  const messages = (Array.isArray(chat.messages) ? chat.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'bot') && typeof m.text === 'string' && m.text)
    .map((m) => ({ role: m.role, text: m.text }));
  return {
    messages,
    suggestion: chat.suggestion && typeof chat.suggestion === 'object' ? chat.suggestion : null,
    oldTags: chat.oldTags && typeof chat.oldTags === 'object' ? chat.oldTags : null,
    dropped: (Array.isArray(chat.dropped) ? chat.dropped : []).filter((f) => typeof f === 'string'),
    updatedAt: typeof chat.updatedAt === 'string' ? chat.updatedAt : '',
  };
}

// chat 传 null 就是销案（确认改完之后调）。
export function saveMessageCardChat(dataDir, record, chat) {
  if (!record?.id) return record;
  const next = { ...record, chat: chat ? { ...chat, updatedAt: new Date().toISOString() } : null };
  writeFileAtomic(path.join(rootOf(dataDir), record.id + '.json'), JSON.stringify(next));
  return next;
}

export function buildMessageCardPayload({ record, dataDir, bytes, sticker, triggerTurn = undefined }) {
  // v0.1.24 - 两张卡的归属文案必须分开：
  //   纸飞机是「用户发来的图」，伙伴配图是「你自己发出去的图」。
  //   共用纸飞机那段（「请理解用户消息」）会让伙伴把自己的图当成用户发来的，
  //   下一轮把图当新话题回应，语气也变成「你发图给我了」。
  const isPartner = record.sender === 'partner';
  // v0.1.28 - 图太大就不送像素，只送引用。
  //
  // 宿主把会话记录写进 jsonl 时有条保护：单条记录超过 1MB 就做一次「瘦身投影」，
  // 把超长字符串换成 `[omitted N chars by Hana session JSONL guard]` 这句占位文字。
  // 它的白名单只认 user / assistant 正式消息的 content 与 text —— 我们经
  // session:send-custom 投的 custom_message 不在白名单里，图片那串 base64 会被就地
  // 换成那句文字，而「这是一张图」的结构还留着。之后每一轮重建模型请求，都会把
  // 这句占位文字当图片 base64 发出去，模型解码失败，那个窗口从此每轮都报
  // 400 Invalid base64 data，而且投影结果写进了磁盘，重发多少次都救不回来。
  //
  // 与其赌宿主那条 1MB 的线，不如自己先设闸：base64 超过上限就只送文字。
  // 图路径和语义本来就在文字里，伙伴仍然知道自己发的是什么；卡片显示走自己的
  // 图片接口读文件，跟这里送不送像素无关，用户那边看不出区别。
  const base64 = bytes.toString('base64');
  const inlineImage = base64.length <= MAX_INLINE_IMAGE_BASE64;
  const text = [isPartner ? '你刚刚发出了这张表情包。' : (record.text || '（发送了一张表情包）'),
    '[attached_image: ' + cardImagePath(dataDir, record) + ']',
    isPartner ? buildPartnerStickerContext({ sticker }) : buildSemanticContext({ sticker })];
  if (!inlineImage) text.push('（这张图太大了，没有随这条消息一起送进来；上面的路径和说明是准的。）');
  return {
    sessionId: record.sessionId, scope: 'all',
    customType: record.customType || BALL_MESSAGE_TYPE,
    display: true,
    // 用户发的图要唤醒伙伴回话；伙伴自己配的图不该再触发一轮
    triggerTurn: triggerTurn === undefined ? (record.triggerTurn !== false) : triggerTurn !== false,
    details: { cardInstanceId: record.id },
    content: [
      { type: 'text', text: text.join('\n\n') },
      ...(inlineImage ? [{ type: 'image', data: base64, mimeType: record.mimeType }] : []),
    ],
  };
}

export async function deliverMessageCard({ ctx, dataDir, record, bytes, sticker }) {
  if (record.state === 'accepted') return { ok: true, entryId: record.entryId, reused: true };
  if (record.state === 'sending' || record.state === 'unknown') {
    return { ok: false, status: 409, error: '上一条消息可能已经送达，请先看一下对话，不要重复发送' };
  }
  setMessageCardState(dataDir, record, 'sending');
  let result;
  try {
    result = await ctx.bus.request('session:send-custom',
      buildMessageCardPayload({ record, dataDir, bytes, sticker }), { timeoutMs: 8000 });
  } catch (error) {
    try { setMessageCardState(dataDir, record, 'unknown'); } catch { /* Keep sending state: never replay blindly. */ }
    return { ok: false, status: 504, error: '投递结果尚未确认，消息可能已经送达，请先看一下对话：' + (error?.message || error) };
  }
  if (result?.ok !== true) {
    const state = result?.ok === false ? 'rejected' : 'unknown';
    setMessageCardState(dataDir, record, state);
    return { ok: false, status: 500, error: result?.error || 'Hana 没有确认这条消息已接纳，请先看一下对话' };
  }
  try { setMessageCardState(dataDir, record, 'accepted', result.entryId || null); }
  catch (error) { ctx?.log?.warn?.('[biaoqingbao-ball] 消息已接纳，但状态记录失败：' + (error?.message || error)); }
  return { ok: true, entryId: result.entryId || null };
}

export function registerMessageCardRoutes(app, dataDir) {
  // v0.1.30 - 卡片重放（切窗口回来、App 重装）后靠它把聊天记录拿回去。
  // 没有记录就返回 null，不是错误：本来就只有「还没确认修改」的卡才有。
  app.get('/api/message-card/chat', (c) => {
    const record = readMessageCard(dataDir, c.req.query('id'));
    if (!record) return c.json({ ok: false, error: '这条图片记录已不可用' }, 404);
    const chat = readMessageCardChat(record);
    return c.json({ ok: true, data: chat ? { ...chat, stickerId: record.stickerId || '' } : null });
  });
  app.get('/api/paper-plane-message', (c) => {
    const record = readMessageCard(dataDir, c.req.query('id'));
    if (!record) return c.json({ ok: false, error: '这条图片记录已不可用' }, 404);
    return c.json({ ok: true, data: { id: record.id, sessionId: record.sessionId,
      text: record.text, state: record.state, createdAt: record.createdAt,
      stickerId: record.stickerId || '', agentId: record.agentId || '', emotion: record.emotion || '',
      // v0.1.27 - 卡头标题要用伙伴的名字，但卡片只能读到记录本身，所以在接口里一次给全。
      agentName: readAgentName(record.agentId) || '',
      feedback: record.feedback || null, feedbackKind: record.feedbackKind || null,
      sender: record.sender === 'partner' ? 'partner' : 'user' } });
  });
  app.get('/api/paper-plane-message/image', (c) => {
    const record = readMessageCard(dataDir, c.req.query('id'));
    if (!record) return c.text('图片记录不可用', 404);
    try {
      c.header('Content-Type', record.mimeType);
      c.header('Cache-Control', 'private, max-age=86400');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(fs.readFileSync(cardImagePath(dataDir, record)));
    } catch { return c.text('图片已不可用', 404); }
  });
}
