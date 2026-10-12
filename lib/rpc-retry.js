// v0.2.11 - 宿主 RPC 并发上限的退避重试
//
// 批量任务期间，App 发出的模型调用与事件推送共用宿主的 RPC peer 待处理槽（本机上限 128）。
// 槽满时宿主抛 `AppSdkError: App RPC concurrency limit reached`（或 code 为 APP_RPC_BUSY）。
// 这里只做两件事：认出这类错误、退避片刻后重试。不换模型、不改并发、不吞掉最终错误。

const BUSY_RE = /(APP_RPC_BUSY|App RPC concurrency limit reached|RPC concurrency limit)/i;

/** 判断一个错误或错误字符串是不是宿主 RPC 并发上限。 */
export function isRpcBusyError(value) {
  if (value === null || value === undefined) return false;
  const parts = [];
  if (typeof value === 'string') {
    parts.push(value);
  } else if (typeof value === 'object') {
    if (value.code) parts.push(String(value.code));
    if (value.name) parts.push(String(value.name));
    if (value.message) parts.push(String(value.message));
    if (value.error) parts.push(String(value.error));
  }
  return BUSY_RE.test(parts.join(' '));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 撞上宿主 RPC 并发上限时退避重试。
 *
 * `run` 既可以抛错（如 ctx.models.stream），也可以把 busy 错误包成 `{ ok:false, error }`
 * 正常返回（tagImage 就是后者）。两种都算撞上，都会重试。
 * 重试用尽后：
 *   - 原本是抛出来的 → 原样再抛，不改形状；
 *   - 原本是返回值   → 原样返回，调用方照常把它记进 failed，真实原因不丢。
 *
 * @param {(attempt:number)=>Promise<any>} run
 * @param {{retries?:number, baseDelayMs?:number, sleep?:(ms:number)=>Promise<void>, onRetry?:(err:Error, attempt:number)=>void}} [options]
 */
export async function withRpcBusyRetry(run, options = {}) {
  const {
    retries = 2,
    baseDelayMs = 400,
    sleep = defaultSleep,
    onRetry = null,
  } = options;

  let attempt = 0;
  for (;;) {
    let value;
    try {
      value = await run(attempt);
    } catch (e) {
      if (attempt >= retries || !isRpcBusyError(e)) throw e;
      attempt += 1;
      onRetry?.(e, attempt);
      await sleep(baseDelayMs * attempt);
      continue;
    }

    if (value && typeof value === 'object' && value.ok === false && isRpcBusyError(value.error)) {
      if (attempt >= retries) return value;
      attempt += 1;
      onRetry?.(new Error(String(value.error)), attempt);
      await sleep(baseDelayMs * attempt);
      continue;
    }

    return value;
  }
}