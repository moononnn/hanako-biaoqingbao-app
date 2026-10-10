// tests/persona-io.test.mjs
//
// v0.1.47 方言「人格文件部分」的底座。
//
// 为什么必须有这组测试：App 跑在开了 Node 权限沙箱的子进程里，宿主只给三条读根，
// <hana 主目录>/agents 不在其中（实测连 existsSync 都 ERR_ACCESS_DENIED），
// 所以人格文件读写改走宿主 ctx.resources，同步函数也一并改成 async。
// 这条链路原先零测试，而 async 化最容易出的错就是漏一个 await —— 那样会静默拿到
// 一个 Promise 当结果，界面照样报「保存成功」，实际什么都没写。必须有测试把它钉住。
//
// 覆盖：
//   1. fs 通道（单测隔离路径）：读 / 写 / 存在判定 / 读不到时的 missing 语义
//   2. resources 通道（假宿主）：正常读写、文件不存在、没授权被拒、并发冲突
//   3. 方言全链路：选方言写人格 → 读回 → 换方言覆盖旧块 → 关闭方言把块摘干净

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setPersonaResources, readPersonaText, writePersonaText, personaFileExists } from '../lib/persona-io.js';

// ── 假宿主：照 ResourceIO 的形状实现，重点是把「拒绝」「不存在」「冲突」三种分开 ──

function fakeHost(initial = {}, opts = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, { text: v, version: 1 }]));
  const calls = { write: [], writeExpectedVersion: [] };
  const notFound = () => { const e = new Error('ENOENT: no such file or directory'); e.code = 'ENOENT'; return e; };
  return {
    files, calls,
    async read(ref) {
      if (opts.denyRead) { const e = new Error('ERR_ACCESS_DENIED: restricted'); e.code = 'ERR_ACCESS_DENIED'; throw e; }
      const hit = files.get(ref.path);
      if (!hit) throw notFound();
      return { content: hit.text, version: hit.version };
    },
    async stat(ref) {
      const hit = files.get(ref.path);
      return hit ? { exists: true, version: hit.version } : { exists: false };
    },
    async write(ref, content) {
      if (opts.denyWrite) { const e = new Error('ERR_ACCESS_DENIED: restricted'); e.code = 'ERR_ACCESS_DENIED'; throw e; }
      calls.write.push(ref.path);
      const hit = files.get(ref.path);
      files.set(ref.path, { text: String(content), version: (hit?.version ?? 0) + 1 });
      return { ok: true };
    },
    async writeExpectedVersion(ref, content, version) {
      if (opts.denyWrite) { const e = new Error('ERR_ACCESS_DENIED: restricted'); e.code = 'ERR_ACCESS_DENIED'; throw e; }
      calls.writeExpectedVersion.push({ path: ref.path, version });
      const hit = files.get(ref.path);
      if (hit && hit.version !== version) return { conflict: true };
      files.set(ref.path, { text: String(content), version: (hit?.version ?? 0) + 1 });
      return { ok: true };
    },
  };
}

// ── 1. fs 通道 ────────────────────────────────────────────

