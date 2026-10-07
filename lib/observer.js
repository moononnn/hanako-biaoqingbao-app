// lib/observer.js - 情绪感知器 + 场景频率控制（App 版）
//
// 从插件版 extensions/observer.js 移植。判断逻辑、频率抽样、注入文案尽量逐字保留，
// 只换环境依赖，改动点如下：
//
//   1. 事件源：插件版挂在 Pi SDK extension 的 'context' 事件上（pi.on('context')），
//      App 版挂在宿主钩子 ctx.hooks.onDecision('agent/pre-step') 上，由 index.js 调用。
//   2. 辅助模型：插件版走本地 HTTP 自调 /api/text-analysis，App 里起不了本地服务，
//      改为直接调用 lib/text-analysis.js（与 HTTP 路由同一份实现）。
//   3. 工具发现路线：插件版要给模型解释「怎么找到 biaoqingbao_express」这套旧宿主拐杖，
//      App 里工具就叫 express 且直接可见，文案改为直呼其名。
//   4. 注入通道：插件版走双通道（custom 消息 + 用户消息尾部追加）。App 版只保留
//      尾部追加这一条 —— 宿主是否保留 role:'custom' 未经验证，赌不起；单通道同时
//      也消掉了「两条通道说同一件事、模型各发一张」的老问题。
//
// 待实机确认：pre-step 返回的 messages 是否只在本次请求生效、不落进会话历史。
// 插件版靠 custom role 保证不落历史，App 版改成追加到用户消息尾部后需要复核这一条。
// 若不落历史，两种环境行为等价。

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  readTextConfig, readAgentFreq, isAutoImageEnabled, getAgentFreqSettings,
  consumeAgentStickerCooldown, resolveAgentId, matchRitualWord, sanitizeTag,
  DATA_DIR,
} from './shared.js';
import { analyzeConversation } from './text-analysis.js';
import { runJevShadow, shouldSampleNegative } from './jev-shadow.js';
import { clearInjection, rememberInjection } from './pseudo-tag.js';

const DEBUG_LOG_MAX_BYTES = 200 * 1024;
const DEBUG_LOG_KEEP_LINES = 200;

export function passesFrequency(percent, randomValue = Math.random()) {
  const probability = Math.max(0, Math.min(100, Number(percent) || 0));
  return randomValue < probability / 100;
}

export function getConditionalScenePercent(sceneFreq, preFreq) {
  if (preFreq <= 0 || sceneFreq <= 0) return 0;
  return Math.min(100, sceneFreq / preFreq * 100);
}

// ── v3 情绪感知 prompt（含 scene_type）──
// v0.34.51 - keywords 输出：完整语境不再只压进一个情绪词，改由 keywords 承载
//   「此刻在聊什么具体事」，供 express 的情境通道检索用。
//   emotion 仍要求是纯感受词，禁止把事件塞进情绪词里（实测长句向量匹配会退化成近随机）。
const EMOTION_DETECT_PROMPT = `你是一个情绪感知器。分析对话上下文，判断助手在回复用户时可能感受到什么情绪、此刻在聊什么具体的事，以及当前对话的场景类型。

只返回纯JSON（不要markdown代码块）：
{"has_emotion": true/false, "emotion": "", "keywords": [], "scene": "", "tone": "", "intensity": "", "scene_type": "", "reason": ""}

- has_emotion：助手在回复时是否有情绪波动（true=有，false=没有）
- emotion：助手可能感受到的情绪，一个词或短句。必须是情绪感受词，不要行为描述。
  ✅ 正确：兴奋、得意、委屈、心疼、无奈、感动、无语、治愈、吃瓜、撒娇、社死、emo、想抱抱你、哭笑不得、偷着乐
  ❌ 错误：耐心解释、正在思考、认真分析、努力帮忙（这些是行为，不是情绪）
  注意：尽量用具体的情绪词（如"兴奋""得意"）而不是泛词（如"开心"）。只写感受本身，不要把发生的事情塞进这个词里（写"哭笑不得"，不要写"被连续放鸽子的哭笑不得"）。
- keywords：3-6 个具体词，从对话里正在说的人、事、物中提取（如"加班""放鸽子""生日""猫""赶论文"）。这些词会拿去表情包库里找同一话题的图，越具体越好；不要放情绪词（"开心""难过"这类不要），不要抽象概念，不要长句。
- scene：这张图要回应的具体情境，最多4字（如"等回复""加班"）；不明确就留空。与 scene_type 的聊天类型不同。
- tone：回复时的表达姿态，如"自嘲""调侃""撒娇""安慰"；不明确就留空，不要把用户情绪误当伙伴的语气。
- intensity：伙伴这次表达的情绪强度，light / medium / strong；拿不准就留空。
- scene_type：当前对话场景，三选一："闲聊"（日常聊天、吐槽、玩梗、情感交流）、"正事"（技术讨论、写代码、查资料、工作执行）、"中性"（介于两者之间，或难以判断时）
- reason：一句话说明为什么（说清是什么事引发了什么情绪）

判断标准：
- 关注的是"助手在回复时会感受到什么情绪"，不是用户的状态
- 即使是技术讨论，如果助手可能感到兴奋、得意、挫败等情绪，has_emotion 也可以是 true
- 纯粹的信息检索、文件操作、无情感色彩的执行任务 = 无情绪
- 情绪不需要很强烈，只要有"想表达点什么"的感觉就行`;

