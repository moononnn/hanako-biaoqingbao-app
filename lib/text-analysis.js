// lib/text-analysis.js - 对话内容分析（辅助模型）
//
// 从 server/api.js 的 /api/text-analysis 抽出：HTTP 路由和 pre-step 情绪观察器
// （lib/observer.js）走的是同一条链路，抽成一处，避免两份实现漂移。
//
// 背景：插件版的观察器是走本地 HTTP 自调 /api/text-analysis；App 里起不了本地
// 服务，所以改成直接 import 本模块的函数。

import { readTextConfig, isRetriableTextCallError } from './shared.js';
import { callConfiguredTextModel } from './text-model.js';

export const DEFAULT_ANALYSIS_PROMPT = `你是一个表情包配图决策助手。分析最近的对话，判断助手这一轮回复是否适合配一张表情包，以及配什么情绪/关键词。

只返回纯 JSON（不要 markdown 代码块，不要其他文字）：
{"should_use": true/false, "emotion": "", "keywords": [], "intensity": "medium", "reason": ""}

规则：
- 正经问答、写代码、查资料、严肃讨论、纯指令 → should_use=false
- 闲聊、吐槽、撒娇、玩梗、日常问候、安慰、恭喜、感谢、鼓励 → should_use=true
- emotion 只能选 6 个之一：搞笑 / 开心 / 难过 / 无语 / 感谢 / 鼓励
- keywords：从对话中提取 2-5 个具体词（如"加班""打工人""猫咪""生日"），不要泛泛的词
- intensity：light=轻微日常 / medium=普通情绪 / strong=强烈情绪
- reason：一句话说明为什么适合/不适合`;

