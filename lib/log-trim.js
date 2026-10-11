// lib/log-trim.js - 只追加、超限自动截断的现场日志。
//
// 2026-10-11：card-context-debug.log 五天攒到 4.9MB，其中九成是「还没给我编号」这种等待噪音。
// 排障日志是用来查事的，不是流水账；留一两个月的现场没有意义，留几 MB 才有。
// 所以给它封顶：超过 max 就把旧的砍掉、只留最近 keep 字节。

import fs from 'node:fs';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP_BYTES = 1024 * 1024;

// 截断时要从完整字符边界切：raw[start] 若还是 UTF-8 的后续字节，往前退。
function alignToCharStart(buffer, index) {
  let at = index;
  while (at > 0 && (buffer[at] & 0xc0) === 0x80) at--;
  return at;
}

/**
 * 只保留文件尾部 keep 字节。返回 true 表示真的裁过。
 * 调用方负责保证文件存在。
 */
export function trimLogFile(file, keep = DEFAULT_KEEP_BYTES) {
  const size = fs.statSync(file).size;
  if (size <= keep) return false;
  const raw = fs.readFileSync(file);
  const text = raw.subarray(alignToCharStart(raw, raw.length - keep)).toString('utf8');
  const cut = text.indexOf('\n');
  fs.writeFileSync(file, '[older entries trimmed]\n' + (cut >= 0 ? text.slice(cut + 1) : text));
  return true;
}

/**
 * 追加一行；超限先裁。裁不动、读不了、写不进去都当没记，不影响调用方。
 */
export function appendBoundedLog(file, line, options = {}) {
  const max = options.max || DEFAULT_MAX_BYTES;
  const keep = options.keep || DEFAULT_KEEP_BYTES;
  try {
    if (fs.statSync(file).size > max) trimLogFile(file, keep);
  } catch { /* 文件还没有或读不到，直接追加 */ }
  fs.appendFileSync(file, line);
}