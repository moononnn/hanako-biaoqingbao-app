/**
 * 统一取网络请求器。
 *
 * App 子进程默认没有联网权限，直接 fetch 会被运行时拒掉。
 * 宿主开了一扇受控出口：ctx.network.fetch，按清单里 network.allowedHosts 逐条校验主机。
 * 这里统一取：有受管出口就用它，没有（插件环境、或本地回环）才退回全局 fetch。
 *
 * 三处用途（都是用户自己填的第三方接口，性质上该放行）：
 *   · 向量服务（自定义 embedding）
 *   · Jev
 *   · 检查更新（GitHub）
 */

/** 取一个可用的请求器。 */
export function resolveFetcher(ctx) {
  const hosted = ctx?.network?.fetch;
  if (typeof hosted === 'function') return hosted.bind(ctx.network);
  return globalThis.fetch.bind(globalThis);
}

/** 从网址里取主机名。 */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}

/**
 * 出网失败时把话说清楚。
 *
 * 被清单白名单拦下是「没授权」，跟网络不通、服务挂了不是一回事，
 * 提示得分开说 —— 否则用户会去查自己的网，白费功夫。
 */
export function describeNetworkError(url, error) {
  const host = hostOf(url);
  const raw = String(error?.message || error || '');
  if (/Access to this API has been restricted|ERR_ACCESS_DENIED|not allowed|denied/i.test(raw)) {
    return host
      ? `这个应用没有联网到 ${host} 的授权（清单里的域名白名单里没有它）`
      : '这个应用没有联网授权';
  }
  if (/fetch failed|econnreset|enotfound|eai_again|timeout|timed out|socket hang/i.test(raw)) {
    return host ? `连不上 ${host}，多半是网络或对方服务的问题` : '网络连不上';
  }
  return raw || '联网失败';
}
