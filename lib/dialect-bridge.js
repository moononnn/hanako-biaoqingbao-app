// lib/dialect-bridge.js — 从「说方言」应用读方言气质权重
//
// 两个应用各管一摊：方言配置、九种口音的气质权重表都在「说方言」那边，
// 这边只在选图时问一句「这位伙伴现在带什么味儿」，不自己存一份。
//
// 走宿主 bus（app:shuo-fangyan/dialect-bias），不走 HTTP：
// 宿主会给每次调用盖章 callerAppId，对方拿到的是「谁在问」，不是调用方自报的名字。
//
// 读不到一律静默降级成「没有方言气质」，跟没开方言时完全一致：
// 没装对方、没授权、对方没启动、超时，任何一种都不该把发图流程拖住。

const OK_TTL = 60 * 1000;    // 有结果缓存一分钟：改口音后最多一分钟生效，够快
const FAIL_TTL = 10 * 1000;  // 失败缓存十秒：刚装上说方言能很快跟上

const SERVICE = 'app:shuo-fangyan/dialect-bias';

let bus = null;
const cache = new Map();

/** 由入口在 apply 里注入宿主的 bus；没有就一直是 null，全程降级。 */
export function setServiceBus(next) {
  bus = next && typeof next.request === 'function' ? next : null;
  if (!bus) cache.clear();
  return Boolean(bus);
}

export function hasServiceBus() {
  return Boolean(bus);
}

/** 清缓存：测试和不希望等 TTL 的场景用。 */
export function clearDialectBiasCache() {
  cache.clear();
}

/**
 * 拿某个伙伴的方言气质权重。
 * 返回 { label, emotion, intensity } 或 null（没开方言 / 读不到）。
 */
export async function getAgentDialectBias(agentId) {
  const id = String(agentId || '').trim();
  if (!id || !bus) return null;

  const now = Date.now();
  const hit = cache.get(id);
  if (hit && now - hit.at < hit.ttl) return hit.value;

  let value = null;
  let ttl = FAIL_TTL;
  try {
    const resp = await bus.request(SERVICE, { agentId: id }, { timeout: 3000 });
    const data = resp && resp.ok ? resp.data : null;
    value = data && data.bias && typeof data.bias === 'object' ? data.bias : null;
    ttl = OK_TTL;
  } catch {
    // 超时、没权限、对方没起：当没开方言，不抛、不记错日志。
    value = null;
    ttl = FAIL_TTL;
  }
  cache.set(id, { at: now, value, ttl });
  return value;
}
