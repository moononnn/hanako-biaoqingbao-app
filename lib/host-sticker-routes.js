/**
 * 宿主闲聊表情包 · 路由层
 *
 * 给「把本 App 图库里的图，发到宿主闲聊表情包面板」这件事提供后端接口。
 *
 * 两条路由：
 *   GET  /api/host-stickers/packs        列宿主面板现有的分类
 *   POST /api/host-stickers/send         把选中的图发进某个分类（可指定新建）
 *
 * 权限：这几条只在本机面板里用，跟输入栏那个表情面板不是一回事，
 * 所以不走 ticket 那套；改用「本机来源 + 页面凭据标记」双层判断。
 * 真正要紧的是 token：它只存在于本机内存，外部即使能调到这个路由，
 * 也拿不到 token 去调宿主接口。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { createHostStickerClient, toUploadFile, HOST_PACK_MAX } from './host-sticker-writer.js';
import { readHostPacks } from './host-packs.js';
import { loadIndex, saveIndex, reconcile, lookup, record } from './host-sticker-index.js';
import { readMeta } from './shared.js';

/** 一次最多发多少张。单包上限 300，这里留个更保守的数。 */
const MAX_SEND_PER_CALL = 60;

/**
 * 鉴权口径（2026-11-01 收紧）：
 *   原来只把凭据标记记进日志、不阻断，好处是绝不断链，坏处是网页向本机端口
 *   发一个简单请求就能触发写路由（借应用内存里的 token 代写宿主包）。
 *   现在改成必须带凭据：本 App 的页面本身就会带（withAuth 会给每个请求缀上
 *   appSurfaceSession 或 token，见 ui/assets/sticker-manager.js），所以断链风险
 *   集中在「没带参数的旧页面」，那种情况下宁可报错也不放行。
 *
 *   真正的安全边界仍在 token：写操作要经 loopback 调宿主接口，而宿主接口要
 *   owner token，那个 token 只存在 App 进程内存里。
 */
function hasCredential(c) {
  let headers = null;
  try { headers = c.req.header ? c.req.header() : null; } catch { headers = null; }
  let query = null;
  try { query = c.req.query ? c.req.query() : null; } catch { query = null; }
  const headerNames = headers && typeof headers === 'object' ? Object.keys(headers) : [];
  const queryKeys = query && typeof query === 'object' ? Object.keys(query) : [];
  const headerHit = headerNames.some((name) => /session|token|auth/i.test(name));
  const queryHit = queryKeys.some((name) => /session|token|auth/i.test(name));
  return { ok: headerHit || queryHit, headerNames, queryKeys };
}

/**
 * 只接本机来源。
 *
 * Host 头缺失时不单独拦截——但也不因此放行：真正的通行证是凭据标记，
 * 空 Host + 无凭据的组合在下面照样被拒。
 */
function isLocalRequest(c) {
  const host = c.req.header('host') || '';
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host) || host === '';
}

function requireHostPage(c, dataDir, kind) {
  if (!isLocalRequest(c)) {
    throw Object.assign(new Error('这个接口只接本机发来的请求'), { status: 403 });
  }
  const seen = hasCredential(c);
  if (!seen.ok) {
    diag(dataDir, `${kind} 请求没带凭据标记 头=[${seen.headerNames.join(',')}] query=[${seen.queryKeys.join(',')}]`);
    throw Object.assign(new Error('这个接口只接带凭据的本机页面请求'), { status: 403 });
  }
  return seen;
}

function badRequest(c, error) {
  const status = Number(error?.status) || 400;
  return c.json({ ok: false, error: String(error?.message || error) }, status);
}

/** 源文件内容哈希：去重的一级键。 */
function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** 某个分类现在有哪些文件（拿不到就当空数组，不阻断发图）。 */
async function currentPackFiles(host, packId) {
  try {
    const packs = await host.listPacks();
    const found = packs.find((pack) => pack.id === packId);
    return found && Array.isArray(found.files) ? found.files : [];
  } catch {
    return [];
  }
}

/** 宿主里某张图的内容哈希。取不到就返回空串。 */
async function contentHashOf(host, packId, file) {
  try {
    const bytes = await host.fetchStickerBytes(packId, file);
    return hashBytes(bytes);
  } catch {
    return '';
  }
}

/**
 * 一次别传太大。
 *
 * 宿主往我们这边发消息（App RPC）有 32 MiB 上限，一次上传一堆大图就会撞上，
 * 报「App RPC message exceeds the 32 MiB limit」，整批失败。
 * 所以按体积和张数切块，每块远小于上限。
 */
const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_FILES = 6;