// ── 调辅助模型分析情绪（与 /api/text-analysis 同一条链路）──
// 宿主给 pre-step 的硬超时是 30 秒（实测 RPC callback.hooks.adjudicate timed out
// after 30000ms）。实测选定的辅助模型典型响应 14～18 秒：单次要给足，
// 不能再靠「两次短超时相加」拼——总时长一样，但每次都被砍一半。
// 预算 24 秒（单次上限 22 秒），留出余量给宿主的 30 秒闸门。
const OBSERVE_BUDGET_MS = 24000;

async function callEmotionAnalysis(ctx, messages, agentId = 'unknown') {
  const result = await analyzeConversation({
    ctx,
    messages,
    prompt: EMOTION_DETECT_PROMPT,
    totalBudgetMs: OBSERVE_BUDGET_MS,
  });
  if (!result.ok) return { ok: false, error: result.error || '模型调用失败' };
  return result;
}

// ── Jev 旁路观测点 ──
// v0.34.54：这里采样，判出来的分才有对照物。正样本（真贴了图）必采，
// 负样本抽 25%，正负都有才判得出 Jev 到底更准还是只是更敢发。
const JEV_STATE_TURNS = 6;

function extractMsgText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.find(part => part?.type === 'text' && typeof part.text === 'string')?.text || '';
  }
  return '';
}

