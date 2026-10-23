// 输入栏表情面板：会话绑定在打开时固定，图库与纸飞机共用。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readMeta } from './shared.js';
import { newestStickersFirst } from './sticker-order.js';
import { readGroupStore, isGroupStoreReadable, getStickerGroupIds, getRecognitionGroupTerms } from './sticker-groups.js';
import {
  readCategoryStore, writeCategoryStore, isCategoryStoreReadable, getCategoryStoreError,
  createCategory, renameCategory, deleteCategory, setStickerCategories, removeStickerFromCategories,
  mergeStickerCategories, removeStickerFromCategory,
  categoryRows, categoriesOfSticker,
} from './favorite-categories.js';
import { readBallConfig, setBallPinned, setBallPinnedMany, reorderBallPinned, stickerById, manifestSessionIdOf } from './ball.js';
import { prepareMessageCard, deliverMessageCard } from './ball-message-card.js';

export const STICKER_PANEL_ID = 'sticker-compose';
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
// 文字消息的进度也要落盘：图片有持久记录防重，文字不能只靠内存——
// 恰好在「已接纳但没回执」那一瞬重启，重试会把同一段文字再发一遍。
const TEXT_PROGRESS_DIR = 'compose-text';
const TEXT_PROGRESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function textProgressFile(dataDir, requestId) {
  return path.join(dataDir, TEXT_PROGRESS_DIR, `${requestId}.json`);
}

function readTextProgress(dataDir, requestId) {
  try {
    const saved = JSON.parse(fs.readFileSync(textProgressFile(dataDir, requestId), 'utf8'));
    return typeof saved?.status === 'string' ? saved.status : '';
  } catch { return ''; }
}

function writeTextProgress(dataDir, requestId, status) {
  try {
    const file = textProgressFile(dataDir, requestId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ status, time: new Date().toISOString() }));
    fs.renameSync(temp, file);
    pruneTextProgress(path.dirname(file), file);
  } catch { /* 落盘失败只影响重启后的防重，不拦这一次发送 */ }
}

function pruneTextProgress(dir, keep) {
  try {
    const expired = Date.now() - TEXT_PROGRESS_TTL_MS;
    for (const name of fs.readdirSync(dir)) {
      const target = path.join(dir, name);
      if (target === keep) continue;
      try { if (fs.statSync(target).mtimeMs < expired) fs.unlinkSync(target); } catch {}
    }
  } catch {}
}

export function normalizeCompose(body) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const ids = body?.stickerIds;
  if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => typeof id !== 'string' || !id || id.length > 100)) throw new Error('一次最多发送 8 张表情包');
  if (new Set(ids).size !== ids.length) throw new Error('待发送区有重复图片');
  if (text.length > 2000) throw new Error('文字最多 2000 字');
  if (!text && !ids.length) throw new Error('先选表情包或写点文字');
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId)) throw new Error('发送编号无效，请重新打开面板');
  return { text, stickerIds: ids, requestId: body.requestId };
}

// 图文分开发：图片不带配文，有文字时由最后的普通文字消息唤起一轮回复。
export async function deliverCompose({ sdk, sessionId, input, progress = {}, findSticker = stickerById, prepare = prepareMessageCard, deliver = deliverMessageCard }) {
  // 所有图片先验证和读取，避免最后一张缺失时前面已经投出。
  const images = input.stickerIds.map(id => {
    const hit = findSticker(id);
    if (!hit) throw new Error('选中的表情包已被删除，请从待发送区移除后重试');
    return { ...hit, bytes: fs.readFileSync(hit.filePath), mimeType: MIME[path.extname(hit.filePath).slice(1).toLowerCase()] };
  });
  const records = images.map((hit, index) => prepare({ dataDir: sdk.dataDir, sessionId,
    requestId: `compose-${input.requestId}-${index}`, sticker: hit.sticker, bytes: hit.bytes, mimeType: hit.mimeType,
    text: '', triggerTurn: !input.text && index === images.length - 1 }));
  for (let index = 0; index < images.length; index++) {
    const result = await deliver({ ctx: sdk, dataDir: sdk.dataDir, record: records[index], bytes: images[index].bytes, sticker: images[index].sticker });
    if (!result?.ok) return { ok: false, error: result?.error || '消息未确认送达，请先检查对话', partial: index > 0 };
  }
  if (input.text) {
    // 内存里的进度优先，其次看上次落盘的结论；重启后靠它拦住重复发送。
    if (!progress.text) progress.text = readTextProgress(sdk.dataDir, input.requestId);
    if (progress.text === 'accepted') return { ok: true };
    if (progress.text === 'unknown') return { ok: false, error: '文字消息结果未确认，请先检查对话，不要重复发送', partial: images.length > 0 };
    // 先标为不确定；只有明确拒收才能安全重试，超时或空回执不能盲目重投。
    progress.text = 'unknown';
    writeTextProgress(sdk.dataDir, input.requestId, 'unknown');
    const result = await sdk.bus.request('session:send', { sessionId, scope: 'all', text: input.text, deliverAs: 'followUp' }, { timeoutMs: 8000 });
    if (result?.ok === false || result?.accepted === false) {
      progress.text = 'rejected';
      writeTextProgress(sdk.dataDir, input.requestId, 'rejected');
      return { ok: false, error: result.error || '文字消息未接纳，可重试', partial: images.length > 0 };
    }
    if (result?.ok !== true && result?.accepted !== true) throw new Error('Hana 没有确认消息已接纳');
    progress.text = 'accepted';
    writeTextProgress(sdk.dataDir, input.requestId, 'accepted');
  }
  return { ok: true };
}

