// lib/tool-name.js - 解析模型侧看得见的 express 工具名
//
// 背景（2026-10-17 实测）：宿主 1.0.16-beta 及更早，App 工具对模型就是短名 `express`，
// 注入文案直呼其名就能调通。1.1.x 起，App 工具以 `app__<appId>__<工具名>_<hash>`
// 的完整名进入延迟工具目录，裸喊 `express` 会被判「未知工具」。
//
// 这里不去猜命名规则，直接向宿主问当前会话的活跃工具名单（session:tools），
// 从中挑出表情包自己的 express。拿到什么名字就用什么名字，宿主将来改回短名也能自洽。
// 查不到就返回 null，注入文案退回旧的短名写法，不影响配图主流程。

const CACHE_TTL_MS = 5 * 60 * 1000;
// 查失败也记一笔短冷却：会话没有 manifest 时宿主会直接拒，没必要每轮都去碰。
const FAIL_TTL_MS = 60 * 1000;

let cache = { name: null, at: 0, failedAt: 0, source: '' };
let lastDiag = '';

export function getExpressToolNameDiag() {
  return lastDiag;
}

// 从宿主给的名字数组里挑出表情包 express。含 biaoqingbao 的优先，其次才是裸 express。
export function pickExpressToolName(names) {
  if (!Array.isArray(names)) return null;
  const list = names.filter((n) => typeof n === 'string' && n);
  const owned = list.find((n) => /express/i.test(n) && /biaoqingbao/i.test(n));
  if (owned) return owned;
  const bare = list.find((n) => n === 'express');
  return bare || null;
}

// sdk 是 index.js 传给观察器的应用 SDK；sessionId 取 pre-step payload 里的会话编号。
export async function resolveExpressToolName(sdk, sessionId) {
  const now = Date.now();
  if (cache.name && now - cache.at < CACHE_TTL_MS) return cache.name;
  if (cache.failedAt && now - cache.failedAt < FAIL_TTL_MS) return cache.name || null;
  if (!sessionId) { lastDiag = 'no-session'; cache.failedAt = now; return cache.name || null; }
  if (typeof sdk?.sessions?.tools !== 'function') { lastDiag = 'no-api'; cache.failedAt = now; return cache.name || null; }
  try {
    const res = await sdk.sessions.tools({ sessionId });
    const names = Array.isArray(res?.toolNames) ? res.toolNames : [];
    const name = pickExpressToolName(names);
    lastDiag = `names=${names.length} hit=${name || 'miss'}`;
    if (name) {
      cache = { name, at: now, failedAt: 0, source: 'session:tools' };
      return name;
    }
    cache.failedAt = now;
  } catch (e) {
    // 宿主不给名单：把原因留在诊断字段里，别让异常盖住真正的配图流程
    lastDiag = `err=${e?.code || ''} ${e?.message || e}`.slice(0, 160);
    cache.failedAt = now;
  }
  return cache.name || null;
}

// 完整名拆成 tool_call 要的两个参数：`app__<appId>__<工具名>_<hash>`。
// 拆不出来就返回 null，调用方走旧的短名句式。
export function splitExpressToolName(full) {
  if (typeof full !== 'string') return null;
  const m = /^app__(.+?)__(.+)$/.exec(full);
  if (!m) return null;
  return { server: m[1], tool: full };
}

// 从会话消息里找出宿主写给模型的工具清单。宿主给每个会话开头塞过一份
// hana-envelope/reference，里面就列着 `app__<appId>__express_<hash>` 这种完整名。
// 这是零权限、零额外请求的取名字路线：模型能看到什么，我们就从同一处拿。
const FULL_NAME_RE = /app__[A-Za-z0-9._-]+?__express_[0-9a-f]{6,}/;

export function pickExpressToolNameFromMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    const content = m?.content;
    if (typeof content === 'string') {
      const hit = content.match(FULL_NAME_RE);
      if (hit) return hit[0];
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      const text = typeof c === 'string' ? c : (c?.text || '');
      if (!text) continue;
      const hit = text.match(FULL_NAME_RE);
      if (hit) return hit[0];
    }
  }
  return null;
}

// 只给测试和排障用：清掉缓存，强制下一次重新问宿主。
export function resetExpressToolNameCache() {
  cache = { name: null, at: 0, failedAt: 0, source: '' };
  lastDiag = '';
}

export function getExpressToolNameCache() {
  return { ...cache };
}
