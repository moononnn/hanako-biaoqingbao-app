// 伙伴显示名：App 侧读不到伙伴名片本体，只能从 agents/<id>/ 的卡片文件与配置里取一个名字。
// 悬浮球（选目标）与流内卡标题共用这一份，所以单独成模块：
// ball-message-card.js 需要它，而那边反向 import ball.js 会绕成一个圈。
//
// 2026-10-07 - 路径要按 App 沙箱认得的写。DATA_DIR 是宿主发下来的真实路径
// （<hana 主目录>/app-data/biaoqingbao-app），往上两级就是 Hana 主目录；而 HANA_HOME 可能是
// junction 写法（主目录联接），沙箱按真实路径判定会直接把读取拒掉，名字就此退化成英文 id。
// 所以先试真实路径，再退回 HANA_HOME，两边都认不出才退到 id。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HANA_HOME } from './shared.js';

// 2026-10-07 - 宿主那边有现成的伙伴名单（agent:list 带显示名），优先用它：
// App 沙箱只能碰自己的数据目录，读不到 <hana 主目录>/agents/...，自己拼路径取名字会一路失败，
// 名字最后退化成英文 id。App 启动时拉一次存这儿，没拉到时再退回文件那条路。
let hostNames = new Map();
let hostList = [];

// 完整的宿主伙伴名单（不只是 id→name）。/api/agents 要列全部伙伴，
// 光有 id→name 的 Map 不够用，所以顺手把整份留一份。
export function listHostAgents() {
  return hostList.map((row) => ({ id: row.id, name: row.name }));
}

// 2026-11-05 - 启动时缓存的只是那一刻的快照。用户在 Hana 里新建的伙伴不会自己冒出来，
//   而「刷新列表」按钮原先只是重发一次 GET /api/agents，读的还是同一份内存快照，
//   于是按了等于没按——新建的伙伴永远看不见。这里给路由层一个主动重拉的出口。
//   拉失败（宿主忙、通道断）就沿用旧名单，绝不能让页面因此变空。
let lastRefreshAt = 0;
const REFRESH_MIN_INTERVAL_MS = 1500;
// 2026-11-05（审包第 1 条）—— 重拉要有内部上限。
//   页面打开时走的非强制路径会先 await 一次重拉，而前端那条请求的超时是 5 秒。
//   宿主一时忙碌时，这里就会把「秒出缓存」拖成「加载失败」。所以自定预算：
//   非强制最多等 800ms（没回就照旧返回缓存），强制刷新最多等 4 秒（比前端 12 秒短）。
//   超时只是「这次没拉到」，不是错误，缓存一个字都不能动。
const NORMAL_BUDGET_MS = 800;
const FORCE_BUDGET_MS = 4000;
const BUDGET_TIMEOUT = Symbol('budget-timeout');

export async function refreshHostAgents(sdk, options = {}) {
  const force = options.force === true;
  const minIntervalMs = Number(options.minIntervalMs) || REFRESH_MIN_INTERVAL_MS;
  const budgetMs = Number(options.budgetMs) || (force ? FORCE_BUDGET_MS : NORMAL_BUDGET_MS);
  const now = Date.now();
  if (!force && now - lastRefreshAt < minIntervalMs) {
    return { ok: true, skipped: true, total: hostList.length };
  }
  lastRefreshAt = now;
  try {
    const list = await withBudget(askHostAgents(sdk), budgetMs);
    if (list === BUDGET_TIMEOUT) {
      return { ok: false, timedOut: true, error: `宿主 ${budgetMs}ms 内没回伙伴名单`, total: hostList.length };
    }
    if (!list) return { ok: false, error: '宿主没有 agents 通道', total: hostList.length };
    const rows = Array.isArray(list.agents) ? list.agents : (Array.isArray(list) ? list : null);
    if (!rows) return { ok: false, error: '宿主返回的伙伴名单格式不认识', total: hostList.length };
    // 空名单按既有约定不清缓存（宿主偶发没给出名单时页面不该变空）。
    cacheHostAgentNames(rows);
    return { ok: true, total: hostList.length, received: rows.length };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), total: hostList.length };
  }
}

