// 批量识图并发设置
//
// 那个旋钮值得让用户自己拧，因为图库大小、模型快慢、机器扛不扛得住，每个用户差得远。
// 但默认值和范围必须管住：2026-10-13 早上 5 并发打 MiniMax 思考型视觉模型，
// 一批 6 张集体超时。所以默认 3、范围 1~8，超范围的值一律夹回来，不给「调到 50」的机会。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-concurrency-'));
const file = path.join(dir, 'batch-config.json');

const { readBatchConfig, writeBatchConfig, getBatchConcurrency,
  DEFAULT_BATCH_CONFIG, MIN_BATCH_CONCURRENCY, MAX_BATCH_CONCURRENCY } =
  await import('../lib/batch-apply.js');

test('默认 3，不是 5', () => {
  assert.equal(DEFAULT_BATCH_CONFIG.concurrency, 3);
  assert.equal(MIN_BATCH_CONCURRENCY, 1);
  assert.equal(MAX_BATCH_CONCURRENCY, 8);
  assert.equal(readBatchConfig(file).concurrency, 3);
  assert.equal(getBatchConcurrency(readBatchConfig(file)), 3);
});

test('用户选的值原样保留', () => {
  writeBatchConfig({ concurrency: 6 }, file);
  assert.equal(readBatchConfig(file).concurrency, 6);
  writeBatchConfig({ concurrency: 1 }, file);
  assert.equal(readBatchConfig(file).concurrency, 1);
});

test('超出范围的一律夹回边界', () => {
  writeBatchConfig({ concurrency: 99 }, file);
  assert.equal(readBatchConfig(file).concurrency, 8);
  writeBatchConfig({ concurrency: 0 }, file);
  assert.equal(readBatchConfig(file).concurrency, 1);
  writeBatchConfig({ concurrency: -4 }, file);
  assert.equal(readBatchConfig(file).concurrency, 1);
});

test('脏数据不炸', () => {
  writeBatchConfig({ concurrency: 'abc' }, file);
  assert.equal(readBatchConfig(file).concurrency, 3);
  writeBatchConfig({ concurrency: null }, file);
  assert.equal(readBatchConfig(file).concurrency, 3);
  writeBatchConfig({ concurrency: 4.6 }, file);
  assert.equal(readBatchConfig(file).concurrency, 5);
});

test('老配置文件没有 concurrency 字段时补上默认值', () => {
  fs.writeFileSync(file, JSON.stringify({ autoApply: false }));
  const cfg = readBatchConfig(file);
  assert.equal(cfg.autoApply, false, '老字段不能丢');
  assert.equal(cfg.concurrency, 3);
});

test('存坏格式的配置文件退回默认值，不抛', () => {
  fs.writeFileSync(file, '{ 这不是 JSON');
  assert.equal(readBatchConfig(file).concurrency, 3);
  assert.equal(readBatchConfig(file).autoApply, true);
});

test('改并发不碰自动应用开关', () => {
  writeBatchConfig({ autoApply: false }, file);
  writeBatchConfig({ concurrency: 5 }, file);
  const cfg = readBatchConfig(file);
  assert.equal(cfg.concurrency, 5);
  assert.equal(cfg.autoApply, false);
});