test('fs 通道：写进去读得回来', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pio-'));
  setPersonaResources(null);
  const file = path.join(dir, 'AGENTS.md');
  const w = await writePersonaText(file, '你好');
  assert.equal(w.ok, true);
  const r = await readPersonaText(file);
  assert.equal(r.ok, true);
  assert.equal(r.text, '你好');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fs 通道：读不到标记 missing，区别于“真读不动”', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pio-'));
  setPersonaResources(null);
  const r = await readPersonaText(path.join(dir, 'AGENTS.md'));
  assert.equal(r.ok, false);
  assert.equal(r.missing, true, '文件不存在属于 missing，新建分支要靠它');
  assert.equal(await personaFileExists(path.join(dir, 'AGENTS.md')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 2. resources 通道 ─────────────────────────────────────

test('resources 通道：走宿主通道而不是裸 fs', async () => {
  const host = fakeHost({ 'C:/x/AGENTS.md': '宿主给的内容' });
  setPersonaResources(host);
  const r = await readPersonaText('C:/x/AGENTS.md');
  assert.equal(r.ok, true);
  assert.equal(r.text, '宿主给的内容');
  setPersonaResources(null);
});

test('resources 通道：没授权要报出来，不能当成“文件不存在”', async () => {
  // 这是这轮最要紧的一条：以前读不到一律当空，于是没权限时它照样往下写、最后报成功。
  const host = fakeHost({ 'C:/x/AGENTS.md': 'x' }, { denyRead: true });
  setPersonaResources(host);
  const r = await readPersonaText('C:/x/AGENTS.md');
  assert.equal(r.ok, false);
  assert.equal(r.missing, false, '被拒不能算 missing，否则又退回假装新建');
  assert.match(r.reason, /DENIED|restricted/i);
  setPersonaResources(null);
});

test('resources 通道：版本对得上才写，且走乐观并发那扇门', async () => {
  const host = fakeHost({ 'C:/x/AGENTS.md': 'v1' });
  setPersonaResources(host);
  const out = await writePersonaText('C:/x/AGENTS.md', 'v2');
  assert.equal(out.ok, true);
  assert.equal(host.files.get('C:/x/AGENTS.md').text, 'v2');
  assert.equal(host.calls.writeExpectedVersion.length, 1, '已有版本时应走 writeExpectedVersion');
  assert.equal(host.calls.write.length, 0, '不该退回无条件写');
  setPersonaResources(null);
});

test('resources 通道：别人刚改过就冲突，宁可不写也不覆盖', async () => {
  const host = fakeHost({ 'C:/x/AGENTS.md': 'v1' });
  setPersonaResources(host);
  // 模拟「stat 之后、写入之前」文件被别人改了
  const realWrite = host.writeExpectedVersion;
  host.writeExpectedVersion = async (ref, content, version) => {
    host.files.set(ref.path, { text: '别人写的', version: version + 5 });
    return realWrite(ref, content, version);
  };
  const out = await writePersonaText('C:/x/AGENTS.md', '我要写的');
  assert.equal(out.ok, false);
  assert.equal(out.conflict, true);
  assert.equal(host.files.get('C:/x/AGENTS.md').text, '别人写的', '冲突时对方的内容必须原样保住');
  setPersonaResources(null);
});

test('resources 通道：文件不存在时按新建写，不去要求一个版本号', async () => {
  const host = fakeHost({});
  setPersonaResources(host);
  const out = await writePersonaText('C:/x/new/AGENTS.md', '新的');
  assert.equal(out.ok, true);
  assert.equal(host.calls.writeExpectedVersion.length, 0);
  assert.equal(host.calls.write.length, 1);
  setPersonaResources(null);
});

test('resources 通道：写被拒要说原因，不许假装成功', async () => {
  const host = fakeHost({ 'C:/x/AGENTS.md': 'v1' }, { denyWrite: true });
  setPersonaResources(host);
  const out = await writePersonaText('C:/x/AGENTS.md', 'v2');
  assert.equal(out.ok, false);
  assert.equal(out.conflict, undefined);
  assert.match(out.reason, /DENIED|restricted/i);
  setPersonaResources(null);
});

// ── 3. 方言全链路 ─────────────────────────────────────────

test('方言全链路：选方言→写入人格→读回→换方言覆盖旧块→关闭摘干净', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  process.env.BIAOQINGBAO_DIALECT_CONFIG = path.join(home, 'dialect-config.json');
  process.env.BIAOQINGBAO_DIALECT_LOG = path.join(home, 'dialect-log.json');

  const personaPath = path.join(home, 'agents', 'a', 'AGENTS.md');
  const host = fakeHost({ [personaPath]: '# 原有性格\n\nta 是个很温和的人。\n' });
  setPersonaResources(host);

  const { applyDialectToIshiki, readDialectFromIshiki, removeDialectFromIshiki } = await import('../lib/dialect.js');

  // 选方言：写人格块
  const applied = await applyDialectToIshiki('a', 'sichuan', 'on', home, 'normal', { syncConfig: false });
  assert.equal(applied.ok, true, applied.error);
  const text = host.files.get(personaPath).text;
  assert.match(text, /原有性格/, '原有性格不能被冲掉');
  assert.ok((await readDialectFromIshiki('a', home)).length > 0, '读回应能读回方言块');

  // 换方言：旧的块要换掉，不能两块并存
  const swapped = await applyDialectToIshiki('a', 'dongbei', 'on', home, 'normal', { syncConfig: false });
  assert.equal(swapped.ok, true, swapped.error);
  const after = host.files.get(personaPath).text;
  const blockCount = (after.match(/方言人格/g) || []).length;
  assert.ok(blockCount <= 2, `方言块不该叠加，实际出现 ${blockCount} 次`);

  // 关闭方言：把块摘干净，人格原文留下
  const removed = await removeDialectFromIshiki('a', home, { syncConfig: false });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.removed, true);
  assert.equal(await readDialectFromIshiki('a', home), '');
  assert.match(host.files.get(personaPath).text, /原有性格/, '摘掉方言块不能把人格本身弄丢');

  setPersonaResources(null);
  delete process.env.BIAOQINGBAO_DIALECT_CONFIG;
  delete process.env.BIAOQINGBAO_DIALECT_LOG;
  fs.rmSync(home, { recursive: true, force: true });
});

