// 现场日志封顶：超过上限只留最近的现场，且不能把中文从中间切开。
// 这条东西以前没封顶，2026-10-11 五天就攒到 4.9MB，九成还是「还没给我编号」的等待噪音。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBoundedLog, trimLogFile, DEFAULT_MAX_BYTES } from '../lib/log-trim.js';

function tempFile(name = 'card-debug.log') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-log-'));
  return path.join(dir, name);
}

function fill(file, lines) {
  fs.writeFileSync(file, lines.map((text, i) => `${String(i).padStart(4, '0')} ${text}\n`).join(''));
}

test('不超过上限时原样追加，一行不少', () => {
  const file = tempFile();
  fill(file, ['甲', '乙']);
  appendBoundedLog(file, '2026-10-11 | 丙\n', { max: 4096, keep: 1024 });
  assert.equal(fs.readFileSync(file, 'utf8'), '0000 甲\n0001 乙\n2026-10-11 | 丙\n');
});

test('超过上限就裁到只剩最近的现场，并留一行截断标记', () => {
  const file = tempFile();
  fill(file, Array.from({ length: 200 }, (_, i) => '现场记录 ' + i));
  const before = fs.statSync(file).size;
  assert.ok(before > 1024);
  appendBoundedLog(file, '2026-10-11 | 新的一条\n', { max: 1024, keep: 300 });
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(fs.statSync(file).size < before, '裁完必须比原来小');
  assert.ok(after.startsWith('[older entries trimmed]\n'), '第一行要写明裁过');
  assert.ok(after.endsWith('2026-10-11 | 新的一条\n'), '最新的现场必须留下');
  assert.ok(!after.includes('现场记录 0\n'), '最早那批要被砍掉');
  assert.ok(after.includes('现场记录 199'), '末尾的现场要留下');
});

test('默认上限是 5MB', () => {
  assert.equal(DEFAULT_MAX_BYTES, 5 * 1024 * 1024);
});

test('切边界不能把一个中文字劈成乱码', () => {
  const file = tempFile();
  // 每行 20 个汉字，故意让保留窗口落在字符中间
  fs.writeFileSync(file, Array.from({ length: 300 }, (_, i) => `第${i}行：${'花'.repeat(20)}\n`).join(''));
  appendBoundedLog(file, '2026-10-11 | 收工\n', { max: 1024, keep: 211 });
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(!after.includes('\ufffd'), '不该出现半个汉字变乱码');
  assert.ok(after.endsWith('2026-10-11 | 收工\n'));
});

test('本来就比保留量小就一刀都不动', () => {
  const file = tempFile();
  fill(file, ['一', '二', '三']);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(trimLogFile(file, 1024), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('文件还不存在也能先记下第一条', () => {
  const file = tempFile('fresh.log');
  appendBoundedLog(file, '2026-10-11 | 第一条\n', { max: 4096, keep: 1024 });
  assert.equal(fs.readFileSync(file, 'utf8'), '2026-10-11 | 第一条\n');
});