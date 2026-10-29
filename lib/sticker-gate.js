// lib/sticker-gate.js - 配图准入的统一判定
//
// 一次算清「这个会话、这个伙伴，此刻能不能碰表情包」，三处共用：
//   1. index.js 工具注册表里 express 的外层包装（模型主动调）
//   2. index.js 注册的 tools/pre-execute 兜底（模型调别的表情包工具也走这里）
//   3. messages/post-assistant 的补发路径（不经过工具注册表，自己有入口）
//
// 为什么要有这个模块：2026-10-25 实测 Code 窗口总闸是关着的，模型调 express
// 仍然发出去了一张图（probe.log 13:17:56）。原因有两个：
//   a. 外层 gate 只判「窗口是不是 Code」，判不出来就放行；
//   b. 它只看 Code 总闸，不看这个伙伴自己的 task 档。
// 三处各写一半，就漏在三处之间。现在判定收成一处，谁要放行都得先过它。

import {
  readAgentFreq,
  isAutoImageEnabled,
  isCodeWindowEnabled,
} from "./shared.js";
import { isCodeSession, isSubagentSession, pickWindowFreq, shouldSkipForCodeWindow } from "./session-kind.js";

/**
 * 拒绝时给模型看的话。必须说清「不用再试」，否则模型会把拒绝当成失败重来一次。
 * 措辞照抄 express 同一轮限一张那套「已经处理过了」的口径。
 */
const REFUSALS = {
  global_off: "自动配图总闸关着，这个窗口一张都不发。",
  agent_off: "这个伙伴的配图功能关着，一张都不发。",
  code_window_off: "Code 窗口的配图总闸关着，这个窗口不碰表情包，想用请到聊天窗口去。",
  code_freq_zero: "这个伙伴在 Code 窗口的配图频率是 0，这里不碰表情包，想用请到聊天窗口去。",
  freq_zero: "这个会话的配图频率是 0，不发。",
  subagent: "这是子代理会话，不配图。",
  window_unknown: "判不出这个会话属于哪个窗口，而 Code 总闸是关着的，按 Code 处理，不碰。",
};

/** 伙伴自己的三档设置；没配过就退回全局默认，跟 getAgentFreqSettings 同口径。 */
function agentSettings(cfg, agentId) {
  const mine = agentId ? cfg?.agents?.[agentId] : null;
  if (mine) return mine;
  return { enabled: true, daily: cfg?.default_daily, task: cfg?.default_task };
}

/**
 * 纯判定：不查会话、不发网络请求，方便单测。
 * @param {{namespace?:string, agentId?:string, config?:object, sessionPath?:string, sessionKind?:string}} input
 * @returns {{allowed:boolean, reason:string, window:'code'|'chat'|'unknown'|'subagent', freq:number, text:string}}
 */
export function decideStickerAccess({ namespace, agentId, config, sessionPath, sessionKind } = {}) {
  const cfg = config || readAgentFreq();
  const unknownWindow = { window: "unknown", freq: 0 };

  // 子代理会话一律不配图（2026-10-26）：那是她自己派出去干活的窗口，不是聊天。
  // 这条要看在总闸之前——用户把总闸关着时也一样，结论都是不发。
  if (isSubagentSession({ sessionPath, sessionKind })) {
    return { allowed: false, reason: "subagent", ...unknownWindow, text: REFUSALS.subagent };
  }

  if (!isAutoImageEnabled(cfg)) {
    return { allowed: false, reason: "global_off", ...unknownWindow, text: REFUSALS.global_off };
  }

  const settings = agentSettings(cfg, agentId);
  if (!settings.enabled) {
    return { allowed: false, reason: "agent_off", ...unknownWindow, text: REFUSALS.agent_off };
  }

  // 明确的 Code 会话：总闸和伙伴那一档都要过。
  // 与注入层共用 shouldSkipForCodeWindow：总闸关着时，明确是 Code 就拒，
  // **判不出分区也拒**（从严，跟注入层同一个口径）。
  // 两边口径分叉过的后果很具体：注入层判「在聊天页」塞了配图提示，工具层判「在 Code 页」
  // 把发图拒掉，用户看到的是「总闸关了还在被怂恿配图，然后又被拒」（2026-10-29 实测）。
  if (shouldSkipForCodeWindow({ namespace, codeEnabled: isCodeWindowEnabled(cfg) })) {
    const known = Boolean(String(namespace || "").trim());
    if (known) {
      return { allowed: false, reason: "code_window_off", window: "code", freq: 0, text: REFUSALS.code_window_off };
    }
    return { allowed: false, reason: "window_unknown", ...unknownWindow, text: REFUSALS.window_unknown };
  }
  if (isCodeSession(namespace)) {
    const freq = pickWindowFreq(settings, true);
    if (!(freq > 0)) {
      return { allowed: false, reason: "code_freq_zero", window: "code", freq, text: REFUSALS.code_freq_zero };
    }
    return { allowed: true, reason: "ok", window: "code", freq, text: "" };
  }

  // 窗口判不出来（session:get 超时、宿主没给 namespace）：
  // 总闸开着就按聊天页放行，别让一次总线超时误杀聊天。
  const known = Boolean(String(namespace || "").trim());
  const freq = pickWindowFreq(settings, false);
  if (!(freq > 0)) {
    return { allowed: false, reason: "freq_zero", window: "chat", freq, text: REFUSALS.freq_zero };
  }
  return { allowed: true, reason: "ok", window: "chat", freq, text: "" };
}

/**
 * 把拒绝包成工具结果：ok:true + skipped。
 * 不返回 error，模型才不会当成「没成功、换个方式再试」。
 */
export function skippedToolResult(decision) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        data: {
          action: "skipped",
          reason: decision?.reason || "blocked",
          message: `${decision?.text || "这个窗口不发图。"}不用再试，正常把话说完就好。`,
        },
      }),
    }],
  };
}

/**
 * 带会话解析的版本：给拿得到 resolver 的调用方（index.js）用。
 * 解析失败按「窗口未知」走，判定层自己决定从严还是放行。
 */
export async function resolveStickerAccess({ resolveMeta, sessionId, sessionPath, agentId, config, sessionKind } = {}) {
  let namespace = "";
  if (typeof resolveMeta === "function") {
    try {
      const meta = await resolveMeta({ sessionId, sessionPath });
      namespace = meta?.namespace || "";
    } catch {
      namespace = "";
    }
  }
  return decideStickerAccess({ namespace, agentId, config, sessionPath, sessionKind });
}