function splitUploadChunks(candidates) {
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const candidate of candidates) {
    const size = candidate.bytes.length;
    if (current.length && (bytes + size > MAX_UPLOAD_CHUNK_BYTES || current.length >= MAX_UPLOAD_CHUNK_FILES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(candidate);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * 把选中的图传进宿主包。
 *
 * 两件事：
 *   1. 分块传（见上），别一次撑爆 RPC；
 *   2. 一块里有一张传不进去（比如 12MB 的动图，宿主压缩后仍超限），
 *      不连坐整块——退回去逐张重试，把能发的挑出来，失败的那张单独报出来。
 *
 * 返回：{ added: [{ file, candidate }], failures: [{ stickerId, file, error }] }
 */
async function uploadCandidates(host, packId, candidates) {
  const added = [];
  const failures = [];
  const known = new Set(await currentPackFiles(host, packId));

  // 传完拉一次清单，取新增的文件（宿主上传接口回的是整包清单，不能直接用）。
  async function collect(cands) {
    const files = await currentPackFiles(host, packId);
    const fresh = files.filter((file) => !known.has(file));
    for (const file of fresh) known.add(file);
    for (let i = 0; i < fresh.length; i += 1) {
      const candidate = cands[Math.min(i, cands.length - 1)];
      if (candidate) added.push({ file: fresh[i], candidate });
    }
  }

  for (const chunk of splitUploadChunks(candidates)) {
    try {
      await host.addStickers(packId, chunk.map((c) => toUploadFile(c.sticker, c.bytes)));
      await collect(chunk);
    } catch (error) {
      for (const candidate of chunk) {
        try {
          await host.addStickers(packId, [toUploadFile(candidate.sticker, candidate.bytes)]);
          await collect([candidate]);
        } catch (oneError) {
          failures.push({
            stickerId: candidate.sticker.id,
            file: candidate.sticker.file,
            error: errText(oneError),
          });
        }
      }
    }
  }
  return { added, failures };
}

/** 包里现有各图的内容哈希表（内容哈希 → 文件名）。 */
async function contentHashesOf(host, packId, files) {
  const table = new Map();
  for (const file of files || []) {
    const hash = await contentHashOf(host, packId, file);
    if (hash && !table.has(hash)) table.set(hash, file);
  }
  return table;
}

function errText(error) {
  const code = error?.code ? `${error.code} ` : '';
  return `${code}${error?.message || error}`.trim();
}

/**
 * 诊断日志：写进 App 自己的 app-data/probe.log。
 * 这条链路的失败原因（token 读不到、网络被拦、路由没注册）光看界面猜不出来，
 * 落地成一行行文本，后面排查才有抓手。
 */
function diag(dataDir, message) {
  try {
    fs.appendFileSync(path.join(dataDir, 'probe.log'), `${new Date().toISOString()} host-sticker ${message}\n`);
  } catch { /* 日志写不进去不该影响主流程 */ }
}

export function registerHostStickerRoutes(app, sdk) {
  const dataDir = sdk.dataDir;

  const client = async () => createHostStickerClient({ sdk, dataDir });

  /**
   * 列宿主面板现有的分类。
   *
   * 两条路都走一遍：
   *   主路 loopback：调宿主自己的 /api/casual/stickers，editable 标记权威，
   *     建分类、加图也走这条，所以这条通不通决定「能不能发」。
   *   备路 本机目录：ctx.resources 直接读 <HANA_HOME>/stickers 下的包目录，
   *     不需要 token。loopback 走不通时，至少还能把分类名称摆出来，
   *     而不是让界面停在「读不到分类」。
   *
   * 返回里带上 source（列表从哪来）与 warnings（主路为什么不通），
   * 界面据此把「能看但发不出去」这件事说清楚。
   */
  app.get('/api/host-stickers/packs', async (c) => {
    try {
      requireHostPage(c, dataDir, 'packs');
      const warnings = [];
      let packs = null;
      let source = '';

      try {
        packs = await (await client()).listPacks();
        source = 'host';
      } catch (error) {
        const text = errText(error);
        warnings.push('宿主接口没读通：' + text);
        diag(dataDir, `packs loopback 失败 ${text}`);
      }

      if (!packs) {
        try {
          const data = await readHostPacks({ resources: sdk.resources, dataDir, force: true });
          packs = data.packs.map((pack) => ({
            id: pack.id,
            name: pack.name,
            count: pack.stickers.length,
            editable: pack.editable !== false,
          }));
          source = 'fs';
          diag(dataDir, `packs 走本机目录 packs=${packs.length}`);
        } catch (error) {
          const text = errText(error);
          warnings.push('本机目录也没读通：' + text);
          diag(dataDir, `packs 目录兜底也失败 ${text}`);
        }
      }

      if (!packs) {
        return c.json({ ok: false, error: warnings.join('；') || '读不到宿主分类' }, 500);
      }
      return c.json({ ok: true, packs, source, warnings, writable: source === 'host' });
    } catch (error) {
      diag(dataDir, `packs 路由异常 ${errText(error)}`);
      return badRequest(c, error);
    }
  });

  /**
   * 把选中的图发进宿主分类。
   *
   * body: { stickerIds: [...], packId?: 'host:xxx', packName?: '新分类名' }
   *   给了 packId 就发进那个分类；只给 packName 就先建分类再发。
   *
   * 图从本 App 自己的图库里取（不是收藏），选哪张发哪张。
   */
  app.post('/api/host-stickers/send', async (c) => {
    try {
      requireHostPage(c, dataDir, 'send');
      const body = await c.req.json().catch(() => ({}));
      const ids = Array.isArray(body?.stickerIds)
        ? body.stickerIds.map((value) => String(value ?? '').trim()).filter(Boolean)
        : [];
      if (!ids.length) return c.json({ ok: false, error: '没选中图' }, 400);
      if (ids.length > MAX_SEND_PER_CALL) {
        return c.json({ ok: false, error: `一次最多发 ${MAX_SEND_PER_CALL} 张` }, 400);
      }

      const meta = readMeta();
      const byId = new Map(meta.map((item) => [item.id, item]));
      const picked = ids.map((id) => byId.get(id)).filter(Boolean);
      if (!picked.length) {
        return c.json({ ok: false, error: '选中的图都不在图库里了' }, 400);
      }

      const host = await client();

      // 目标分类：指定了就用，没指定就按名字新建一个。
      const packId = String(body?.packId || '').trim();
      const packName = String(body?.packName || '').trim();
      let target;
      if (packId) {
        const id = packId.startsWith('host:') ? packId.slice(5) : packId;
        let existing = [];
        try {
          existing = await host.listPacks();
        } catch (error) {
          const text = errText(error);
          diag(dataDir, `send listPacks 失败 ${text}`);
          return c.json({ ok: false, error: '宿主接口没读通，这次发不过去：' + text }, 400);
        }
        const found = existing.find((pack) => pack.id === id);
        if (!found) return c.json({ ok: false, error: '那个分类已经不在宿主面板里了' }, 400);
        if (!found.editable) {
          return c.json({
            ok: false,
            error: `「${found.name}」是装进来的表情包，宿主不让往里加图。换个分类，或者新建一个。`,
          }, 400);
        }
        if (found.count + picked.length > HOST_PACK_MAX) {
          return c.json({ ok: false, error: `「${found.name}」再有 ${HOST_PACK_MAX - found.count} 张就满了` }, 400);
        }
        target = { id: found.id, name: found.name };
      } else if (packName) {
        target = await host.createPack(packName);
      } else {
        return c.json({ ok: false, error: '没说发到哪个分类' }, 400);
      }

      // 读图 + 内容哈希（去重的一级键）。
      // 路径先规整、再确认落在自己的 stickers 目录里：file 来自本应用自己的
      // stickers.json，不是请求参数，但少一道包含性校验就少一层兜底。
      const stickerRoot = path.resolve(dataDir, 'stickers');
      const candidates = [];
      const skipped = [];
      for (const sticker of picked) {
        const filePath = path.resolve(stickerRoot, String(sticker.file || ''));
        if (filePath !== stickerRoot && !filePath.startsWith(stickerRoot + path.sep)) {
          diag(dataDir, `跳过去向异常的图 id=${sticker.id} file=${sticker.file}`);
          skipped.push(sticker.id);
          continue;
        }
        let bytes;
        try {
          bytes = fs.readFileSync(filePath);
        } catch {
          skipped.push(sticker.id);
          continue;
        }
        candidates.push({
          sticker,
          bytes,
          sourceHash: hashBytes(bytes),
          note: toUploadFile(sticker, bytes).note,
        });
      }
      if (!candidates.length) {
        return c.json({ ok: false, error: '选中的图都读不出来，可能已经被删了' }, 400);
      }

      // ── 去重（两层）──────────────────────────────────────────────
      // 宿主自己不查重：同一张图发两次它就收两次，还给两次不同的文件名。
      // 所以重复得在我们这边挡。
      const index = loadIndex(dataDir);
      const packFiles = await currentPackFiles(host, target.id);
      reconcile(index, target.id, packFiles);

      // 第一层：索引里有的直接跳过，不上传。
      const duplicates = [];
      const pending = [];
      const batchSeen = new Set();
      for (const candidate of candidates) {
        const known = lookup(index, target.id, candidate.sourceHash);
        if (known && packFiles.includes(known)) {
          duplicates.push({ stickerId: candidate.sticker.id, file: known, how: '索引' });
          continue;
        }
        if (batchSeen.has(candidate.sourceHash)) {
          duplicates.push({ stickerId: candidate.sticker.id, file: '', how: '本次重复' });
          continue;
        }
        batchSeen.add(candidate.sourceHash);
        pending.push(candidate);
      }

      if (!pending.length) {
        saveIndex(dataDir, index);
        diag(dataDir, `发送去重：全是重复 pack=${target.id} 重复=${duplicates.length}`);
        return c.json({
          ok: true,
          pack: { id: target.id, name: target.name },
          sent: 0,
          noted: 0,
          skipped: skipped.length,
          duplicates,
          verify: { total: 0, ok: 0, missing: [] },
        });
      }

      // 宿主自己会转码（缩到 512 内、WebP q85）。
      // 分块传 + 单张失败不连坐（超大动图之类会被宿主拒，不该把整批拖下水）。
      const upload = await uploadCandidates(host, target.id, pending);
      const failed = upload.failures;

      // 第二层：真相层。索引里没有的（以前发过的、宿主那边手动加的），
      // 靠宿主转码后的字节判断是不是同一张——同一张源图转出来字节一样。
      // 相同就把刚传上去那张删掉，等于没发。
      let kept = [];
      if (upload.added.length) {
        const existingHashes = await contentHashesOf(host, target.id, packFiles);
        for (const entry of upload.added) {
          const hosted = entry.file;
          const candidate = entry.candidate;
          if (!hosted || !candidate) continue;
          const hash = await contentHashOf(host, target.id, hosted);
          const same = hash && existingHashes.get(hash);
          if (same && same !== hosted) {
            try {
              await host.deleteSticker(target.id, hosted);
              duplicates.push({ stickerId: candidate.sticker.id, file: same, how: '内容相同' });
              record(index, target.id, candidate.sourceHash, same);
              continue;
            } catch (error) {
              diag(dataDir, `删重复图失败 ${errText(error)}`);
            }
          }
          kept.push({ file: hosted, candidate });
          record(index, target.id, candidate.sourceHash, hosted);
          if (hash) existingHashes.set(hash, hosted);
        }
      }
      saveIndex(dataDir, index);
      diag(dataDir, `发送去重 pack=${target.id} 新增=${kept.length} 重复=${duplicates.length} 失败=${failed.length}`);
      for (const one of failed) diag(dataDir, `发送失败 ${one.file}: ${one.error}`);

      // 清掉已经没有的包的索引（分类被删了，索引留着没用还越攒越多）。
      try {
        const alive = new Set((await host.listPacks()).map((pack) => pack.id));
        for (const key of Object.keys(index.packs)) {
          if (!alive.has(key)) delete index.packs[key];
        }
        saveIndex(dataDir, index);
      } catch { /* 清不清无所谓，不影响发图 */ }

      // 写备注：note 是模型挑图的唯一线索，一张没有备注的图等于在模型眼里没说明书。
      // 宿主加图时只存文件名，备注得另写一条。
      let noted = 0;
      for (const entry of kept) {
        if (!entry.file || !entry.candidate.note) continue;
        try {
          if (await host.setNote(target.id, entry.file, entry.candidate.note)) noted += 1;
        } catch { /* 备注写不进去不影响图本身进包 */ }
      }

      // 自查：按宿主给的文件名去取一遍，取得到才算真的进去了。
      // 「宿主说收到了」和「面板里能显示出来」不是一回事，这一步就是把两者对上。
      const keptFiles = kept.map((entry) => entry.file);
      let verify = { total: 0, ok: 0, missing: [] };
      try {
        verify = await host.verifyStickerFiles(target.id, keptFiles);
        diag(dataDir, `发送自查 pack=${target.id} ok=${verify.ok}/${verify.total} 缺=${verify.missing.length}`);
      } catch (error) {
        diag(dataDir, `发送自查失败 ${errText(error)}`);
      }

      // 通知宿主把分类列表重拉一遍。
      // 宿主渲染层缓存着这份列表，只认 plugin_ui_changed 广播才会重拉；
      // 我们是外部进程写盘，宿主不知情 → 面板停在旧列表，用户看不到刚发的图。
      let panelRefreshed = false;
      try {
        await host.refreshHostPanel(target.id);
        panelRefreshed = true;
      } catch (error) {
        diag(dataDir, `刷新宿主面板失败 ${errText(error)}`);
      }

      return c.json({
        ok: true,
        pack: { id: target.id, name: target.name },
        sent: keptFiles.length,
        noted,
        skipped: skipped.length,
        duplicates,
        failed,
        verify,
        panelRefreshed,
      });
    } catch (error) {
      return badRequest(c, error);
    }
  });
}
