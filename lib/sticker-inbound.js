// 聊天里的一张图交给图库：先入库，再后台认图。
//
// 别的应用（目前只有茶话会）把聊天里出现的一张图递过来，走这条路收进图库。
// 三条前提：
//   1. 只认白名单里的调用方（callerAppId），别的应用叫不动。
//   2. 先入库、先回话，认图在后台跑：认图要花钱、要等，不能让她右键一下干等一分钟。
//   3. 认图失败不算入库失败：图已经在了，标签以后在图库里补。
//
// 调用方传的是本机绝对路径。我们只读它，不写回、不删——临时文件由调用方自己收尾。

import fs from "node:fs";
import path from "node:path";
import { enqueueToolWrite, genId, readMeta, writeMeta, writeNewStickerFile, STICKERS_DIR, tagImage } from "./shared.js";
import { safeStickerPath } from "./ball-core.js";
import { fingerprintOfBuffer, findDuplicateSticker, flushFingerprintIndex, registerFingerprint, syncFingerprintIndex } from "./image-fingerprints.js";
import { USAGE_MEANING_MAX, USAGE_SOURCE, normalizeUsageMeaning } from "./sticker-usage.js";

export const INBOUND_METHOD = "sticker/add-from-chat";
/** 采用用法：茶话会学到一句纠正后递过来，我们只记这一张的用法。 */
export const USAGE_ADOPT_METHOD = "sticker/adopt-usage";
export const INBOUND_MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

function extOf(fileName) {
  const ext = String(fileName || "").split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALLOWED_EXTS.has(ext) ? ext : "png";
}

function asTagList(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim().slice(0, limit)).filter(Boolean).slice(0, 20);
}

export async function registerStickerInboundService({ sdk, allowedCallers = ["chahuahui"], tagger = tagImage } = {}) {
  if (typeof sdk?.bus?.handle !== "function") {
    await sdk?.logger?.warn?.("宿主没有 bus.handle，跨应用收图服务没有注册");
    return null;
  }
  const callers = new Set(allowedCallers.map(String));
  try {
    const dispose = await sdk.bus.handle(INBOUND_METHOD, async (payload = {}, { callerAppId } = {}) => {
      if (!callers.has(String(callerAppId || ""))) {
        return { ok: false, error: "调用方不在允许名单里" };
      }
      const sourcePath = String(payload?.sourcePath || "").trim();
      if (!sourcePath) return { ok: false, error: "缺少图片路径" };
      if (!path.isAbsolute(sourcePath)) return { ok: false, error: "图片路径必须是绝对路径" };
      let buffer = null;
      try {
        // 走宿主资源接口读：App 子进程的沙箱只放行自己的目录，直读别人家的路径会被拒。
        const result = await sdk?.resources?.read?.({ kind: "local-file", path: sourcePath });
        const raw = result?.content ?? result?.data ?? result?.body ?? result;
        if (raw == null) throw new Error("资源接口没回内容");
        buffer = raw instanceof Uint8Array
          ? Buffer.from(raw)
          : (typeof raw === "string" && raw.trim() ? Buffer.from(raw.trim(), "base64") : null);
      } catch (error) {
        // 宿主没给资源接口（自建环境）时退回直读，只为兼容。
        try {
          buffer = fs.readFileSync(sourcePath);
        } catch (readError) {
          return { ok: false, error: `读不到图片：${readError?.message || readError}` };
        }
      }
      if (!buffer || !buffer.length) return { ok: false, error: "图片是空的" };
      if (buffer.length > INBOUND_MAX_BYTES) return { ok: false, error: "图片超过 10MB，先压一压再收" };

      const ext = extOf(sourcePath);
      const hash = fingerprintOfBuffer(buffer);
      const known = hash ? findDuplicateSticker(hash) : null;
      if (known) {
        // 同一张图不重复入库：重复收只会让图库多出几张一模一样的，还白烧一次认图。
        await sdk.logger?.info?.(`[biaoqingbao] 跨应用收图重复，跳过：${known.id} (${known.file})`);
        return { ok: true, duplicate: true, id: known.id, file: known.file };
      }

      const now = new Date().toISOString();
      let entry = null;
      try {
        entry = await enqueueToolWrite(() => {
          syncFingerprintIndex();
          const stickers = readMeta();
          const id = genId(stickers);
          const file = `${id}.${ext}`;
          const dest = safeStickerPath(STICKERS_DIR, file);
          if (!dest) return null;
          fs.mkdirSync(STICKERS_DIR, { recursive: true });
          writeNewStickerFile(dest, buffer);
          const row = {
            id, file, description: "", semantic_description: "",
            tags: { emotion: [], scene: [], keywords: [] },
            added_at: now,
          };
          stickers.push(row);
          writeMeta(stickers);
          registerFingerprint(id, hash, { persistNow: false });
          return row;
        });
        flushFingerprintIndex();
      } catch (error) {
        return { ok: false, error: `入库失败：${error?.message || error}` };
      }
      if (!entry) return { ok: false, error: "图库写入失败" };

      await sdk.logger?.info?.(`[biaoqingbao] 跨应用收图入库: ${entry.id} (${entry.file}) 来自 ${callerAppId}`);
      // 认图放后台：回话先走，标签稍后落盘。
      void applyVisionTags({ sdk, tagger, id: entry.id, buffer, fileName: entry.file });
      return { ok: true, id: entry.id, file: entry.file };
    }, { allowCrossApp: true });
    await sdk.logger?.info?.(`跨应用收图服务已注册：app:biaoqingbao-app/${INBOUND_METHOD}`);
    return dispose;
  } catch (error) {
    await sdk?.logger?.warn?.(`跨应用收图服务注册失败：${error?.message || error}`);
    return null;
  }
}

