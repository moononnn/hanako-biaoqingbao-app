/**
 * 宿主闲聊表情包 · 写入层
 *
 * 背景（2026-10-31 实机验证）：
 *   宿主闲聊自带的表情包面板，分类单位是「包」（sticker-pack）。
 *   本 App 另有一套自己的图库，两套互不相识。这个模块负责让本 App 的图库
 *   能**增量**写进宿主的包：新建分类、往分类里加图、删图、写备注。
 *
 * 为什么走 loopback 而不是别的路：
 *   - 宿主的面板由 StickerPackService 管理，包必须登记进宿主的扩展记录，
 *     光往目录里丢文件宿主不认（本机实测：extensions/installs.json 里没有
 *     记录的话，宿主列不出来）。
 *   - App 侧能碰到的正门只有两条：ctx.resources（只读写文件，不碰注册表）
 *     和 ctx.network.fetch（受 manifest.network 白名单管）。
 *   - 所以走 loopback + owner token 调宿主自己的 /api/casual/stickers/* 接口。
 *     这些接口是宿主给「用户自己的界面」用的：建包、加图、删图、写备注。
 *
 * 通道约束（都实测过）：
 *   - token 从 <HANA_HOME>/server-info.json 取，走 ctx.resources；
 *     裸 fs 读主目录会被沙箱拒（ERR_ACCESS_DENIED），别试。
 *   - manifest.network 必须声明 allowLocalhost + 127.0.0.1，且 methods 含
 *     GET/POST/PUT/DELETE。少一条就被宿主挡在门外。
 *   - 上传走 multipart/form-data，字段名固定 files。
 *   - 宿主收到图会自己转码（缩到 512 内、WebP q85），并校验
 *     单张 ≤2MiB、单边 ≤1024px、每包 ≤300 张。
 *
 * token 只在内存里用，不落盘、不外传，目标地址固定 127.0.0.1。
 */
import path from 'node:path';

// 宿主面板的分类单位是包，单包上限 300 张（宿主硬限）。
export const HOST_PACK_MAX = 300;
// 宿主注入给模型时所有包合计只取前 60 张（宿主硬限，超出的静默不出现）。
export const HOST_INJECT_LIMIT = 60;

/** <HANA_HOME> 是 app-data 的上两级。 */
function homeOf(dataDir) {
  return path.join(dataDir, '..', '..');
}

function errText(error) {
  const code = error?.code ? `${error.code} ` : '';
  return `${code}${error?.message || error}`.trim();
}

/**
 * 读 server-info.json 取端口与 owner token。
 * 只走 ctx.resources —— 这是宿主给 App 的盘外读正门。
 */
export async function readServerInfo({ resources, dataDir }) {
  if (!resources || typeof resources.read !== 'function') {
    throw new Error('这个应用拿不到宿主的资源通道，没法跟宿主的表情包面板对话');
  }
  const file = path.join(homeOf(dataDir), 'server-info.json');
  const result = await resources.read({ kind: 'local-file', path: file });
  const content = result?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (content && typeof content.length === 'number') text = Buffer.from(content).toString('utf8');
  else if (Array.isArray(content?.data)) text = Buffer.from(content.data).toString('utf8');
  if (!text.trim()) throw new Error('宿主的服务信息读出来是空的');
  const json = JSON.parse(text);
  if (!Number.isInteger(json.port) || typeof json.token !== 'string' || !json.token.trim()) {
    throw new Error('宿主的服务信息形状不对，可能宿主版本变了');
  }
  return { port: json.port, token: json.token.trim() };
}

/**
 * 组一个 multipart/form-data 请求体。
 * 字段名必须是 files（宿主只认这个）。
 */