export function createStickerInputPanel(sdk) {
  const tickets = new Map();
  // 面板现在还开着吗：输入栅按钮要能“再按一下收起”，就必须知道当前是不是开着。
  // 面板隐藏/销毁时前端会回报 panel-hidden，把这条记录清掉。
  const openPanels = new Map(); // sessionId -> { ticket }
  function owner(body) {
    const state = tickets.get(body?.ticket);
    if (!state) throw new Error('面板已失效，请重新点输入栏的表情包按钮');
    return state;
  }
  return {
    async registerTool() {
      await sdk.tools.register({ name: 'stickers.open_compose', description: '打开输入栏表情发送面板。',
        sessionPermission: { readOnly: true }, parameters: { type: 'object', additionalProperties: false, properties: {} },
        execute: async (args) => {
          try {
            const sessionPath = args?.context?.sessionPath;
            if (!sessionPath) throw new Error('没认出当前对话');
            const response = await sdk.bus.request('session:get', { scope: 'all', sessionPath });
            const sessionId = manifestSessionIdOf(response?.session);
            if (!sessionId) throw new Error('没认出当前对话');
            // 重复点入口复用会话绑定，不丢草稿，也不丢上次发送的防重记录。
            const existing = [...tickets].find(([, state]) => state.sessionId === sessionId);
            if (!existing && tickets.size >= 128) tickets.delete(tickets.keys().next().value);
            const ticket = existing?.[0] || randomUUID();
            if (!existing) tickets.set(ticket, { sessionId, requests: new Map() });
            // 再按一下 = 收起：同一段对话、同一张票，说明面板现在还开着
            const opened = openPanels.get(sessionId);
            if (existing && opened && opened.ticket === ticket) {
              try {
                await sdk.userInteraction.dismiss({ sessionId, id: STICKER_PANEL_ID });
              } catch (error) {
                // 收起失败就只留一行痕迹，不再把面板当成带回真的状态
                console.log('[bqb-toggle] 收起面板失败: ' + String(error?.message || error));
              }
              openPanels.delete(sessionId);
              return { content: [{ type: 'text', text: '表情面板已收起。' }] };
            }
            try {
              await sdk.userInteraction.show({ sessionId, id: STICKER_PANEL_ID, title: '表情包',
                contentFrame: { route: '/sticker-compose.html', data: { ticket } },
                presentation: { height: 480, collapsedHeight: 32, expanded: true } });
            } catch (error) { if (!existing) tickets.delete(ticket); throw error; }
            openPanels.set(sessionId, { ticket });
            return { content: [{ type: 'text', text: '表情面板已打开。' }] };
          } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error).slice(0, 180) }] }; }
        } });
    },
    registerRoutes(app) {
      app.get('/api/sticker-compose/library', (c) => {
        try {
          const state = owner({ ticket: c.req.query('ticket') });
          const pendingId = c.req.query('requestId');
          const completedRequestId = state.requests.get(pendingId)?.completed ? pendingId : '';
          const ids = readBallConfig(sdk).pinnedIds;
          const meta = newestStickersFirst(readMeta());
          // 面板搜索要覆盖情绪、场景、语义描述和分组名，光给 description+keywords 搜不到。
          // 分组名与识别别名在这里算好一起给，前端不用再知道分组是怎么存的。
          const store = readGroupStore();
          const groups = isGroupStoreReadable(store) && Array.isArray(store.groups) ? store.groups : [];
          const known = new Set(groups.map(group => group.id));
          const nameById = new Map(groups.map(group => [group.id, group.name]));
          const termsById = new Map(groups.map(group => [group.id, getRecognitionGroupTerms(group)]));
          const rows = meta.map(s => ({
            id: s.id,
            description: String(s.description || ''),
            keywords: Array.isArray(s.tags?.keywords) ? s.tags.keywords : [],
            emotion: Array.isArray(s.tags?.emotion) ? s.tags.emotion : [],
            scene: Array.isArray(s.tags?.scene) ? s.tags.scene : [],
            semantic_description: String(s.semantic_description || ''),
            groups: getStickerGroupIds(s, known).map(id => ({ id, name: nameById.get(id) || id, terms: termsById.get(id) || [] })),
          }));
          // 收藏分类：只管「我的收藏」这一份，分类里的图一定也在收藏里。
          const categoryStore = readCategoryStore();
          const categoryError = isCategoryStoreReadable(categoryStore) ? '' : getCategoryStoreError(categoryStore);
          const cats = categoryRows(categoryStore, ids);
          for (const row of rows) {
            row.categories = categoriesOfSticker(cats, row.id);
          }
          return c.json({
            ok: true,
            data: rows,
            pinnedIds: ids,
            completedRequestId,
            categories: cats.map(row => ({ id: row.id, name: row.name, stickerIds: row.stickerIds, count: row.stickerIds.length })),
            categoryError,
          });
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      // ── 收藏分类：建 / 改名 / 删 / 设置一张图归哪几个分类 ──
      app.post('/api/sticker-compose/category-create', async (c) => {
        try {
          const body = await c.req.json(); owner(body);
          const store = readCategoryStore();
          if (!isCategoryStoreReadable(store)) throw new Error(getCategoryStoreError(store));
          const result = createCategory(store, body.name);
          if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
          writeCategoryStore(result.store);
          return c.json({ ok: true, category: { id: result.category.id, name: result.category.name, stickerIds: [], count: 0 } });
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      app.post('/api/sticker-compose/category-rename', async (c) => {
        try {
          const body = await c.req.json(); owner(body);
          const store = readCategoryStore();
          if (!isCategoryStoreReadable(store)) throw new Error(getCategoryStoreError(store));
          const result = renameCategory(store, body.id, body.name);
          if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
          if (!result.unchanged) writeCategoryStore(result.store);
          return c.json({ ok: true, category: { id: result.category.id, name: result.category.name } });
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      app.post('/api/sticker-compose/category-delete', async (c) => {
        try {
          const body = await c.req.json(); owner(body);
          const store = readCategoryStore();
          if (!isCategoryStoreReadable(store)) throw new Error(getCategoryStoreError(store));
          const result = deleteCategory(store, body.id);
          if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
          writeCategoryStore(result.store);
          return c.json({ ok: true });
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      app.post('/api/sticker-compose/category-set', async (c) => {
        try {
          const body = await c.req.json(); owner(body);
          if (typeof body.stickerId !== 'string' || !body.stickerId.trim()) throw new Error('表情包编号不对');
          const store = readCategoryStore();
          if (!isCategoryStoreReadable(store)) throw new Error(getCategoryStoreError(store));
          // 分类是收藏的子集：没进收藏的图不能分类。
          const pinned = new Set(readBallConfig(sdk).pinnedIds);
          if (!pinned.has(body.stickerId)) throw new Error('这张图还不在收藏里，先收藏再分类');
          const result = setStickerCategories(store, body.stickerId, body.categoryIds);
          if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
          writeCategoryStore(result.store);
          return c.json({ ok: true, categoryIds: categoriesOfSticker(result.store.categories, body.stickerId) });
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      // ── 批量：多选后一次落盘，不是一张一张写文件 ──
      app.post('/api/sticker-compose/category-set-batch', async (c) => {
        try {
          const body = await c.req.json(); owner(body);
          const ids = Array.isArray(body.stickerIds) ? body.stickerIds.map(value => String(value ?? '').trim()).filter(Boolean) : [];
          if (!ids.length) throw new Error('没选中图');
          const store = readCategoryStore();
          if (!isCategoryStoreReadable(store)) throw new Error(getCategoryStoreError(store));
          const pinned = new Set(readBallConfig(sdk).pinnedIds);
          const wanted = ids.filter(id => pinned.has(id));
          if (!wanted.length) throw new Error('选中的图都不在收藏里');
          const result = mergeStickerCategories(store, wanted, body.categoryIds);
          if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
          writeCategoryStore(result.store);
          return c.json({ ok: true, count: wanted.length });
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      app.post('/api/sticker-compose/category-remove-batch', async (c) => {
        try {
          const body = await c.req.json(); owner(body);
          const ids = Array.isArray(body.stickerIds) ? body.stickerIds.map(value => String(value ?? '').trim()).filter(Boolean) : [];
          if (!ids.length) throw new Error('没选中图');
          const store = readCategoryStore();
          if (!isCategoryStoreReadable(store)) throw new Error(getCategoryStoreError(store));
          const result = removeStickerFromCategory(store, ids, body.categoryId);
          if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
          writeCategoryStore(result.store);
          return c.json({ ok: true, count: ids.length });
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      app.post('/api/sticker-compose/unpin-batch', async (c) => {
        try {
          const body = await c.req.json(); owner(body);
          const ids = Array.isArray(body.stickerIds) ? body.stickerIds.map(value => String(value ?? '').trim()).filter(Boolean) : [];
          if (!ids.length) throw new Error('没选中图');
          const result = await setBallPinnedMany(sdk, ids, false);
          if (!result?.ok) return c.json({ ok: false, error: result?.error || '移出收藏没成功' }, 400);
          // 收藏里没了，分类里也不能留
          const store = readCategoryStore();
          if (isCategoryStoreReadable(store)) {
            let cleaned = store;
            for (const id of ids) cleaned = removeStickerFromCategories(cleaned, id).store;
            writeCategoryStore(cleaned);
          }
          return c.json({ ok: true, count: ids.length });
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      app.post('/api/sticker-compose/reorder', async (c) => {
        try {
          const body = await c.req.json(); owner(body);
          const result = await reorderBallPinned(sdk, body.ids);
          return c.json(result, result.ok ? 200 : result.status || 400);
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      app.post('/api/sticker-compose/pin', async (c) => {
        try {
          const body = await c.req.json(); owner(body);
          if (typeof body.stickerId !== 'string' || typeof body.pinned !== 'boolean') throw new Error('收藏参数无效');
          const result = await setBallPinned(sdk, body.stickerId, body.pinned);
          // 移出收藏时，分类里也要跟着去掉：分类是收藏的子集，不能留幽灵。
          if (body.pinned === false) {
            const store = readCategoryStore();
            if (isCategoryStoreReadable(store)) {
              const cleaned = removeStickerFromCategories(store, body.stickerId);
              if (cleaned.ok) writeCategoryStore(cleaned.store);
            }
          }
          return c.json(result, result?.ok === false ? 400 : 200);
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      app.post('/api/sticker-compose/send', async (c) => {
        try {
          const body = await c.req.json();
          const state = owner(body);
          const input = normalizeCompose(body);
          const fingerprint = JSON.stringify(input);
          const existing = state.requests.get(input.requestId);
          if (existing && existing.fingerprint !== fingerprint) throw new Error('上次发送内容已锁定，请先检查对话，再重新编辑发送');
          const entry = existing || { fingerprint, task: null, unknown: false, progress: {} };
          state.requests.set(input.requestId, entry);
          if (entry.unknown) throw new Error('上次发送结果不确定，请先检查对话，避免重复发送');
          if (!entry.task) entry.task = deliverCompose({ sdk, sessionId: state.sessionId, input, progress: entry.progress }).catch(() => {
            entry.unknown = true;
            return { ok: false, error: '发送结果未确认，请先检查对话；文字和选图已保留' };
          });
          const result = await entry.task;
          if (result.ok) entry.completed = true;
          // 图片投递自己的持久记录负责防重；明确失败允许同一编号重试。
          if (!result.ok && !entry.unknown) entry.task = null;
          return c.json(result, result.ok ? 200 : 409);
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      app.post('/api/sticker-compose/close', async (c) => {
        try {
          const body = await c.req.json(); const state = owner(body);
          await sdk.userInteraction.dismiss({ sessionId: state.sessionId, id: STICKER_PANEL_ID });
          openPanels.delete(state.sessionId);
          return c.json({ ok: true });
        } catch (e) { return c.json({ ok: false, error: e.message }, 400); }
      });
      // 面板自己被关掉/被隐藏时前端报一声，不然后端还以为它开着，
      // 下次点输入栅按钮会变成「收起」而不是重新打开。
      app.post('/api/sticker-compose/panel-hidden', (c) => {
        const ticket = String(c.req.query('ticket') || '');
        if (ticket) {
          for (const [sessionId, info] of openPanels) {
            if (info.ticket === ticket) openPanels.delete(sessionId);
          }
        }
        return c.json({ ok: true });
      });
    },
  };
}
