/**
 * 宿主表情包 · 去重索引
 *
 * 背景（2026-10-31 实机）：
 *   宿主自己不查重。同一张图发两次，它就收两次，还给两次不同的文件名
 *   （实测「收藏」包里 15 张里就有 2 对字节完全一样，是同一张图被发了两次）。
 *   所以「重复」得由我们这边挡。
 *
 * 两层挡法：
 *   1) 索引层（快）：记住「某个宿主包里的哪张图，是我们从哪个源文件发过去的」。
 *      键用源文件的内容哈希。再次发同一张 → 直接跳过，连上传都不用。
 *   2) 真相层（准）：索引里没有的（以前发过的、在宿主那边手动加的），
 *      靠宿主自己转码后的字节来判断——同一张源图在宿主那儿转出来字节是一样的
 *      （实测），所以把新图传上去、再跟包里其它图的字节比一遍，
 *      相同就把刚传上去那张删掉，等于没发。
 *
 * 索引会过期：宿主里那张图被人删了，索引里还留着，就会误判成「重复」。
 * 所以每次用之前先拿宿主当前的文件清单对一遍，对不上的记录直接扔掉
 * （reconcile）。
 */
import fs from 'node:fs';
import path from 'node:path';

const INDEX_FILE = 'host-sticker-index.json';
const INDEX_VERSION = 1;

/** 空索引。 */
export function emptyIndex() {
  return { version: INDEX_VERSION, packs: {} };
}

/**
 * 读索引。读不出来（文件不存在、坏了）就当空索引——
 * 索引只是加速和辅助判断，缺了不影响发图，只是要多传一次再比字节。
 */
export function loadIndex(dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, INDEX_FILE), 'utf8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object' || !json.packs || typeof json.packs !== 'object') return emptyIndex();
    return { version: json.version || INDEX_VERSION, packs: json.packs };
  } catch {
    return emptyIndex();
  }
}

/** 写索引。写不进去也不能影响发图，吞掉异常即可。 */
export function saveIndex(dataDir, index) {
  try {
    fs.writeFileSync(path.join(dataDir, INDEX_FILE), JSON.stringify(index, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 对账：把索引里「宿主已经没这张图了」的记录清掉。
 * currentFiles 是宿主当前这个包里的文件名清单。
 */
export function reconcile(index, packId, currentFiles) {
  const pack = index.packs[packId];
  if (!pack) return 0;
  const alive = new Set(Array.isArray(currentFiles) ? currentFiles : []);
  let dropped = 0;
  for (const [sourceHash, file] of Object.entries(pack)) {
    if (!alive.has(file)) {
      delete pack[sourceHash];
      dropped += 1;
    }
  }
  if (!Object.keys(pack).length) delete index.packs[packId];
  return dropped;
}

/** 这个包里有没有这张源图（按内容哈希）。返回宿主那边的文件名，没有就返回空串。 */
export function lookup(index, packId, sourceHash) {
  const pack = index.packs[packId];
  if (!pack) return '';
  return pack[sourceHash] || '';
}

/** 记一笔：这个包里，源哈希对应的宿主文件名。 */
export function record(index, packId, sourceHash, file) {
  if (!sourceHash || !file) return index;
  if (!index.packs[packId]) index.packs[packId] = {};
  index.packs[packId][sourceHash] = file;
  return index;
}

/** 索引里这个包记了多少张（调试/自检用）。 */
export function countFor(index, packId) {
  const pack = index.packs[packId];
  return pack ? Object.keys(pack).length : 0;
}
