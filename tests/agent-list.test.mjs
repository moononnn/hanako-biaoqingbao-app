// tests/agent-list.test.mjs
//
// 锁住 v0.1.45 的根因：v2 App 的代码跑在开了 Node Permission Model 的子进程里，
// 许可根只有「安装目录 + 自己的 app-data + locales」三条，<hana 主目录>/agents 不在里面，
// 裸 readdirSync 扫 agents 目录会被运行时直接拒掉。
// 症状是「伙伴偏好」和「方言口音」两个页面同时白屏（只有它俩会碰这个目录），
// 而且前端把真实原因吃掉，只剩一句「加载失败，请稍后重试」，极难定位。
//
// 覆盖：
//   1. 宿主名单缓存与列出
//   2. 名单里没有显示名的条目退化成 id（不能漏掉这位伙伴）
//   3. 宿主偶发返回空名单时不能把已有缓存清掉（否则页面直接空）
//   4. 回归钉子：/api/agents 必须先走宿主名单，扫目录只能当兜底
//
// 不覆盖真实宿主沙箱行为 —— 那条只能实机验（重载后点那两个页面）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { listHostAgents, cacheHostAgentNames, readAgentName, refreshHostAgents } = await import('../lib/agent-name.js');

// ── 宿主名单 ──────────────────────────────────────────────

test('宿主名单：缓存后能列出全部伙伴', () => {
  cacheHostAgentNames([
    { id: 'hanako', name: '小花' },
    { id: 'partner-b', name: '伙伴乙' },
  ]);
  const rows = listHostAgents();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((r) => r.id === 'hanako'), { id: 'hanako', name: '小花' });
});

test('宿主名单：没有显示名的条目用 id 顶上，不能整条丢掉', () => {
  cacheHostAgentNames([{ id: 'probe-agent' }]);
  const rows = listHostAgents();
  assert.deepEqual(rows, [{ id: 'probe-agent', name: 'probe-agent' }]);
});

test('宿主名单：空结果不清空已有缓存', () => {
  cacheHostAgentNames([{ id: 'hanako', name: '小花' }]);
  cacheHostAgentNames([]);      // 宿主偶发没给出名单
  cacheHostAgentNames(null);
  assert.deepEqual(listHostAgents(), [{ id: 'hanako', name: '小花' }]);
  assert.equal(readAgentName('hanako'), '小花');
});

test('宿主名单：不带 id 的脏行被跳过', () => {
  cacheHostAgentNames([{ name: '没有 id 的' }, null, { id: '  ', name: '空 id' }]);
  assert.equal(listHostAgents().some((r) => !r.id), false);
});

// ── 回归钉子：/api/agents 不许裸扫 agents 目录 ─────────────

test('回归：/api/agents 先走宿主名单，读目录只在兜底分支里', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'api.js'), 'utf8');
  const start = src.indexOf("app.get('/api/agents'");
  assert.ok(start > 0, '找不到 /api/agents 路由');
  const end = src.indexOf('// ═══ POST /api/agents/remove', start);
  assert.ok(end > start, '找不到 /api/agents 路由的结束位置');
  const handler = src.slice(start, end);

  const hostCall = handler.indexOf('listHostAgents()');
  const dirScan = handler.indexOf('readdirSync');
  assert.ok(hostCall > 0, 'handler 里没有调用 listHostAgents()');
  assert.ok(dirScan > 0, 'handler 里没有扫目录的兜底分支（这条断了说明兜底被删了，要重新评估）');
  assert.ok(
    hostCall < dirScan,
    '必须先取宿主名单再考虑扫目录 —— 反过来的话宿主名单有值时也不会用它，沙箱照样拒',
  );
});

test('回归：扫目录那步外面包着 try，失败也不该掀掉整个接口', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'api.js'), 'utf8');
  const start = src.indexOf("app.get('/api/agents'");
  const end = src.indexOf('// ═══ POST /api/agents/remove', start);
  const handler = src.slice(start, end);
  assert.ok(
    handler.includes('catch (e)') && handler.includes('ctx?.log?.error?.'),
    '错误必须记进宿主日志，否则下一次又只能靠猜',
  );
});

// 这三个文件都在启动或请求时拿「伙伴名单」，沙箱里全都读不到 agents 目录。
// 漏一处就是一处静默降级（显示成英文 id / 报「没有可用的助手」/ 导出包少字段），
// 比白屏更难被发现，所以逐个钉住。
test('回归：启动数据、导出映射、学我说话采集都先走宿主名单', () => {
  const root = path.join(__dirname, '..');
  const cases = [
    ['server/boot.js', 'agentNames 那段'],
    ['server/api.js', 'transferAgentCatalog'],
    ['lib/style-template.js', 'listAgents'],
  ];
  for (const [rel, what] of cases) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(src.includes('listHostAgents'), `${rel} 的${what}没有改用宿主名单`);
  }
});

// ── 2026-11-05：刷新按钮必须真的重拉宿主名单 ──────────────
//    原来 /api/agents 只读启动时那份内存快照，「刷新列表」按了等于没按，
//    用户在 Hana 里新建的伙伴永远出不来。