// 等 promise，但最多等 ms。超时返回哨兵值；底层请求还在飞，挂一个空 catch 防它
// 迟到的失败变成 unhandled rejection（影响了谁都不好查）。
async function withBudget(promise, ms) {
  const settled = Promise.resolve(promise);
  settled.catch(() => {});
  let timer = null;
  const timed = new Promise((resolve) => {
    // 这里不用 unref：超时后的 timer 最长也就几秒，finally 里会 clearTimeout；
    // 一旦 unref，在某些环境（Linux CI 的 Node 22）事件循环会因此变空、
    // 进程提前退出，测试被标成 cancelled。
    timer = setTimeout(() => resolve(BUDGET_TIMEOUT), ms);
  });
  try {
    return await Promise.race([settled, timed]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 宿主名单两条道：SDK 的 agents.list（apply 阶段用的就是它，也走了 app/agents.read），
// 以及它底下的 bus 通道 agent:list。请求期如果封装没挂上就直调 bus，
// 这样两边的返回值形状不同也都能兑。
async function askHostAgents(sdk) {
  if (typeof sdk?.agents?.list === 'function') return sdk.agents.list({ scope: 'all' });
  if (typeof sdk?.bus?.request === 'function') return sdk.bus.request('agent:list', { scope: 'all' }, { timeoutMs: 8000 });
  return null;
}

export function cacheHostAgentNames(list) {
  const next = new Map();
  const rows = [];
  for (const row of Array.isArray(list) ? list : []) {
    const id = String(row?.id ?? '').trim();
    const name = String(row?.name ?? '').trim();
    if (!id) continue;
    rows.push({ id, name: name || id });
    if (id && name) next.set(id, name);
  }
  if (next.size) hostNames = next;
  if (rows.length) hostList = rows;
  return hostNames.size;
}

function agentsRoots() {
  const roots = [];
  try {
    const fromData = path.dirname(path.dirname(DATA_DIR));
    if (fromData) roots.push(fromData);
  } catch { /* 推导失败就只用 HANA_HOME */ }
  if (HANA_HOME && !roots.includes(HANA_HOME)) roots.push(HANA_HOME);
  return roots;
}

// 伙伴卡片文件：新一点的 Hana 把显示名落在这儿。
function nameFromCard(agentDir) {
  try {
    const card = JSON.parse(fs.readFileSync(path.join(agentDir, 'card.json'), 'utf8'));
    if (card?.name) return String(card.name).trim();
  } catch { /* 没这张卡就下一个来源 */ }
  return '';
}

// config.yaml 的 agent.name（系统设置页写的那份）。
function nameFromConfig(agentDir) {
  try {
    const config = fs.readFileSync(path.join(agentDir, 'config.yaml'), 'utf8');
    const match = config.match(/^agent:\s*\n([\s\S]*?)(?=^\S|$)/m);
    const name = match?.[1]?.match(/^\s{2}name:\s*['"]?([^'"\n#]+)['"]?\s*$/m);
    if (name?.[1]) return name[1].trim();
  } catch { /* 读不到就下一个来源 */ }
  return '';
}

// 最后一道：身份文件的一级标题就是名字（# 小花）。改过显示名但配置没跟上时靠它兜底。
function nameFromIdentity(agentDir) {
  try {
    const text = fs.readFileSync(path.join(agentDir, 'identity.md'), 'utf8');
    const heading = text.match(/^#\s+(.+?)\s*$/m);
    if (heading?.[1]) return heading[1].trim();
  } catch { /* 同上 */ }
  return '';
}

export function readAgentName(agentId) {
  if (!agentId) return '';
  const fromHost = hostNames.get(agentId);
  if (fromHost) return fromHost;
  for (const root of agentsRoots()) {
    const agentDir = path.join(root, 'agents', agentId);
    const name = nameFromCard(agentDir) || nameFromConfig(agentDir) || nameFromIdentity(agentDir);
    if (name) return name;
  }
  return agentId;
}