export function buildJevState(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .filter(m => m?.role === 'user' || m?.role === 'assistant')
    .slice(-JEV_STATE_TURNS)
    .map(m => {
      const text = extractMsgText(m.content);
      return text ? `${m.role === 'user' ? '用户' : '助手'}：${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function observeJev(logPath, ctx, messages, session, { decision, data, emotion, sceneType, agentId, emotionLatencyMs, positive }) {
  if (!positive && !shouldSampleNegative()) return;
  void runJevShadow({
    state: buildJevState(messages),
    actual: {
      decision,
      has_emotion: data?.has_emotion === true,
      emotion: emotion || data?.emotion || '',
      scene_type: sceneType || data?.scene_type || '',
      intensity: data?.intensity || '',
      emotion_latency_ms: emotionLatencyMs,
    },
    agentId,
    sessionId: session?.sessionId || '',
    positive,
    // ctx 必须带上：App 里全局 fetch 不通，Jev 得走宿主的受控出口
    ctx,
  }).catch((error) => {
    appendLog(logPath, `[context] Jev 旁路失败: ${error.message}`);
  });
}

// ── ritual 词表（问候词短路）──
const RITUAL_WORDS = [
  '早安', '早呀', '早上好', '早安呀', '中午好', '下午好',
  '晚安', '晚安安', '不早了', '该睡了',
  '你好', '哈喽', '嗨', 'hi', 'hello',
  '在吗', '想你'
];

function detectRitual(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let last = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') { last = messages[i]; break; }
  }
  if (!last) return null;
  const text = (typeof last.content === 'string' ? last.content :
                (Array.isArray(last.content) ? (last.content.find(p => p?.type === 'text')?.text || '') : ''))
               .toLowerCase().trim();
  if (!text) return null;
  for (const w of RITUAL_WORDS) {
    // v0.19.5 - 英文短词用词边界（matchRitualWord），避免 this/while/something 误判 hi
    if (matchRitualWord(text, w)) return { word: w, text };
  }
  return null;
}

// ── 调试日志（带轮转，最多保留 200 行）──
export function observerLogPath() {
  return join(DATA_DIR, 'observer-debug.log');
}

function appendLog(logPath, line) {
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const entry = `${ts} ${line}\n`;
    try {
      const stat = statSync(logPath);
      if (stat.size > DEBUG_LOG_MAX_BYTES) {
        const old = readFileSync(logPath, 'utf-8').split('\n').slice(-DEBUG_LOG_KEEP_LINES).join('\n');
        writeFileSync(logPath, old + entry, { encoding: 'utf-8' });
        return;
      }
    } catch { /* 文件不存在就往下走正常追加 */ }
    writeFileSync(logPath, entry, { flag: 'a', encoding: 'utf-8' });
  } catch { /* 写日志失败不能影响主流程 */ }
}

// v0.34.51 - 关键词清洗：数组或逗号分隔字符串都收，去重、截长、限个数
const MAX_KEYWORDS = 6;
const KEYWORD_MAX_LEN = 12;
export function sanitizeKeywords(raw, maxCount = MAX_KEYWORDS) {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/[,，、]/) : []);
  const out = [];
  for (const item of list) {
    const k = sanitizeTag(item, KEYWORD_MAX_LEN);
    if (!k || out.includes(k)) continue;
    out.push(k);
    if (out.length >= maxCount) break;
  }
  return out;
}

// ── 注入提示 ──
// App 环境里工具就叫 express 且对模型可见，不需要插件版那套
// 「先用 tool_search 找 biaoqingbao_express 再 tool_call」的旧宿主拐杖。
export function buildHintText(emotion, keywords = [], reason = '', query = {}) {
  const kwList = keywords.join('、');
  const extra = [
    kwList ? `关键词：${kwList}` : '',
    query.scene ? `场景：${query.scene}` : '',
    query.tone ? `语气：${query.tone}` : '',
    query.intensity ? `强度：${query.intensity}` : '',
  ].filter(Boolean).join('；');
  const because = reason ? `（${reason}）` : '';
  const argHint = `调用 express 工具即可，情绪参数用「${emotion}」${extra ? `，并带上这些参考：${extra}` : ''}。`;
  // 只留一句话口径：这一轮最多一张。两条通道说同一件事时模型会各发一张，单通道同样要写死。
  const onePerTurn = '这一轮最多发一张，选最贴的那张，不要再补第二张（重复发图会被拦下）。';
  // v0.1.25 - 模型偶尔不走工具，改成在正文里自己写一段标记文字：图发不出去，标记还会被当正文显示。
  // 这里明着堵一句。刻意不写那句标记的字面样子，写出来反而可能被照抄。
  const noFakeTag = '发图只能靠真正调用这个工具，不要用文字写标记来代替，那样发不出图，还会被当成正文显示出来。';
  return `💡 你似乎有些${emotion}${because}，可以用一张表情包表达这个感受。${argHint}${onePerTurn}${noFakeTag}`;
}

// 注入提示：不改宿主传进来的消息对象，返回一份新的消息数组。
// 原地写有两个风险：宿主的对象可能是冻的（严格模式下直接抛错）；
// 而且 pre-step 的契约本来就是要一个 decision.messages 回去，复制更贴合。
export function buildInjectedMessages(messages, emotion, keywords = [], reason = '', query = {}) {
  if (!Array.isArray(messages)) return null;
  // 先确认有可追加的真实用户消息，失败时不留下半份提醒。
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return null;
  const userMsg = messages[lastUserIdx];
  if (typeof userMsg.content !== 'string' && !Array.isArray(userMsg.content)) return null;

  const nudge = `\n\n${buildHintText(emotion, keywords, reason, query)}`;
  const content = typeof userMsg.content === 'string'
    ? userMsg.content + nudge
    : [...userMsg.content, { type: 'text', text: nudge }];

  const next = messages.slice();
  next[lastUserIdx] = { ...userMsg, content };
  return next;
}

// ── 主入口：agent/pre-step ──
// 返回 { messages } 表示改写这一轮要发的消息；返回 undefined 表示什么都不做。
// 任何异常都不许冒泡到钩子外面，配图失败不能影响聊天。
export async function observeBeforeStep({ ctx, messages, session } = {}) {
  const logPath = observerLogPath();
  const agentId = resolveAgentId({}, { sessionPath: session?.sessionPath });
  const sessionKey = session?.sessionPath || '';
  // 每轮先清掉上一轮留下的注入记录：post-assistant 只在「本轮真的提醒过」时才补发，
  // 残留记录会把下一轮带偏（比如上一轮提醒了、这一轮却没提醒）。
  clearInjection(sessionKey);
  const msgCount = Array.isArray(messages) ? messages.length : -1;
  appendLog(logPath, `[context] agent=${agentId} messages=${msgCount}`);

  try {
    // 0. 全局总闸与连续配图冷却；全局关闭不改写各伙伴原有频率配置。
    const freqConfig = readAgentFreq();
    if (!isAutoImageEnabled(freqConfig)) {
      appendLog(logPath, '[context] 自动配图总闸已关闭，跳过情绪检测与配图提示');
      return;
    }
    const freqSettings = getAgentFreqSettings(agentId);
    if (!freqSettings.enabled) {
      appendLog(logPath, `[context] 助手 ${agentId} 已关闭配图，跳过`);
      return;
    }
    if (consumeAgentStickerCooldown(agentId)) {
      appendLog(logPath, `[context] 助手 ${agentId} 上一轮刚发过图，本轮冷却`);
      return;
    }

    // 1. 读配置
    const config = readTextConfig();
    if (!config.enabled) {
      appendLog(logPath, '[context] 辅助模型未启用，跳过');
      return;
    }

    // 2. 没消息不分析
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    // 3. 问候属于日常场景：只按 daily 抽一次，不调用辅助模型
    const ritualHit = detectRitual(messages);
    if (ritualHit) {
      if (!isAutoImageEnabled(readAgentFreq())) {
        appendLog(logPath, '[context] 自动配图总闸在问候提示前关闭，跳过');
        return;
      }
      if (!passesFrequency(freqSettings.daily)) {
        appendLog(logPath, `[context] ritual 命中但日常频率=${freqSettings.daily}% 未通过`);
        return;
      }
      const next = buildInjectedMessages(messages, '开心');
      if (next) {
        appendLog(logPath, `[context] ritual 命中: ${ritualHit.word} -> 提示 express('开心')`);
        rememberInjection(sessionKey, { emotion: '开心', agentId, source: 'ritual' });
        return { messages: next };
      }
      return;
    }

    // 4. B 方案第一阶段：按两个场景中的最高频率预筛，提前省掉部分辅助模型调用
    const preFreq = Math.max(freqSettings.daily, freqSettings.task);
    if (!passesFrequency(preFreq)) {
      appendLog(logPath, `[context] 助手 ${agentId} 预筛频率=${preFreq}% 未通过，跳过`);
      return;
    }

    // 5. 再检查一次总闸，覆盖频率预筛期间用户刚好关闭开关的竞态。
    if (!isAutoImageEnabled(readAgentFreq())) {
      appendLog(logPath, '[context] 自动配图总闸在情绪检测前关闭，跳过');
      return;
    }

    // 6. 调辅助模型分析情绪 + 场景
    const emotionStartedAt = Date.now();
    const result = await callEmotionAnalysis(ctx, messages, agentId);
    const emotionLatencyMs = Date.now() - emotionStartedAt;
    if (!result.ok) {
      appendLog(logPath, `[context] 情绪分析失败: ${result.error} | 耗时 ${emotionLatencyMs}ms`);
      return;
    }

    const data = result.data;
    if (!data?.has_emotion) {
      appendLog(logPath, `[context] 无情绪波动，跳过：${data?.reason || 'unknown'} | 耗时 ${emotionLatencyMs}ms`);
      observeJev(logPath, ctx, messages, session, { decision: 'no_emotion', data, agentId, emotionLatencyMs, positive: false });
      return;
    }

    // v0.19.5 - 情绪词清洗（共用 sanitizeTag，去控制字符/换行/引号）
    const emotion = sanitizeTag(data.emotion || '', 30);
    if (!emotion) {
      appendLog(logPath, '[context] has_emotion=true 但 emotion 为空或不合规，跳过');
      return;
    }

    // v0.34.51 - 关键词与 reason：一起注入，让配图检索有情境信息可用
    const keywords = sanitizeKeywords(data.keywords);
    const reason = sanitizeTag(data.reason || '', 40);
    const query = {
      scene: sanitizeTag(data.scene || '', 4),
      tone: sanitizeTag(data.tone || '', 12),
      intensity: ['light', 'medium', 'strong'].includes(data.intensity) ? data.intensity : '',
    };

    // 7. B 方案第二阶段：按 sceneFreq / preFreq 校准，使最终概率恰好等于场景频率
    const sceneType = data.scene_type || '中性';
    const sceneFreq = sceneType === '正事' ? freqSettings.task : freqSettings.daily;
    const conditionalPercent = getConditionalScenePercent(sceneFreq, preFreq);
    if (!passesFrequency(conditionalPercent)) {
      appendLog(logPath, `[context] 情绪=${emotion} 场景=${sceneType} 目标=${sceneFreq}% 校准未通过 | 耗时 ${emotionLatencyMs}ms`);
      observeJev(logPath, ctx, messages, session, { decision: 'rejected', data, emotion, sceneType, agentId, emotionLatencyMs, positive: false });
      return;
    }

    // 8. 注入提示
    const injected = buildInjectedMessages(messages, emotion, keywords, reason, query);
    if (injected) {
      appendLog(logPath, `[context] ✅ 情绪感知: ${emotion} | 关键词数: ${keywords.length} | 场景: ${sceneType} | freq: ${sceneFreq} | 耗时 ${emotionLatencyMs}ms`);
      rememberInjection(sessionKey, { emotion, keywords, reason, query, agentId, source: 'emotion' });
      observeJev(logPath, ctx, messages, session, { decision: 'injected', data, emotion, sceneType, agentId, emotionLatencyMs, positive: true });
      return { messages: injected };
    }
  } catch (e) {
    appendLog(logPath, `[context] ❌ 出错: ${e?.message || e}`);
  }
}
