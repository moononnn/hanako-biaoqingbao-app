// lib/hook-throttle.js - 钩子节流
//
// 2026-10-26 实机：宿主日志一小时里 1150 条
// 「hooks.onDecision(...) adjudicator threw ... App RPC concurrency limit reached」，
// 表情包的 agent/pre-step 和 tools/pre-execute 一起被拒，知意的插话也一起哑掉。
// 机制是 App 与宿主那条 RPC peer 各有 128 个待处理槽（见宿主 app-host-entry.js
// 的 MAX_PENDING），槽满时宿主直接回 APP_RPC_BUSY，钩子就被当成「没意见」跳过。
//
// 槽不是被一两个慢请求占满的，是被同一批工作反复排队占满的：
//   a. 同一个会话连着几步各起一次判定，前一次还在问模型，后一次又排进去；
//   b. 撞上 APP_RPC_BUSY 之后没人退一步，下一步立刻再撞一次；
//   c. 会话分区查不到时不留负缓存，同一条失败查询每轮重打两遍。
//
// 这里只提供两个纯函数，判断留给调用方：
//   createInflightGuard —— 同一 key 在飞时不再排第二份；
//   createBusyBackoff   —— 撞过一次上限就整体退避一小会儿。
// 两者都不吞业务判断：拿到锁照常干活，被退避时直接放弃这一轮。

/** 在飞去重。enter() 返回释放函数；已经有同名任务在跑则返回 null。 */
export function createInflightGuard() {
  const running = new Set();
  return {
    /** @returns {null | (() => void)} */
    enter(key) {
      const id = String(key ?? '').trim();
      // 没有 key 就无从去重，放行且不需要释放。
      if (!id) return () => {};
      if (running.has(id)) return null;
      running.add(id);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        running.delete(id);
      };
    },
    size() {
      return running.size;
    },
    has(key) {
      return running.has(String(key ?? '').trim());
    },
  };
}

/**
 * 撞上宿主 RPC 上限之后的整体退避。
 * 只影响「新开一轮要不要动手」，不影响已经在飞的请求。
 */
export function createBusyBackoff({ windowMs = 20000, now = () => Date.now() } = {}) {
  let until = 0;
  return {
    /** 记一次碰撞，窗口从 now 重新算；已有更晚的窗口就留着。 */
    trip() {
      until = Math.max(until, now() + windowMs);
      return until;
    },
    blocked() {
      return now() < until;
    },
    remainingMs() {
      return Math.max(0, until - now());
    },
    reset() {
      until = 0;
    },
  };
}
