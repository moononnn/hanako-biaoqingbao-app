/**
 * 宿主表情包适配层——只读
 *
 * 背景：宿主闲聊自带一套表情包（sticker-pack 扩展），落在 <HANA_HOME>/stickers/<packId>/，
 * 由宿主自己在闲聊协议里注入、自己投递。本 App 另有一套自己的图库，两套互不相识。
 * 这一层只解决「看见」：把宿主已装的包读出来，拼成一份和本 App 图库同构的清单，
 * 供界面展示和后续择图使用。**不涉及发送**，发送链路要另接。
 *
 * 通道选型（2026-10-31 真机实测）：
 *   - 裸 fs 读 <HANA_HOME>：ERR_ACCESS_DENIED——App 子进程的 --allow-fs-read 只有三条
 *     （安装目录、自己的 app-data、宿主语言包），主目录不在其中。
 *   - ctx.resources（ResourceIO 正门）：list 目录、read 文件、stat 图片全部通过，
 *     只要清单里声明了 app/resources.read。
 *   - ctx.network.fetch 打 127.0.0.1：PLUGIN_NETWORK_PRIVATE_HOST_FORBIDDEN，
 *     要 manifest.network.allowLocalhost 才放行。既然 resources 够用，就不走网络。
 *
 * 所以这里刻意不读 server-info.json（那里面有 owner token），只碰 stickers/ 这一支。
 */
import { join } from 'node:path';

// 宿主包的变动是低频的（用户在设置里装/卸才会变），30 秒足够，
// 再短就是每次调用都白扫一遍目录。
const CACHE_TTL_MS = 30 * 1000;

// 宿主注入给模型的清单上限，所有包合计。超出的图模型看不见，面板要标出来。
export const HOST_INJECT_LIMIT = 60;

let cache = null;      // { at: number, data: object }
let inflight = null;   // 同一次扫描并发时共用，省重复 IO

/** ctx.dataDir 是 <HANA_HOME>/app-data/<appId>，上两级就是主目录。 */
function homeOf(dataDir) {
  return join(dataDir, '..', '..');
}

function errText(error) {
  const code = error?.code ? `${error.code} ` : '';
  return `${code}${error?.message || error}`.trim();
}

/** ResourceIO 的 read 回来是 { content, ... }，content 在不同宿主版本里可能是 string 也可能是 Buffer。 */
function textOf(result) {
  const content = result?.content;
  if (typeof content === 'string') return content;
  if (!content) return '';
  try {
    if (typeof content.length === 'number') return Buffer.from(content).toString('utf8');
    if (Array.isArray(content?.data)) return Buffer.from(content.data).toString('utf8');
  } catch {
    // 二进制内容转不了文本就是没有，不是错误
  }
  return '';
}

/** list 的返回形状各版本不统一，能认的几种都认一遍（同 persona-io 的处理）。 */
function namesOf(result) {
  const raw = Array.isArray(result)
    ? result
    : result?.entries ?? result?.items ?? result?.children ?? result?.files ?? result?.content;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === 'string' ? item : item?.name ?? item?.path ?? ''))
    .filter((name) => typeof name === 'string' && name.length > 0);
}

async function readJson(resources, path) {
  const result = await resources.read({ kind: 'local-file', path });
  const text = textOf(result);
  if (!text.trim()) throw new Error('空文件');
  return JSON.parse(text);
}

/**
 * 把宿主一个包目录读成统一形状。
 * 任何一步失败都只影响这一个包，记进 errors，不让整次扫描塌掉。
 */
async function readPack(resources, root, packDirName) {
  const packId = packDirName;
  const dir = join(root, packId);
  const manifest = await readJson(resources, join(dir, 'stickers.json'));

  // 备注单独存在 <HANA_HOME>/stickers/.notes/<packId>.json，以文件名为键。
  // 缺了不算错：没备注的图模型只能看到 id，命中率低，但图本身仍然可用。
  let notes = {};
  try {
    notes = await readJson(resources, join(root, '.notes', `${packId}.json`));
  } catch {
    notes = {};
  }

  const list = Array.isArray(manifest?.stickers) ? manifest.stickers : [];
  const stickers = [];
  for (const item of list) {
    const file = typeof item?.file === 'string' ? item.file : '';
    if (!file) continue;
    const noteEntry = notes?.[file] && typeof notes[file] === 'object' ? notes[file] : null;
    // 清单里偶尔内联了 note（新版宿主），以清单里的为准，没有再退到 .notes。
    const note = typeof item?.note === 'string' && item.note.trim()
      ? item.note.trim()
      : String(noteEntry?.note || '').trim();
    const tags = Array.isArray(item?.tags) && item.tags.length
      ? item.tags.map(String)
      : Array.isArray(noteEntry?.tags) ? noteEntry.tags.map(String) : [];
    stickers.push({
      // 宿主那边这张图的唯一身份，形如 <packId>/<file>。将来要交给宿主投递就用它。
      hostId: `${packId}/${file}`,
      packId,
      file,
      note,
      tags,
      source: 'host',
    });
  }

  return {
    id: packId,
    name: String(manifest?.name || packId),
    version: String(manifest?.version || ''),
    cover: typeof manifest?.cover === 'string' ? manifest.cover : '',
    editable: manifest?.editable !== false,
    stickers,
  };
}

