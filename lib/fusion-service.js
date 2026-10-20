// lib/fusion-service.js — 表情包（纸飞机）这一侧的融合服务
//
// 闲不住的融合协调器要拿到三样东西：球在不在跑、球在屏幕哪儿、能不能代理它的业务。
// 它读不到本 App 的数据目录，所以由表情包把服务挂在宿主命名为 app:biaoqingbao-app/fusion
// 的自定义动词上，调用方要有 app/services.call。
//
// 只暴露四件事：
//   ① snapshot 球在不在跑、在屏幕哪儿
//   ② start    启动纸飞机
//   ③ stop     停纸飞机
//   ④ place    把纸飞机放回指定坐标（拆回两球时用；只有表情包自己写得动这个文件）
//
// ⚠ 纸飞机走的是 stdin/stdout 管道，不是回环 HTTP 桥（App 子进程拿不到 --allow-net）。
//    所以 snapshot 里的 proxy 恒为 null：融合球目前**代理不了**表情包的业务，
//    只能共用它的窗口与物理。要接面板，得先给纸飞机补一条可跨进程的通道。

import fs from "node:fs";
import path from "node:path";

const STATE_FILE = "ball-state.json";
const BALL_SIZE = { width: 72, height: 72 };
export const FUSION_METHOD = "fusion";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function planeSnapshotFrom(dataDir, state = {}) {
  const dir = typeof dataDir === "string" ? dataDir.trim() : "";
  if (!dir) return { running: false, position: null, panel: "none", proxy: null };
  const fileState = readJson(path.join(dir, STATE_FILE)) || {};
  const x = asNumber(fileState.x);
  const y = asNumber(fileState.y);
  const running = Boolean(state?.running);
  return {
    running,
    // 球停了还留着旧坐标时不该报位置，否则闲不住会拿一具尸体去算重叠。
    position: running && x !== null && y !== null
      ? { x, y, width: BALL_SIZE.width, height: BALL_SIZE.height }
      : null,
    panel: "none",
    proxy: null,
  };
}

/**
 * 注册表情包的融合服务。宿主把名字固定成 app:biaoqingbao-app/fusion，
 * 跨 App 调用方需要声明 allowCrossApp，调用方自己要有 app/services.call。
 */
export async function registerFusionService({ sdk, start, stop, state }) {
  if (typeof sdk?.bus?.handle !== "function") {
    await sdk?.logger?.warn?.("宿主没有 bus.handle，纸飞机融合服务没有注册");
    return null;
  }
  try {
    const dispose = await sdk.bus.handle(FUSION_METHOD, async (payload = {}) => {
      const action = String(payload?.action || "snapshot");
      if (action === "stop") {
        const result = await stop();
        return { ok: result?.ok !== false, running: false, error: result?.error || "" };
      }
      if (action === "start") {
        const result = await start();
        return { ok: result?.ok !== false, running: Boolean(result?.ok), error: result?.error || "" };
      }
      if (action === "place") {
        // 字段与 ball_app.py 的状态读写对齐：x / y。
        const dir = typeof sdk.dataDir === "string" ? sdk.dataDir.trim() : "";
        const x = asNumber(payload?.x);
        const y = asNumber(payload?.y);
        if (!dir) return { ok: false, error: "表情包没有拿到自己的数据目录" };
        if (x === null || y === null) return { ok: false, error: "位置参数无效" };
        const fileState = readJson(path.join(dir, STATE_FILE)) || {};
        fileState.x = Math.round(x);
        fileState.y = Math.round(y);
        if (!writeJson(path.join(dir, STATE_FILE), fileState)) {
          return { ok: false, error: "纸飞机位置保存失败" };
        }
        return { ok: true, x: fileState.x, y: fileState.y };
      }
      if (action !== "snapshot") {
        return { ok: false, error: `不认识的融合动作：${action}` };
      }
      return { ok: true, ...planeSnapshotFrom(sdk.dataDir, state()) };
    }, { allowCrossApp: true });
    await sdk.logger?.info?.("融合服务已注册：app:biaoqingbao-app/fusion");
    return dispose;
  } catch (error) {
    // 没拿到 app/services.provide 就退化成单侧：纸飞机照常自己跑，不牵连别处。
    await sdk?.logger?.warn?.(`融合服务注册失败，纸飞机单侧运行：${error?.message || error}`);
    return null;
  }
}
