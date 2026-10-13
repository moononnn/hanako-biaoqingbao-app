// v0.2.11 - 宿主 RPC 并发上限的退避重试
//
// 批量任务期间，App 发出的模型调用与事件推送共用宿主的 RPC peer 待处理槽（本机上限 128）。
// 槽满时宿主抛 `AppSdkError: App RPC concurrency limit reached`（或 code 为 APP_RPC_BUSY）。
// 这里只做两件事：认出这类错误、退避片刻后重试。不换模型、不改并发、不吞掉最终错误。
//
// 后来补的第二类：模型调用超时。以前超时直接判死，用户点一次重试就再抛一次超时，
// 看着像“这张图有问题”，其实是在掷骰子——文本模型那边早把超时列成可重试了，
// 识图漏了这条。见下方 withTransientRetry。

const BUSY_RE = /(APP_RPC_BUSY|App RPC concurrency limit reached|RPC concurrency limit)/i;
const TIMEOUT_RE = /(MODEL_TIMEOUT|超时|timeout|timed out|ETIMEDOUT|aborted|中断)/i;

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

/**
 * 识图这类长调用值得重试的瞬时错误：并发槽满 + 超时/中断。
 * 模型不存在、鉴权失败、格式错这些是确定性的，重试只是浪费钱，不在此列。
 */
export function isTransientRetryableError(value) {
  return isRpcBusyError(value) || TIMEOUT_RE.test(flattenError(value));
}

function flattenError(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return [value.code, value.name, value.message, value.error].filter(Boolean).map(String).join(' ');
  }
  return String(value);
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
  return runRetryLoop(run, isRpcBusyError, options);
}

/**
 * 识图这类长调用的重试：除了并发槽满，模型超时/中断也算。
 *
 * 超时重试只给一次（retries 默认 1）：批量场景本就有 5 个 worker 并发，
 * 再多试几轮只会把并发压力更大；而单次调用已经会自己涨到 90 秒，
 * 再加退避，一轮的耐心值不值得由调用方自己定。
 *
 * @param {(attempt:number)=>Promise<any>} run
 * @param {{retries?:number, baseDelayMs?:number, sleep?:(ms:number)=>Promise<void>, onRetry?:(err:Error, attempt:number)=>void}} [options]
 */
export async function withTransientRetry(run, options = {}) {
  return runRetryLoop(run, isTransientRetryableError, { retries: 1, baseDelayMs: 800, ...options });
}

async function runRetryLoop(run, isRetryable, {
  retries = 2,
  baseDelayMs = 400,
  sleep = defaultSleep,
  onRetry = null,
} = {}) {

  let attempt = 0;
  for (;;) {
    let value;
    try {
      value = await run(attempt);
    } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      attempt += 1;
      onRetry?.(e, attempt);
      await sleep(baseDelayMs * attempt);
      continue;
    }

    if (value && typeof value === 'object' && value.ok === false && isRetryable(value.error)) {
      if (attempt >= retries) return value;
      attempt += 1;
      onRetry?.(new Error(String(value.error)), attempt);
      await sleep(baseDelayMs * attempt);
      continue;
    }

    return value;
  }
}