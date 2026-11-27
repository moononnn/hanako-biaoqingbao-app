// lib/pick-verify.js - 选图复核：让便宜的小模型看一眼「这张图真的接得住这句情绪吗」
//
// 为什么要有这一层：
// 标签和向量都是「先算分再取最高」，两种算法都看不见「方向」——想道歉配到嘲讽图、
// 想关心配到大哭图，分数上照样很高。复核把最后一步交还给一个能读懂画面和语境的模型：
// 候选摆出来，问它哪张真的对得上，都不对就说没有。
//
// 三条纪律：
//   1. 只读不写：不落库、不动标签、不改偏好。
//   2. 失败放行（fail-open）：没配模型、超时、返回看不懂，一律按原选择走，不阻塞发图。
//   3. 只做否决和换人，不做创作：候选只能是打分器给的那几张，不许它自己编。
//
// 成本：一次小模型调用，输入约 600 字。用设置页里选定的那个文本模型（通常是最便宜的 flash）。

import { readTextConfig } from './shared.js';
import { callConfiguredTextModel } from './text-model.js';

export const VERIFY_TIMEOUT_MS = 3200;
export const VERIFY_MAX_CANDIDATES = 5;
const CLIP = 60;

function clip(value, max = CLIP) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 候选压成复核用的形状：只给判断需要的信息，不给分数和 ID 以外的东西。 */
export function buildCandidateList(scored, limit = VERIFY_MAX_CANDIDATES) {
  return (Array.isArray(scored) ? scored : []).slice(0, limit).map((sticker) => ({
    id: String(sticker?.id || ''),
    emotion: (Array.isArray(sticker?.tags?.emotion) ? sticker.tags.emotion : []).slice(0, 3).join('、'),
    description: clip(sticker?.description),
    semantic: clip(sticker?.semantic_description),
  }));
}

export const VERIFY_PROMPT = `你是表情包配图的复核员。助手这一轮想表达一种感受，并给了当时的语境，下面是算法挑出的候选表情包。
你的任务：判断哪一张真的接得住这个感受。

只返回纯 JSON，不要代码块，不要别的字：
{"pick":"stk_xxx"}
或
{"pick":null,"reason":"一句为什么都不贴"}

判断规则：
- 只选画面和使用场合都真的对得上的那一张。
- 方向相反的不要选：想道歉却给嘲讽、想关心却给大哭、想开心却给嫌弃，都算方向反。
- 带怼人、反讽、阴阳语气的图，不能拿来表示诚恳、抱歉、感谢、关心。
- 拿不准时选最贴的那张；只有确实一张都不贴，才返回 null。`;

/** 组装复核请求的消息。纯函数，方便测试。 */
export function buildVerifyMessages({ emotion, keywords = [], scenes = [], tone = '', candidates = [] }) {
  const context = [
    `想表达：${clip(emotion, 20) || '（未提供）'}`,
    keywords.length ? `语境关键词：${keywords.join('、')}` : '',
    scenes.length ? `场景：${scenes.join('、')}` : '',
    tone ? `语气：${tone}` : '',
  ].filter(Boolean).join('；');
  const lines = candidates.map((c, i) => {
    const parts = [`${i + 1}. ${c.id}`];
    if (c.emotion) parts.push(`情绪：${c.emotion}`);
    if (c.description) parts.push(`画面：${c.description}`);
    if (c.semantic) parts.push(`适合：${c.semantic}`);
    return parts.join(' | ');
  });
  return [
    { role: 'system', content: VERIFY_PROMPT },
    { role: 'user', content: `${context}\n\n候选：\n${lines.join('\n')}` },
  ];
}

/**
 * 解析复核结果。严格限定在候选 id 里：模型编一个不存在的 id 就当作没验过。
 * 返回 { pick: id|null, reason } 或 null（解析失败/不可信）。
 */
export function parseVerifyResult(text, validIds) {
  const raw = String(text || '').replace(/```json?\s*/g, '').replace(/```/g, '').trim();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { data = JSON.parse(m[0]); } catch { return null; }
  }
  if (!data || typeof data !== 'object') return null;
  const reason = typeof data.reason === 'string' ? clip(data.reason, 60) : '';
  const pick = data.pick;
  if (pick === null || pick === undefined || pick === '' || pick === 'none') {
    return { pick: null, reason };
  }
  const id = typeof pick === 'string' ? pick.trim() : '';
  const allowed = new Set(Array.isArray(validIds) ? validIds : []);
  if (!id || !allowed.has(id)) return null;
  return { pick: id, reason };
}

/**
 * 复核一次。永不抛错。
 * 返回 { verified: false, reason } 表示没验成（调用方按原选择走）；
 *      { verified: true, pick: id|null } 表示验成，pick=null 就是「都不贴，别发」。
 */
export async function verifyPick(ctx, {
  emotion,
  keywords = [],
  scenes = [],
  tone = '',
  candidates = [],
  timeoutMs = VERIFY_TIMEOUT_MS,
  textConfig = null,
} = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.id);
  // 只有一张候选时不值得花一次调用，也没有「选错」的余地。
  if (list.length < 2) return { verified: false, reason: '候选不足' };

  let cfg;
  try {
    cfg = textConfig || readTextConfig();
  } catch {
    return { verified: false, reason: '读不到文本模型配置' };
  }
  if (!cfg || cfg.source !== 'hana' || !cfg.providerId || !cfg.modelId) {
    return { verified: false, reason: '未配置 Hana 文本模型' };
  }
  if (cfg.verifyPick === false) {
    return { verified: false, reason: '复核已关闭' };
  }

  const messages = buildVerifyMessages({ emotion, keywords, scenes, tone, candidates: list });
  let result;
  try {
    result = await callConfiguredTextModel(ctx, cfg, messages, {
      maxTokens: 200,
      reasoningEffort: 'low',
      temperature: 0.1,
      timeoutMs,
    });
  } catch (error) {
    return { verified: false, reason: `复核调用失败: ${error?.message || error}` };
  }
  if (!result?.ok || !String(result.data || '').trim()) {
    return { verified: false, reason: result?.error || '复核模型返回空正文' };
  }
  const parsed = parseVerifyResult(result.data, list.map((c) => c.id));
  if (!parsed) return { verified: false, reason: '复核结果无法解析' };
  return { verified: true, pick: parsed.pick, reason: parsed.reason || '' };
}