test('方言全链路：没授权时要报失败，不许返回 ok', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const personaPath = path.join(home, 'agents', 'a', 'AGENTS.md');
  setPersonaResources(fakeHost({ [personaPath]: '# 人格' }, { denyRead: true }));

  const { applyDialectToIshiki } = await import('../lib/dialect.js');
  const out = await applyDialectToIshiki('a', 'sichuan', 'on', home, 'normal', { syncConfig: false });
  assert.equal(out.ok, false, '读不到人格文件时必须报失败');
  assert.match(out.error, /读不到|写入失败/);

  setPersonaResources(null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('方言全链路：非法 agentId 仍然被拦（路径穿越防护没被 async 化破坏）', async () => {
  setPersonaResources(fakeHost({}));
  const { applyDialectToIshiki, removeDialectFromIshiki } = await import('../lib/dialect.js');
  for (const bad of ['../evil', 'a/b', '__proto__']) {
    const r1 = await applyDialectToIshiki(bad, 'sichuan', 'on', os.tmpdir(), 'normal', { syncConfig: false });
    assert.equal(r1.ok, false, `${bad} 不该通过`);
    const r2 = await removeDialectFromIshiki(bad, os.tmpdir(), { syncConfig: false });
    assert.equal(r2.ok, false, `${bad} 不该通过`);
  }
  setPersonaResources(null);
});

// ── 4. 「学我说话」的语料采集 ─────────────────────────────

test('学我说话：列目录用 list、读文件用 read，不裸碰 fs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sty-'));
  const sessionsDir = path.join(home, 'agents', 'a', 'sessions');
  const line = (text) => JSON.stringify({
    type: 'message',
    timestamp: '2026-10-10T00:00:00.000Z',
    message: { role: 'user', content: text },
  });
  const files = {
    [path.join(sessionsDir, '2026-10-10_01.jsonl')]: [line('今天天气不错，我想出去走走散散心。'), line('ignored')].join('\n'),
    [path.join(sessionsDir, '2026-10-09_01.jsonl')]: [line('昨天把那个功能写完了，看着还挺顺眼的。')].join('\n'),
    [path.join(sessionsDir, 'notes.files.json')]: '不是会话',
  };

  const used = [];
  setPersonaResources({
    async list(ref) { used.push('list'); return { entries: Object.keys(files).map((p) => path.basename(p)) }; },
    async read(ref) {
      used.push('read');
      const text = files[ref.path];
      if (text === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { content: text };
    },
    async stat() { return { exists: true }; },
  });

  const { collectUserMessages } = await import('../lib/style-template.js');
  const out = await collectUserMessages('a', home);
  assert.equal(out.ok, true, out.error);
  assert.ok(out.messages.length >= 2, `应采到至少两条用户消息，实际 ${out.messages.length}`);
  assert.ok(used.includes('list'), '列目录必须走 resources.list');
  assert.ok(out.total >= 2);
  setPersonaResources(null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('学我说话：没会话目录时安静返回空，不报错', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sty-'));
  setPersonaResources(fakeHost({}));
  const { collectUserMessages } = await import('../lib/style-template.js');
  const out = await collectUserMessages('nobody', home);
  assert.equal(out.ok, true);
  assert.deepEqual(out.messages, []);
  setPersonaResources(null);
  fs.rmSync(home, { recursive: true, force: true });
});