// 提取 message.content 里的文字（兼容 string / array / object / null）
// Pi SDK 的 messages 里 assistant 多模态消息的 content 经常是
// [{ type: 'text', text: '...' }, { type: 'tool_use', ... }] 这样的数组
export function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => {
        if (p == null) return '';
        if (typeof p === 'string') return p;
        if (typeof p === 'object') {
          if (typeof p.text === 'string') return p.text;
          if (typeof p.content === 'string') return p.content;
          if (typeof p.input === 'object') return ''; // tool_use 之类，不混入对话
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

// 单条与整段的长度上限。辅助模型只靠最近的语境判断情绪，把整段内心草稿
// 全塞进去只会拖慢它（实测：输入 2800+ 字符时一半调用撞超时，每轮白等 20 秒）。
const PER_MSG_MAX = 400;
const TOTAL_MAX = 1800;

// 剥掉 <mood> 这类只在本地用的草稿块。它们不属于对话正文，而且篇幅比正文还长。
function stripInternalDraft(text) {
  return String(text || '')
    .replace(/<mood>[\s\S]*?<\/mood>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 构造要分析的内容；context 给了就直接用
// 注意：不能「先切最后 N 条、再过滤」。宿主给的消息里混着大量工具往返
//（toolResult、只带 tool_use 没正文的 assistant），先切再滤很容易一条正文都不剩
//（实测提取长度为 0，辅助模型只收到「最近的对话：」，于是永远判无情绪），
// 而且唯一那句用户原话往往就在更靠前的位置被切掉了。改成从后往前挑「真有正文」的。
export function buildAnalyzeText(messages, context = '', limit = 6) {
  if (context) return String(context).slice(0, TOTAL_MAX);
  if (!Array.isArray(messages)) return '';
  const picked = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0 && picked.length < limit; i--) {
    const m = messages[i];
    const role = m?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = stripInternalDraft(extractText(m.content));
    if (!text) continue;
    if (text.length > PER_MSG_MAX) text = text.slice(0, PER_MSG_MAX) + '…';
    const line = `${role === 'user' ? '用户' : '助手'}：${text}`;
    if (total > 0 && total + line.length > TOTAL_MAX) break;
    total += line.length;
    picked.push(line);
  }
  return picked.reverse().join('\n');
}

// 调用辅助模型分析对话。返回 { ok, data } 或 { ok, error }（不抛）。
// 与路由层原先的行为保持一致：失败也返回 200 语义的对象，由调用方决定怎么用。
//
// totalBudgetMs：整次分析的耗时上限（含重试）。pre-step 钩子有宿主硬超时，
//   观察器在闸门内必须自己先收手，否则整轮会被宿主砍掉、白等一整个超时窗口。
//   路由层的手动测试不传这个参数，保持原来的宽松行为。
export async function analyzeConversation({ ctx, messages, context, prompt, totalBudgetMs = 0 } = {}) {
  const toAnalyze = buildAnalyzeText(messages, context);
  const usePrompt = prompt || DEFAULT_ANALYSIS_PROMPT;
  const cfg = readTextConfig();
  const budgetMs = Number(totalBudgetMs) || 0;
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;

  let analysisText = '';

  if (cfg.source === 'hana') {
    if (!cfg.providerId || !cfg.modelId) {
      return { ok: false, error: '未配置 Hana 模型', fallback: true };
    }
    // v0.33.73 / v0.33.84 - 只对空正文、思考耗尽和超时重试一次。
    // 这里必须走插件配置的选定模型；utility:call-text 只认全局 utility，
    // 且无法把 DeepSeek 的 thinking 开关传给当前请求。
    //
    // v0.1.12 改口径：只有当失败来得快（<8 秒）才重试。实测选定的辅助模型
    // 典型响应 14～18 秒，慢失败的再赌一次等于把等待翻倍，而且第二次也大概率撞超时。
    const MIN_RETRY_MS = 3000;
    const FAST_FAIL_MS = 8000;
    let analysisErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline ? deadline - Date.now() : null;
      if (attempt > 1 && remaining !== null && remaining < MIN_RETRY_MS) break;
      const perCall = remaining !== null ? Math.min(22000, Math.max(1000, remaining)) : 15000;
      const callStart = Date.now();
      const result = await callConfiguredTextModel(ctx, cfg, [
        { role: 'system', content: usePrompt },
        { role: 'user', content: `最近的对话：\n${toAnalyze}` }
      ], {
        maxTokens: 800,
        temperature: 0.3,
        timeoutMs: perCall,
      });
      if (result.ok && String(result.data || '').trim()) {
        analysisText = String(result.data);
        analysisErr = null;
        break;
      }
      analysisErr = new Error(result.error || '模型返回空正文（仅思考）');
      if (!isRetriableTextCallError(analysisErr)) break;
      // 慢失败不再重试：等待已经很长，再赌一次只会更久
      if (Date.now() - callStart > FAST_FAIL_MS) break;
    }
    if (analysisErr) {
      return { ok: false, error: analysisErr.message || '模型调用失败', fallback: true };
    }
  } else if (cfg.source === 'custom') {
    if (!cfg.customBaseUrl || !cfg.customApiKey || !cfg.customModel) {
      return { ok: false, error: '未配置自定义模型', fallback: true };
    }
    const fetcher = ctx?.network?.fetch || globalThis.fetch;
    try {
      const resp = await fetcher(`${cfg.customBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.customApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: cfg.customModel,
          messages: [
            { role: 'system', content: usePrompt },
            { role: 'user', content: `最近的对话：\n${toAnalyze}` }
          ],
          max_tokens: 250,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return { ok: false, error: `模型返回 HTTP ${resp.status}: ${text.substring(0, 200)}` };
      }
      const data = await resp.json();
      analysisText = data.choices?.[0]?.message?.content || '';
    } catch (e) {
      return { ok: false, error: e?.message || '自定义模型请求失败', fallback: true };
    }
  } else {
    return { ok: false, error: '未知来源类型', fallback: true };
  }

  // 解析 JSON
  const cleaned = analysisText.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
  let analysis;
  try {
    analysis = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { analysis = JSON.parse(m[0]); } catch { /* 交给下面统一报错 */ }
    }
  }
  if (!analysis) {
    return { ok: false, error: '模型返回格式无法解析', raw: analysisText.substring(0, 300) };
  }

  return { ok: true, data: analysis };
}