async function scan({ resources, dataDir, log }) {
  if (!resources || typeof resources.read !== 'function' || typeof resources.list !== 'function') {
    return { available: false, reason: 'no-resources', packs: [], stickers: [], errors: [] };
  }
  const home = homeOf(dataDir);
  const root = join(home, 'stickers');

  let dirNames;
  try {
    dirNames = namesOf(await resources.list({ kind: 'local-file', path: root }));
  } catch (error) {
    // 用户一个包都没装过时宿主不建这个目录，这是正常状态，不是故障。
    const text = errText(error);
    const absent = /ENOENT|not found|不存在|NO_SUCH/i.test(text);
    if (!absent) log?.(`host-packs 列目录失败 ${text}`);
    return {
      available: false,
      reason: absent ? 'no-packs' : 'list-failed',
      packs: [],
      stickers: [],
      errors: absent ? [] : [text],
    };
  }

  const packs = [];
  const errors = [];
  for (const name of dirNames) {
    // `.notes` 是备注存储，不是包；其余点开头的一律跳过。
    if (!name || name.startsWith('.')) continue;
    try {
      const pack = await readPack(resources, root, name);
      if (pack.stickers.length) packs.push(pack);
    } catch (error) {
      errors.push({ pack: name, error: errText(error) });
    }
  }

  // Agent 自己的收藏由宿主排在注入清单最前面，这里也照这个顺序放，界面上口径一致。
  packs.sort((a, b) => {
    const ownA = a.id.startsWith('stickers-') ? 0 : 1;
    const ownB = b.id.startsWith('stickers-') ? 0 : 1;
    if (ownA !== ownB) return ownA - ownB;
    return a.id.localeCompare(b.id);
  });

  const stickers = packs.flatMap((pack) => pack.stickers);
  if (errors.length) log?.(`host-packs 部分包读取失败 ${JSON.stringify(errors)}`);

  return {
    available: true,
    reason: packs.length ? 'ok' : 'empty',
    home,
    packs,
    stickers,
    total: stickers.length,
    // 宿主注入只取前 HOST_INJECT_LIMIT 张，超出的模型看不见。
    injectable: stickers.slice(0, HOST_INJECT_LIMIT),
    truncated: Math.max(0, stickers.length - HOST_INJECT_LIMIT),
    errors,
    readAt: new Date().toISOString(),
  };
}

/** 带缓存扫描。并发调用共用同一次读取，避免同时开几个面板就扫几遍。 */
export async function readHostPacks({ resources, dataDir, log, force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await scan({ resources, dataDir, log });
      cache = { at: Date.now(), data };
      return data;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 用户装/卸了宿主包之后要立刻看见变化时调它。 */
export function invalidateHostPacks() {
  cache = null;
}

/** 一行摘要，给启动诊断用。 */
export function summarizeHostPacks(data) {
  if (!data) return 'state=未扫描';
  if (!data.available) return `state=不可用 reason=${data.reason}`;
  const packs = data.packs.map((p) => `${p.name}(${p.stickers.length})`).join('+') || '无';
  const tail = data.truncated ? ` 超额=${data.truncated}` : '';
  return `state=${data.reason} packs=${data.packs.length} stickers=${data.total} [${packs}]${tail}`;
}

// ── 取字节：发送与预览都要用 ─────────────────────────────

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

// 宿主 id 形如 <packId>/<file>。两段都不许带路径分隔与 ..，防止被拼成越界路径。
const HOST_ID = /^([A-Za-z0-9._-]{1,80})\/([A-Za-z0-9._-]{1,120}\.(png|jpe?g|gif|webp|bmp))$/i;

export function isHostStickerId(id) {
  return typeof id === 'string' && HOST_ID.test(id);
}

/**
 * 读一张宿主表情的原始字节。
 * 走 resources.read——裸 fs 读不到 <HANA_HOME>（沙箱只给了三条读根），这一点实测过。
 * 返回 { ok, bytes, mimeType, sticker } 或 { ok: false, error }，不抛。
 */
export async function readHostStickerBytes({ resources, dataDir } = {}, hostId) {
  const matched = HOST_ID.exec(String(hostId || ''));
  if (!matched) return { ok: false, error: '不认识的宿主表情编号' };
  const [, packId, file] = matched;
  if (!resources || typeof resources.read !== 'function') {
    return { ok: false, error: '宿主资源通道不可用' };
  }
  const ext = file.split('.').pop().toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) return { ok: false, error: '不支持的图片类型' };
  try {
    const result = await resources.read({ kind: 'local-file', path: join(homeOf(dataDir), 'stickers', packId, file) });
    const content = result?.content;
    let bytes = null;
    if (Buffer.isBuffer(content)) bytes = content;
    else if (content && typeof content.length === 'number') bytes = Buffer.from(content);
    else if (Array.isArray(content?.data)) bytes = Buffer.from(content.data);
    if (!bytes || !bytes.length) return { ok: false, error: '宿主表情读出来是空的' };
    return {
      ok: true,
      bytes,
      mimeType,
      sticker: { id: `${packId}/${file}`, file, source: 'host' },
    };
  } catch (error) {
    return { ok: false, error: errText(error) };
  }
}