/**
 * 采用用法的载荷：严格只认 { stickerId, meaning } 两个字段。
 * 多一个字段、少一个字段、类型不对、说明太长，一律拒。
 */
export function parseAdoptUsagePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "载荷格式不对" };
  }
  const extra = Object.keys(payload).filter((key) => key !== "stickerId" && key !== "meaning");
  if (extra.length) return { ok: false, error: `载荷里有多余的字段：${extra.join("、")}` };
  if (!("stickerId" in payload) || !("meaning" in payload)) {
    return { ok: false, error: "载荷必须同时有 stickerId 和 meaning" };
  }
  if (typeof payload.stickerId !== "string") return { ok: false, error: "表情包编号必须是文字" };
  const stickerId = payload.stickerId.trim();
  if (!/^[\w-]{1,120}$/u.test(stickerId)) return { ok: false, error: "缺少合法的表情包编号" };
  if (typeof payload.meaning !== "string") return { ok: false, error: "用法说明必须是文字" };
  const raw = payload.meaning.trim();
  if (!raw) return { ok: false, error: "缺少用法说明" };
  if (raw.length > USAGE_MEANING_MAX) return { ok: false, error: `用法说明太长了（最多 ${USAGE_MEANING_MAX} 字）` };
  const meaning = normalizeUsageMeaning(raw);
  if (!meaning) return { ok: false, error: "用法说明是空的" };
  return { ok: true, stickerId, meaning };
}

/**
 * 采用用法服务：只认白名单调用方，只写单张图的一个独立字段。
 *
 * 记的是「这张图在我们这儿该怎么用」，不是改标题、不是换图、也不是联网重认。
 * 写完就完事：对外索引由 writeMeta 顺带刷新。
 */
export async function registerStickerUsageAdoptService({ sdk, allowedCallers = ["chahuahui"] } = {}) {
  if (typeof sdk?.bus?.handle !== "function") {
    await sdk?.logger?.warn?.("宿主没有 bus.handle，采用用法服务没有注册");
    return null;
  }
  const callers = new Set(allowedCallers.map(String));
  try {
    const dispose = await sdk.bus.handle(USAGE_ADOPT_METHOD, async (payload = {}, { callerAppId } = {}) => {
      const caller = String(callerAppId || "");
      if (!callers.has(caller)) {
        return { ok: false, error: "调用方不在允许名单里" };
      }
      const parsed = parseAdoptUsagePayload(payload);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const { stickerId, meaning } = parsed;

      // 必须是共享图库里真有的那一张：编号对得上，文件也得在。
      let row = null;
      try {
        row = readMeta().find((item) => item?.id === stickerId) || null;
      } catch (error) {
        return { ok: false, error: `图库索引读不了：${error?.message || error}` };
      }
      if (!row) return { ok: false, error: "图库里没有这张图" };
      const dest = safeStickerPath(STICKERS_DIR, row.file);
      if (!dest || !fs.existsSync(dest)) return { ok: false, error: "图库里这张图的文件不在" };

      const adoptedAt = new Date().toISOString();
      try {
        // 走图库同一条写队列：只动这一行的 usage，标题、原图、标签一概不碰。
        await enqueueToolWrite(() => {
          const stickers = readMeta();
          const target = stickers.find((item) => item?.id === stickerId);
          if (!target) throw new Error("图库里没有这张图");
          target.usage = { meaning, source: caller || USAGE_SOURCE, adopted_at: adoptedAt };
          writeMeta(stickers);
        });
      } catch (error) {
        return { ok: false, error: `写入失败：${error?.message || error}` };
      }

      await sdk.logger?.info?.(`[biaoqingbao] 采用用法: ${stickerId} ← ${meaning}（来自 ${caller}）`);
      return { ok: true, id: stickerId, usage: { meaning } };
    }, { allowCrossApp: true });
    await sdk.logger?.info?.(`采用用法服务已注册：app:biaoqingbao-app/${USAGE_ADOPT_METHOD}`);
    return dispose;
  } catch (error) {
    await sdk?.logger?.warn?.(`采用用法服务注册失败：${error?.message || error}`);
    return null;
  }
}

/** 后台认图：成功就把标签写回那一行；失败只记一笔，图留着。 */
async function applyVisionTags({ sdk, tagger, id, buffer, fileName }) {
  try {
    const ctx = {
      models: sdk?.models, bus: sdk?.bus, network: sdk?.network,
      log: sdk?.logger, dataDir: sdk?.dataDir,
    };
    const result = await tagger(buffer.toString("base64"), fileName, { ctx });
    if (!result?.ok) {
      await sdk?.logger?.warn?.(`[biaoqingbao] 跨应用收图认图失败 ${id}: ${result?.error || "未知原因"}`);
      return;
    }
    const data = result.data || {};
    const tags = {
      emotion: asTagList(data.emotion, 30),
      scene: asTagList(data.scene, 10),
      keywords: asTagList(data.keywords, 30),
    };
    const description = String(data.description || "").slice(0, 100);
    const semantic = String(data.semantic_description || "").slice(0, 300);
    await enqueueToolWrite(() => {
      const stickers = readMeta();
      const row = stickers.find((item) => item?.id === id);
      if (!row) return;
      if (description) row.description = description;
      if (semantic) row.semantic_description = semantic;
      if (tags.emotion.length || tags.scene.length || tags.keywords.length) row.tags = tags;
      row.tagged_at = new Date().toISOString();
      writeMeta(stickers);
    });
    await sdk?.logger?.info?.(`[biaoqingbao] 跨应用收图认图完成 ${id}`);
  } catch (error) {
    await sdk?.logger?.warn?.(`[biaoqingbao] 跨应用收图认图异常 ${id}: ${error?.message || error}`);
  }
}
