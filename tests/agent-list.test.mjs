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
const { listHostAgents, cacheHostAgentNames, readAgentName } = await import('../lib/agent-name.js');

// ── 宿主名单 ──────────────────────────────────────────────

test('宿主名单：缓存后能列出全部伙伴', () => {
  cacheHostAgentNames([
    { id: 'hanako', name: '小花' },
    { id: 'yuzuki', name: '柚月' },
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