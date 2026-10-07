// 伙伴显示名：App 侧读不到伙伴名片本体，只能从 agents/<id>/ 的卡片文件与配置里取一个名字。
// 悬浮球（选目标）与流内卡标题共用这一份，所以单独成模块：
// ball-message-card.js 需要它，而那边反向 import ball.js 会绕成一个圈。
//
// 2026-10-07 - 路径要按 App 沙箱认得的写。DATA_DIR 是宿主发下来的真实路径
// （<hana 主目录>/app-data/biaoqingbao-app），往上两级就是 Hana 主目录；而 HANA_HOME 可能是
// junction 写法（C:\Users\...），沙箱按真实路径判定会直接把读取拒掉，名字就此退化成英文 id。
// 所以先试真实路径，再退回 HANA_HOME，两边都认不出才退到 id。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HANA_HOME } from './shared.js';

// 2026-10-07 - 宿主那边有现成的伙伴名单（agent:list 带显示名），优先用它：
// App 沙箱只能碰自己的数据目录，读不到 <hana 主目录>/agents/...，自己拼路径取名字会一路失败，
// 名字最后退化成英文 id。App 启动时拉一次存这儿，没拉到时再退回文件那条路。
let hostNames = new Map();

export function cacheHostAgentNames(list) {
  const next = new Map();
  for (const row of Array.isArray(list) ? list : []) {
    const id = String(row?.id ?? '').trim();
    const name = String(row?.name ?? '').trim();
    if (id && name) next.set(id, name);
  }
  if (next.size) hostNames = next;
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