export function buildMultipartBody(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('没有要上传的图片');
  const boundary = `----bq${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  const chunks = [];
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
      'utf8'
    ));
    chunks.push(file.bytes);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

/** 宿主这几条接口都回 JSON，出错时也是 JSON。 */
async function readJson(response) {
  const text = await response.text().catch(() => '');
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 300) || '宿主返回的不是 JSON' }; }
}

/**
 * 宿主表情包客户端。
 * 每次调用都现读一次 token —— token 是本机进程级的短期凭据，
 * 宿主重启后会变，缓存反而容易拿着旧值去撞 401。
 */
export async function createHostStickerClient({ sdk, dataDir }) {
  const fetcher = sdk?.network?.fetch;
  if (typeof fetcher !== 'function') {
    throw new Error('这个应用没有联网通道，没法把图发到宿主的表情包面板');
  }
  const info = await readServerInfo({ resources: sdk.resources, dataDir });

  const base = `http://127.0.0.1:${info.port}`;
  const auth = { Authorization: `Bearer ${info.token}` };

  async function call(method, route, { body, headers, timeoutMs } = {}) {
    const response = await fetcher(`${base}${route}`, {
      method,
      headers: { ...auth, ...(headers || {}) },
      ...(body === undefined ? {} : { body }),
      timeoutMs: timeoutMs ?? 60000,
    });
    const json = await readJson(response);
    if (!response.ok) {
      throw new Error(json?.error || `宿主接口返回 ${response.status}`);
    }
    return json;
  }

  return {
    /** 宿主面板现有的分类（包）。 */
    async listPacks() {
      const json = await call('GET', '/api/casual/stickers');
      const packs = Array.isArray(json.packs) ? json.packs : [];
      return packs.map((pack) => ({
        id: pack.id,
        name: pack.name,
        count: Array.isArray(pack.stickers) ? pack.stickers.length : 0,
        // 只有本地自建的包能继续加图；装进来的包宿主只让导出。
        editable: pack.editable === true,
        // 去重要用：包里现在有哪些文件。
        files: Array.isArray(pack.stickers)
          ? pack.stickers.map((item) => item.file).filter(Boolean)
          : [],
      }));
    },

    /**
     * 取一张图在宿主那边的字节。
     * 去重靠它：同一张源图在宿主那儿转出来字节一样，比字节就知道是不是同一张。
     */
    async fetchStickerBytes(packId, file) {
      const response = await fetcher(
        `${base}/api/casual/stickers/file/${encodeURIComponent(packId)}/${encodeURIComponent(file)}`,
        { method: 'GET', headers: { ...auth }, timeoutMs: 30000 },
      );
      if (!response.ok) throw new Error(`宿主取图失败 ${response.status}`);
      if (typeof response.arrayBuffer === 'function') {
        return Buffer.from(await response.arrayBuffer());
      }
      if (typeof response.buffer === 'function') return Buffer.from(await response.buffer());
      const text = await response.text();
      return Buffer.from(text, 'binary');
    },

    /** 新建一个分类。宿主会给它一个可编辑的 id。 */
    async createPack(name) {
      const clean = String(name || '').trim();
      if (!clean) throw new Error('分类得有个名字');
      const json = await call('POST', '/api/casual/stickers/packs', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clean }),
      });
      const pack = json.pack;
      if (!pack?.id) throw new Error('宿主没给新分类的编号');
      return { id: pack.id, name: pack.name, editable: pack.editable === true };
    },

    /**
     * 往一个分类里加图。
     * files: [{ name, type, bytes, note? }]
     * 宿主会自己转码；note 是模型挑图的唯一线索，能给就带上。
     * 返回宿主实际落库的文件名，按上传顺序对应。
     */
    async addStickers(packId, files) {
      const { boundary, body } = buildMultipartBody(files);
      const json = await call('POST', `/api/casual/stickers/packs/${encodeURIComponent(packId)}/stickers`, {
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        timeoutMs: 120000,
      });
      const pack = json.pack;
      const added = Array.isArray(pack?.stickers) ? pack.stickers : [];
      return { packId, count: added.length, files: added.map((item) => item.file) };
    },

    /** 给某张图写备注。 */
    async setNote(packId, file, note, tags) {
      const payload = {};
      if (typeof note === 'string') payload.note = note;
      if (Array.isArray(tags) && tags.length) payload.tags = tags.map(String);
      if (!Object.keys(payload).length) return false;
      await call('PUT', `/api/casual/stickers/${encodeURIComponent(packId)}/${encodeURIComponent(file)}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return true;
    },

    /** 从分类里删一张图。 */
    async deleteSticker(packId, file) {
      await call('DELETE', `/api/casual/stickers/packs/${encodeURIComponent(packId)}/stickers/${encodeURIComponent(file)}`);
      return true;
    },

    /**
     * 自查：发完的图是不是真的能取到。
     *
     * 为什么要多这一步：
     *   「宿主接口说收到了」和「面板里能显示出来」是两件事。宿主把图收下、
     *   登记进包，都不代表面板那张 <img> 一定拿得到字节。
     *   所以发完直接按宿主给的文件名去取一遍，取得到才算数，取不到就把
     *   缺的那些报出来——别让界面显示一句「导入成功」，实际面板是空的。
     */
    async verifyStickerFiles(packId, files) {
      const list = Array.isArray(files) ? files.filter(Boolean) : [];
      if (!list.length) return { total: 0, ok: 0, missing: [] };
      const missing = [];
      let ok = 0;
      for (const file of list) {
        try {
          const response = await fetcher(
            `${base}/api/casual/stickers/file/${encodeURIComponent(packId)}/${encodeURIComponent(file)}`,
            { method: 'GET', headers: { ...auth }, timeoutMs: 20000 },
          );
          if (response.ok) ok += 1;
          else missing.push({ file, status: response.status });
        } catch (error) {
          missing.push({ file, error: errText(error) });
        }
      }
      return { total: list.length, ok, missing };
    },

    /** 删掉整个分类。 */
    async deletePack(packId) {
      await call('DELETE', `/api/casual/stickers/packs/${encodeURIComponent(packId)}`);
      return true;
    },

    /**
     * 让宿主把表情包分类列表重拉一遍。
     *
     * 为什么需要这一步（2026-11-01 实机查出来的）：
     *   宿主渲染层把「聊天表情包」的分类列表缓存在自己的 store 里，
     *   刷新时机只有一个——收到 plugin_ui_changed 广播。
     *   宿主自己的界面加图时是同一个进程里改的状态，它顺手就重拉了；
     *   而我们这个 App 是宿主进程之外的另一个进程，走 loopback 直接写盘，
     *   宿主全程不知情 → 面板一直拿着旧列表（新加的图明明在包里，就是不显示）。
     *
     *   宿主没给「刷新表情包」这个正门，但把某个分类的启用状态原样写回一次，
     *   会广播 plugin_ui_changed，面板就跟着重拉了。状态没变，纯粹是个信号。
     *   这个分类本来就是可编辑的自建包、一直是启用的，所以写回同一个值是安全的。
     */
    async refreshHostPanel(packId) {
      const ref = `sticker-pack:${packId}`;
      const encoded = encodeURIComponent(ref);
      // 先读当前状态，再原样写回：万一是被停用的包，别顺手把它打开。
      let enabled = true;
      try {
        const json = await call('GET', `/api/extensions/${encoded}`);
        if (typeof json?.hostEnabled === 'boolean') enabled = json.hostEnabled;
      } catch { /* 读不到就按启用写，写回去的是同一个值 */ }
      await call('PUT', `/api/extensions/${encoded}/enabled`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      return true;
    },
  };
}

/**
 * 把本 App 图库里的一个条目变成可上传的文件。
 * 备注取 description，没有就退到 semantic_description —— 模型只能看见 note，
 * 一句空备注等于这张图在模型眼里没有说明书。
 */
export function toUploadFile(sticker, bytes) {
  const note = String(sticker?.description || sticker?.semantic_description || '').trim();
  const file = String(sticker?.file || 'sticker.png').replace(/[^\w.-]/g, '_');
  return {
    name: file,
    type: 'application/octet-stream',
    bytes,
    note,
  };
}
