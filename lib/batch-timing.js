// 批量识图耗时估算
//
// 为什么要有这个：新用户第一次装应用，习惯是把自己的表情包库一次导进来铺好，
// 点完「批量识图」就发现界面在那儿慢慢爬，一晚上跑不完，中途关掉白花一次模型钱。
// 作者自己几张几张加，看不到这个坑，但拿不到应用的新用户大概率会这么用。
// 所以在点开始之前就告诉他：多少张、大概要多久、会调多少次模型。
//
// 速度优先取历史实测：已完成的任务带 duration_ms，除以它实际识别的张数，
// 得到「已含并发的单张均摊耗时」。没有可用历史就退回保守默认（每张 30 秒），
// 宁可报得慢，也不要让人以为十分钟就能跑完。

export const DEFAULT_MS_PER_IMAGE = 30000;

// 单张纯耗时的合理区间：低于 3 秒多半是「压根没调模型」的异常任务，
// 高于 20 分钟多半是中途卡住或模型超时，拿它们算均值会得出离谱的结论。
const MIN_MS_PER_IMAGE = 3000;
const MAX_MS_PER_IMAGE = 1200000;

/**
 * 从任务列表里反推「单张纯耗时（毫秒，不含并发）」。
 *
 * 账本里的 duration_ms 是整批的墙钟时间，除以完成张数得到的是「已含并发的单张摊薄耗时」。
 * 直接拿它当单张耗时、再除一次并发，就等于把并发算了两遍——2026-10-13 就是这么把
 * 「15 张 152 秒」算成「15 张 30 秒」的。所以这里把历史并发乘回去，得到单张纯耗时，
 * 换并发时才能用同一个数重算。
 *
 * @param {Array<{status?:string, duration_ms?:number, completed?:number, concurrency?:number}>} tasks
 * @returns {{ msPerImage: number, source: 'history'|'default' }}
 */
export function avgMsPerImage(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  let picked = null;
  for (const task of list) {
    if (!task || task.status !== 'completed') continue;
    const duration = Number(task.duration_ms);
    const done = Number(task.completed);
    if (!Number.isFinite(duration) || !Number.isFinite(done) || done <= 0 || duration <= 0) continue;
    const wallPerImage = duration / done;
    if (wallPerImage < MIN_MS_PER_IMAGE || wallPerImage > MAX_MS_PER_IMAGE) continue;
    const concurrency = Math.min(Math.max(Number(task.concurrency) || 1, 1), 8);
    const perImage = wallPerImage * concurrency;
    if (perImage > MAX_MS_PER_IMAGE) continue;
    // 任务列表按时间正序，越靠后越新；留最后一个可用的
    picked = perImage;
  }
  if (picked === null) return { msPerImage: DEFAULT_MS_PER_IMAGE, source: 'default' };
  return { msPerImage: Math.round(picked), source: 'history' };
}

/**
 * 估算一批识图任务要多久。
 *
 * msPerImage 是单张纯耗时，所以要除以并发才是墙钟时间。
 *
 * @param {{tasks?:Array, count:number, concurrency?:number}} input
 * @returns {{count:number, concurrency:number, msPerImage:number, source:string,
 *            msTotal:number, modelCalls:number}}
 */
export function estimateTagTiming({ tasks = [], count, concurrency = 5 } = {}) {
  const n = Math.max(0, Number(count) || 0);
  const c = Math.max(1, Math.min(Number(concurrency) || 5, 8));
  const { msPerImage, source } = avgMsPerImage(tasks);
  return {
    count: n,
    concurrency: c,
    msPerImage,
    source,
    msTotal: Math.round((n * msPerImage) / c),
    // 每张图一次模型调用；重试会让实际次数更多，这里报的是下限
    modelCalls: n,
  };
}