test('刷新：拿到宿主新名单时覆盖旧缓存，新伙伴能出现', async () => {
  cacheHostAgentNames([{ id: 'hanako', name: '小花' }]);
  const fakeSdk = {
    agents: {
      list: async () => ({ agents: [{ id: 'hanako', name: '小花' }, { id: 'newbie', name: '新来的' }] }),
    },
  };
  const result = await refreshHostAgents(fakeSdk, { force: true });
  assert.equal(result.ok, true);
  assert.equal(listHostAgents().length, 2);
  assert.equal(readAgentName('newbie'), '新来的');
});

test('刷新：宿主通道挂了就沿用旧名单，不能把页面弄空', async () => {
  cacheHostAgentNames([{ id: 'hanako', name: '小花' }]);
  const broke = await refreshHostAgents({ agents: { list: async () => { throw new Error('bus down'); } } }, { force: true });
  assert.equal(broke.ok, false);
  assert.deepEqual(listHostAgents(), [{ id: 'hanako', name: '小花' }]);

  const noChannel = await refreshHostAgents({}, { force: true });
  assert.equal(noChannel.ok, false);
  assert.deepEqual(listHostAgents(), [{ id: 'hanako', name: '小花' }]);

  const empty = await refreshHostAgents({ agents: { list: async () => ({ agents: [] }) } }, { force: true });
  assert.equal(empty.ok, true);
  assert.deepEqual(listHostAgents(), [{ id: 'hanako', name: '小花' }]);
});

test('刷新：节流窗口内不重复打宿主，force 可以绕开', async () => {
  let calls = 0;
  const fakeSdk = { agents: { list: async () => { calls += 1; return { agents: [{ id: 'hanako', name: '小花' }] }; } } };
  await refreshHostAgents(fakeSdk, { force: true });
  const skipped = await refreshHostAgents(fakeSdk);
  assert.equal(skipped.skipped, true);
  assert.equal(calls, 1, '节流窗口内不该再打宿主');
  await refreshHostAgents(fakeSdk, { force: true });
  assert.equal(calls, 2, 'force 必须能绕过节流');
});

test('刷新：SDK 封装没挂上时改走 bus 通道 agent:list', async () => {
  cacheHostAgentNames([{ id: 'hanako', name: '小花' }]);
  const calls = [];
  const busOnly = {
    bus: {
      request: async (channel, payload) => {
        calls.push([channel, payload]);
        return { agents: [{ id: 'hanako', name: '小花' }, { id: 'yuyun', name: '雨云' }] };
      },
    },
  };
  const result = await refreshHostAgents(busOnly, { force: true });
  assert.equal(result.ok, true);
  assert.equal(calls[0][0], 'agent:list');
  assert.equal(listHostAgents().length, 2);
  assert.equal(readAgentName('yuyun'), '雨云');
});

test('刷新：宿主迟迟不回就按预算收手，缓存一字不动', async () => {
  cacheHostAgentNames([{ id: 'hanako', name: '小花' }]);
  // 宿主“慢但不中断”：300ms 后才回。不能弄一个永不 settle 的 promise，
  // 否则测试跑完还有悬挂的异步句柄，CI 上会把文件级测试标成 cancelled。
  const slow = { agents: { list: () => new Promise((resolve) => setTimeout(() => resolve({ agents: [] }), 300)) } };
  const started = Date.now();
  const result = await refreshHostAgents(slow, { force: true, budgetMs: 60 });
  const spent = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(spent < 2000, `不该傻等到前端超时，实际等了 ${spent}ms`);
  assert.deepEqual(listHostAgents(), [{ id: 'hanako', name: '小花' }]);
});

test('刷新：超时后宿主才报的错不能抛成 unhandled rejection', async () => {
  cacheHostAgentNames([{ id: 'hanako', name: '小花' }]);
  let rejectLater = null;
  const late = { agents: { list: () => new Promise((_, reject) => { rejectLater = reject; }) } };
  const result = await refreshHostAgents(late, { force: true, budgetMs: 50 });
  assert.equal(result.timedOut, true);
  rejectLater(new Error('后续才失败'));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(listHostAgents(), [{ id: 'hanako', name: '小花' }]);
});

test('回归：/api/agents 读之前先重拉，前端刷新按钮带 refresh=1', () => {
  const root = path.join(__dirname, '..');
  const api = fs.readFileSync(path.join(root, 'server', 'api.js'), 'utf8');
  const start = api.indexOf("app.get('/api/agents'");
  const end = api.indexOf('// ═══ POST /api/agents/remove', start);
  const handler = api.slice(start, end);
  assert.ok(
    handler.includes('refreshHostAgents(ctx'),
    '/api/agents 没有向宿主重拉，新建的伙伴永远刷不出来',
  );

  const ui = fs.readFileSync(path.join(root, 'ui', 'assets', 'sticker-manager.js'), 'utf8');
  assert.ok(
    ui.includes("'/api/agents' + (forceRefresh ? '?refresh=1' : '')"),
    '刷新按钮没带 refresh=1，服务端走节流/缓存，按了还是不出来',
  );
});

test('回归：学我说话没伙伴时不能说成「可能全部被排除了」', () => {
  // 读不到目录和被用户排除是两回事，混为一谈会把人引到完全错误的方向。
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'style-template.js'), 'utf8');
  const start = src.indexOf('function listAgents');
  assert.ok(start > 0, '找不到 listAgents');
  const body = src.slice(start, start + 400);
  assert.ok(body.indexOf('listHostAgents') > 0, 'listAgents 必须先问宿主名单');
  assert.ok(
    body.indexOf('listHostAgents') < body.indexOf('readdirSync'),
    '顺序反了等于没修',
  );
});