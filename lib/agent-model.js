// 伙伴当前在用的对话模型：从 agents/<id>/config.yaml 的 models.chat 里读。
//
// 「默认跟随当前模型」靠它——卡片上的聊天不必要求用户先去设置里配一台聊天模型，
// 直接用这位伙伴平时说话那台，口味才对得上。
// 读法参照 lib/agent-name.js：同一层权限，agents 目录 App 读得到。
import fs from 'node:fs';
import path from 'node:path';
import { HANA_HOME } from './shared.js';

// yaml 里一个标量值的清洗：去掉行尾注释和成对的引号
function scalar(raw) {
  return String(raw || '')
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

// 只认 models.chat 这个块里的 provider / id，别的地方出现同名字段不当数。
// 拿不到（没配、chat 是空串、文件读不了）一律返回 null，交给调用方回退。
// homeDir 只为测试留口子，生产调用不传。
export function readAgentChatModel(agentId, homeDir = HANA_HOME) {
  if (!agentId) return null;
  let text = '';
  try {
    text = fs.readFileSync(path.join(homeDir, 'agents', String(agentId), 'config.yaml'), 'utf8');
  } catch {
    return null;
  }

  let inModels = false;
  let chatIndent = -1;
  let providerId = '';
  let modelId = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    const indent = ((line.match(/^\s*/) || [''])[0]).length;
    const content = line.trim();
    if (!content || content.startsWith('#')) continue;
    if (!inModels) {
      if (indent === 0 && /^models:/.test(content)) inModels = true;
      continue;
    }
    if (indent === 0) break; // models 块到底了
    if (chatIndent < 0) {
      if (!/^chat:/.test(content)) continue;
      // chat: "" / chat: 某个标量 都表示「没有具体模型」
      if (scalar(content.slice(5))) return null;
      chatIndent = indent;
      continue;
    }
    if (indent <= chatIndent) break; // chat 块到底了
    if (/^provider:/.test(content)) providerId = scalar(content.slice(9));
    else if (/^id:/.test(content)) modelId = scalar(content.slice(3));
  }
  return providerId && modelId ? { providerId, modelId } : null;
}
