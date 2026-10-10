/**
 * 宿主通道层：把 App 对宿主文件资源的访问收敛到一处。
 *
 * 为什么会需要这一层：一个实测结论 —— v2 App 的代码跑在开了 Node Permission Model 的子进程里，
 * 宿主写死只给三条读根（安装目录、自己的 app-data、宿主语言包），<hana 主目录>/agents
 * 不在其中。实测读目录、读 config.yaml、读 AGENTS.md、读 sessions，连 existsSync 都一律
 * ERR_ACCESS_DENIED。所以 App 自己永远不能直接 fs 碰伙伴资料。
 *
 * 正门是 ctx.resources（经 RPC 到宿主那份按应用隔离的 ResourceIO）：
 * 盘外读要 app/resources.read，盘外写要 app/resources.write，宿主每次盖章 + 查授权 + 记审计。
 * 茶话会读伙伴人格走的就是这条（见 apps/chahuahui/lib/persona.js 与 index.js 的实测记录）。
 *
 * 服务两处：
 *   - 方言的「人格文件部分」（读写 agents/<id>/AGENTS.md 里的方言块）
 *   - 「学我说话」的语料采集（列并读 agents/<id>/sessions/*.jsonl）
 *
 * 两条通道：
 *   - 宿主注入了 resources（App 运行态）→ 走 resources，这才是真能通的
 *   - 没注入（单测、非 App 运行形态）→ 退回 fs，测试才能用临时目录跑
 *
 * 写人格文件用 writeExpectedVersion 做乐观并发：改之前 stat 拿版本号，
 * 冲突说明期间有人动过这份人格（比如你在设置里改了 ta 的性格），这时宁可不写也不能盲覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';

let resources = null;

/** 由 App 入口在拿到 sdk 后注入。传 null 可以退回 fs 通道（测试用）。 */
export function setPersonaResources(next) {
  resources = next || null;
}

export function getPersonaResources() {
  return resources;
}

function hasHostChannel() {
  return Boolean(resources && typeof resources.read === 'function');
}

/** 宿主错误在各版本里形状不统一（有的是 Error，有的是 { error, code }），挖出可读文本。 */
function describeError(e) {
  if (!e) return '未知错误';
  const code = e.code || e.error?.code || '';
  const msg = e.message || e.error?.message || e.error || String(e);
  return [code, msg].filter(Boolean).join(' ').slice(0, 200);
}

/** 「文件不在」和「没权限/读失败」必须分开：前者当空，后者要报出去，否则用户看不到要授权。 */
function isNotFound(e) {
  const text = describeError(e).toLowerCase();
  return /enoent|not[_ -]?found|does not exist|no such file/.test(text);
}

/**
 * 读一个人格文件。返回 { ok, text }：
 *   ok=false, missing=true → 文件不在，按空内容处理（新建分支）
 *   ok=false, missing=false → 读失败（多半是没授权或真读不动），reason 里带原因
 */
export async function readPersonaText(filePath) {
  if (!hasHostChannel()) {
    try {
      return { ok: true, text: readFileSyncSafe(filePath) };
    } catch (e) {
      return { ok: false, missing: e.code === 'ENOENT', reason: describeError(e) };
    }
  }
  try {
    const result = await resources.read({ kind: 'local-file', path: filePath });
    const content = result?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (content && !Array.isArray(content) && typeof content.toString === 'function') {
      text = content.toString('utf8');
    }
    return { ok: true, text };
  } catch (e) {
    return { ok: false, missing: isNotFound(e), reason: describeError(e) };
  }
}

/** 文件在不在（用来在 AGENTS.md 与 ishiki.md 之间选目标）。 */
export async function personaFileExists(filePath) {
  if (!hasHostChannel()) {
    try {
      readFileSyncSafe(filePath);
      return true;
    } catch {
      return false;
    }
  }
  const read = await readPersonaText(filePath);
  return read.ok;
}

/**
 * 写人格文件，带乐观并发保护。
 * 返回 { ok, path } / { ok:false, reason } / { ok:false, conflict:true }。
 */
export async function writePersonaText(filePath, text) {
  if (!hasHostChannel()) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, text, 'utf-8');
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, reason: describeError(e) };
    }
  }

  // 先 stat 拿当前版本。文件不存在时 version 为 null，退化成普通 write。
  let version = null;
  try {
    const stat = await resources.stat({ kind: 'local-file', path: filePath });
    if (stat && stat.exists === false) version = null;
    else version = stat?.version ?? null;
  } catch (e) {
    if (!isNotFound(e)) {
      // stat 失败不硬着头皮写：宁可不写，也不能在版本不明时覆盖别人的改动。
      return { ok: false, reason: `读版本失败：${describeError(e)}` };
    }
    version = null;
  }

  const ref = { kind: 'local-file', path: filePath };
  try {
    if (typeof resources.writeExpectedVersion === 'function' && version != null) {
      const out = await resources.writeExpectedVersion(ref, text, version);
      if (out && (out.conflict === true || out.status === 'conflict')) {
        return { ok: false, conflict: true, reason: '这份人格文件在你操作期间被改过，为免覆盖对方的内容，这次没写入' };
      }
      return { ok: true, path: filePath };
    }
    await resources.write(ref, text);
    return { ok: true, path: filePath };
  } catch (e) {
    const reason = describeError(e);
    if (/conflict/i.test(reason)) {
      return { ok: false, conflict: true, reason: '这份人格文件在你操作期间被改过，为免覆盖对方的内容，这次没写入' };
    }
    return { ok: false, reason };
  }
}

/**
 * 列一个目录下的文件名（不递归）。
 * 列目录只能用 resources.list —— resources.read 只认文件，拿它撞目录会直接报
 * “resource is not a file”。返回形状各家版本不统一，能认的几种都认一遍。
 * 没注入宿主通道时退回 fs.readdirSync（测试用）。
 */
export async function listDirNames(dirPath) {
  if (!hasHostChannel()) {
    try {
      return fs.readdirSync(dirPath);
    } catch {
      return [];
    }
  }
  try {
    const result = await resources.list({ kind: 'local-file', path: dirPath });
    const raw = Array.isArray(result)
      ? result
      : result?.entries ?? result?.items ?? result?.children ?? result?.files ?? result?.content;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((row) => (typeof row === 'string' ? row : row?.name ?? row?.path ?? null))
      .filter((name) => typeof name === 'string')
      .map((name) => path.basename(name));
  } catch {
    return [];
  }
}

// 仅供 fs 通道使用的同步读。静态引入 node:fs 本身没问题（App 沙箱拦的是调用，不是加载），
// 没注入 resources 时才会真正调到它。
function readFileSyncSafe(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}