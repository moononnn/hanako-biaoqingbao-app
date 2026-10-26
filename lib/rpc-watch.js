// lib/rpc-watch.js - App 侧 RPC 在飞计数
//
// 2026-10-26：宿主给每个 App 的那条 RPC 通道有 128 个待处理位，占满就回
// APP_RPC_BUSY（宿主 app-host-entry.js 的 MAX_PENDING）。日志里一小时上千条
// 「adjudicator threw ... App RPC concurrency limit reached」，但光看这句话不知道
// 是谁占着：可能是某类调用排得太多，也可能是有请求永远不回、把槽漏光了。
//
// 所以这里只做一件事：把 sdk.bus.request 包一层，记下每条请求的方法名和开始时间；
// 撞上限时把「在飞多少、峰值多少、最老一条等了多久、哪几种方法占得最多」写进日志。
// 不改超时、不改重试、不拦请求——它只是秤。

import { isRpcBusyError } from './rpc-retry.js';

/**
 * @param {{now?:()=>number}} [options]
 */
export function createRpcWatch({ now = () => Date.now() } = {}) {
  const inflight = new Map();
  let seq = 0;
  let peak = 0;
  let total = 0;
  let busy = 0;
  let lastBusy = null;

  function enter(method) {
    const id = ++seq;
    inflight.set(id, { method: String(method ?? '?'), at: now() });
    total += 1;
    if (inflight.size > peak) peak = inflight.size;
    return id;
  }

  /** 当前在飞的样子：条数、峰值、最老等待、按方法分组的前几名。 */
  function snapshot() {
    const byMethod = new Map();
    for (const row of inflight.values()) {
      byMethod.set(row.method, (byMethod.get(row.method) || 0) + 1);
    }
    const top = [...byMethod.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([method, count]) => `${method}x${count}`)
      .join(',');
    const ages = [...inflight.values()].map((row) => Math.max(0, now() - row.at)).sort((a, b) => b - a);
    return {
      inflight: inflight.size,
      peak,
      total,
      busy,
      oldestMs: ages[0] ?? 0,
      p50Ms: ages.length ? ages[Math.floor(ages.length / 2)] : 0,
      top,
    };
  }

  /**
   * 包一层 request。语义完全照旧：返回值、异常、超时都原样透出，
   * 只在撞上限那一刻多记一笔。
   */
  function wrap(request) {
    if (typeof request !== 'function') return request;
    return async function watchedRequest(method, params, options) {
      const id = enter(method);
      try {
        return await request(method, params, options);
      } catch (error) {
        if (isRpcBusyError(error)) {
          busy += 1;
          lastBusy = { method: String(method ?? '?'), ...snapshot() };
        }
        throw error;
      } finally {
        inflight.delete(id);
      }
    };
  }

  return {
    wrap,
    snapshot,
    /** 最近一次撞上限时的现场，没撞过是 null。 */
    lastBusy: () => lastBusy,
    reset() {
      inflight.clear();
      peak = 0;
      total = 0;
      busy = 0;
      lastBusy = null;
    },
  };
}

/** 一行人话，直接进 probe.log。 */
export function describeRpcBusy(sample) {
  if (!sample) return 'rpc-busy (无现场)';
  const oldest = Math.round((sample.oldestMs || 0) / 100) / 10;
  return `rpc-busy method=${sample.method} inflight=${sample.inflight} peak=${sample.peak} oldest=${oldest}s p50=${Math.round((sample.p50Ms || 0) / 100) / 10}s top=${sample.top || '-'}`;
}
