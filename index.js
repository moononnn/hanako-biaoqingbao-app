// 表情包 App 版 — 入口
//
// 负责四件事：
//   1. 把宿主给的数据目录交给 lib 层（BQB_DATA_DIR）；App 读不到宿主机文件，
//      模型目录改由宿主接口灌进 shared.js 的缓存
//   2. 注册情绪观察器（agent/pre-step）：模型调用前判断要不要配图、注入提示
//   3. 注册八个业务工具，由模型主动调用
//   4. 注册路由层与页面启动数据
//
// 通道选型（踩过一次坑，留在这里）：
//   插件版用「Node 起本地 HTTP 桥 + Python 当客户端」，在 App 里走不通 ——
//   App 子进程拿不到 --allow-net，net 的 bind 会被 Permission Model 直接拒绝。
//   悬浮球改成 stdin/stdout，一行一条 JSON。
//
// 启动健康信息记在 app-data/biaoqingbao-app/probe.log（文件名沿用 PoC 期，内容现在只剩正式链路）。

import { defineApp } from "./sdk/app-contract/server-client.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
// ⚠ 不要在这里静态 import lib/ 下的任何模块（走通会连到 lib/shared.js）。
// shared.js 在模块加载时就把 DATA_DIR 定死了，而顶部 import 在 apply 之前执行——
// 那时 BQB_DATA_DIR 还没设，它只能自己拼 homedir 路径，拼出来是 junction 链接路径，
// 在 App 沙箱下读文件一律被拒（实测：宿主给的数据目录是真实路径，而自己拼出来的是联接路径，两边对不上，读到 0 条）。
// 需要的模块都在 apply 里、设置完 BQB_DATA_DIR 之后动态 import。

export const name = "biaoqingbao-app";

export default defineApp(async (sdk) => {
  const probePath = join(sdk.dataDir, "probe.log");

  const record = (line) => {
    try {
      mkdirSync(sdk.dataDir, { recursive: true });
      appendFileSync(probePath, `${new Date().toISOString()} ${line}\n`, "utf-8");
    } catch (e) {
      // 记录失败不能影响主流程
    }
  };

  // ── 已删除的内插实验（2026-10-06 写，2026-10-09 结案）──
  //   当时的问题是：图走 session:send-custom 是一条独立消息，只能排在正文之后，
  //   观感上像「说完话再单独甩一张」。于是想图能插回这条 assistant 消息本身。
  //   实机结论（2026-10-09 20:52）：两种模式都不行，这条路封死。
  //     marker = 插一行 [attached_image: 路径]，宿主界面不认，原样显示成文字；
  //     image  = 插真图字节块，图确实进了这条消息、也真的落进了 jsonl
  //              （29946 字节、无投影占位），但界面上一个像素都没有。
  //   也就是说宿主根本不渲染助手消息里的图片块。2026-10-06 关掉它时写的理由是
  //   「怕会话变沉」——理由写错了：它本来就不可能成，跟体积无关。
  //   当时的注释写着「实验有结论后连同 rememberPendingInline / tryInlinePending
  //   一起剃掉」，现在就是那个时刻。已删除：experiment() / rememberPendingInline /
  //   insertBeforeSummary / tryInlinePending / pendingInline / MIME_BY_EXT。
  //   别再重做这个实验，除非宿主那边先支持了「渲染 assistant 消息里的图片块」。
  record("apply-enter");

  // ── 数据目录交接 ──
  // 必须用宿主交给应用的那个，不能自己按 homedir() 拼：本机 <HOME>\.hanako 是
  // 目录联接（Junction），自己拼出来的是链接路径，
  // 在 App 的 fs 权限检查下会被拒。
  // lib/shared.js 在模块加载时就会按这个变量定下路径，所以要在 import 之前设好。
  process.env.BQB_DATA_DIR = sdk.dataDir;

  // 数据目录定下来之后才能碰 lib 层（原因见文件顶部那段注释）
  const { registerMessageCardRoutes } = await import("./lib/ball-message-card.js");
  const { extractSelectedSticker, deliverStickerToSession } = await import("./lib/sticker-delivery.js");
  // v0.1.38 - 图不在这轮的半路上投，先排队，等这条回复定稿、会话静下来再投
  // （边回话边投会让宿主必然再叫一轮，理由见 lib/sticker-after-turn.js 顶部）
  const { queueStickerDelivery, flushStickerDelivery, hasPendingSticker } = await import("./lib/sticker-after-turn.js");
  // 伪标记兜底：清洗 + 注入登记（谁在什么时候登记，见 lib/pseudo-tag.js 顶部）
  const { stripPseudoTags, peekInjection, markInjectionDelivered } = await import("./lib/pseudo-tag.js");

  // ── 模型目录灌入 ──
  // App 读不到 models.json，改由宿主接口灌入 shared.js 的模型目录缓存。
  try {
    const shared = await import("./lib/shared.js");
    const r = await sdk.models?.list?.();
    const n = shared.setModelCatalog(r);
    record(
      `models注入 ${n} 个；视觉可选=${shared.getAvailableVisionModels().length} 组；` +
      `文本可选=${shared.getAvailableTextModels().length} 组；embedding=${shared.getAvailableEmbeddingModels().length} 组；` +
      `推理判断=${shared.isReasoningModel()}`
    );
  } catch (e) {
    record(`models注入失败 ${e?.code || ""} ${e?.message || e}`);
  }

  // ── ⚠ 临时诊断（2026-10-06）：探 App 手里的发图通道牌面。
  //   只读探测：不调用任何接口，只问「有没有这个口子」，结果写进 probe.log。
  // ── 启动健康检查：图库元数据能不能读（只读，不碰偏好与配置）──
  try {
    const shared = await import("./lib/shared.js");
    const meta = shared.readMeta();
    record(`meta-ok 条目=${Array.isArray(meta) ? meta.length : "?"}`);
  } catch (e) {
    record(`meta-failed ${e?.code || ""} ${e?.message || e}`);
  }

  // ── 情绪观察器：agent/pre-step（模型调用前改写 messages）──
  // 接管插件版 observer 的职责：让 App 独立完成「发现该配图 → 提示模型调 express → 模型发图」。
  try {
    const { observeBeforeStep } = await import("./lib/observer.js");
    sdk.hooks.onDecision("agent/pre-step", async (payload) => {
      try {
        const messages = payload?.messages;
        const count = Array.isArray(messages) ? messages.length : -1;
        const decision = await observeBeforeStep({
          ctx: sdk,
          messages,
          session: payload?.session,
        });
        record(`hook-pre-step session=${payload?.session?.sessionId ?? "?"} messages=${count} injected=${decision ? "yes" : "no"}`);
        return decision;
      } catch (e) {
        // 配图出问题不许影响聊天：记一笔，什么都不改
        record(`hook-pre-step-error ${e?.message || e}`);
        return undefined;
      }
    });
    record("hook-registered observer");
  } catch (e) {
    record(`hook-register-error ${e?.message || e}`);
  }

  // ── 伪标记兜底：messages/post-assistant（助手消息定稿那一刻）──
  // 现场（2026-10-06）：模型偶尔不走 express 工具，而是在正文里自己写一段像指令的标记，
  // 宿主不认识这种东西，只能当普通文字原样显示，图也没发出去。
  // 这里剪掉独占整行的标记；若本轮观察器确实提醒过发图（说明模型本来就想发），
  // 顺手替它把这张图投出去，走的就是 express 工具成功时那条投递通道。
  try {
    sdk.hooks.onDecision("messages/post-assistant", async (payload) => {
      try {
        const message = payload?.message;
        const content = message?.content;
        const sessionPath = payload?.session?.sessionPath || "";

        // v0.1.38 - 这一轮选的图排在这儿投：定稿这一刻会话可能还在收尾，
        // 所以交给 flush 自己等空闲（不 await，别拖住这条已经写好的回复）。
        if (sessionPath && hasPendingSticker(sessionPath)) {
          void flushStickerDelivery(sessionPath, "hook").then((r) => {
            record(`sticker-after-turn ${r?.ok ? (r?.skipped ? "skip" : "ok") : "fail"} idle=${r?.idle} probed=${r?.probed} ${r?.error || ""} ${r?.entryId || ""}`);
          });
        }
        // 宿主只接受保持 assistant 角色的替换件，content 不是数组就不碰
        if (message?.role !== "assistant" || !Array.isArray(content)) return undefined;

        let removedCount = 0;
        const nextContent = content.map((part) => {
          if (part?.type !== "text" || typeof part.text !== "string") return part;
          const { text, removed } = stripPseudoTags(part.text);
          if (!removed.length) return part;
          removedCount += removed.length;
          record(`pseudo-tag 剪掉 ${removed.length} 行 首行=${removed[0].slice(0, 60)}`);
          return { ...part, text };
        });
        // 2026-10-09 结案：这里原来还会把伙伴刚配的图作为图片块插回这条回复。
        // 实机证明宿主不渲染 assistant 消息里的图片块（详见文件顶部那段结案注释），
        // 所以整段连同 tryInlinePending / rememberPendingInline 一起删掉了。
        if (!removedCount) return undefined;
        if (removedCount) record(`hook-post-assistant session=${payload?.session?.sessionId || "?"} 剪掉=${removedCount}`);

        // 补发：本轮提醒过、而且还没真的发出去，才替模型补这一张
        const info = peekInjection(sessionPath);
        if (info && info.status === "pending" && info.emotion) {
          const agentId = agentIdFromSessionPath(sessionPath);
          const expressMod = await import("./tools/express.js");
          const result = await expressMod.execute(
            {
              emotion: info.emotion,
              keywords: info.keywords || [],
              scene: info.query?.scene,
              tone: info.query?.tone,
              intensity: info.query?.intensity,
            },
            { sessionPath, messageId: null, messageText: null, callToken: null, agentId, dataDir: sdk.dataDir },
          );
          const sticker = extractSelectedSticker(result);
          if (sticker) {
            // v0.1.38 - 补发也走排队那条：定稿这一刻会话可能还在收尾，
            // 交给 flush 自己等空闲，别在这里硬投（硬投会再叫起一轮）。
            const queued = queueStickerDelivery({
              sdk,
              dataDir: sdk.dataDir,
              sessionPath,
              sticker,
              text: sticker.description || "",
              emotion: info.emotion,
            });
            if (queued?.ok) {
              markInjectionDelivered(sessionPath);
              void flushStickerDelivery(sessionPath, "pseudo-tag").then((r) => {
                record(`pseudo-tag 补发 ${r?.ok ? (r?.skipped ? "skip" : "ok") : "fail"} idle=${r?.idle} probed=${r?.probed} ${r?.error || ""} ${r?.entryId || ""}`);
              });
            } else {
              record(`pseudo-tag 补发排队失败 ${queued?.error || ""}`);
            }
          } else {
            record(`pseudo-tag 补发跳过：没选出图 ${JSON.stringify(result).slice(0, 120)}`);
          }
        }

        return { message: { ...message, content: nextContent } };
      } catch (e) {
        // 兜底本身出问题不许影响一条已经写好的回复：记一笔，什么都不改
        record(`hook-post-assistant-error ${e?.message || e}`);
        return undefined;
      }
    });
    record("hook-registered pseudo-tag guard");
  } catch (e) {
    record(`hook-post-assistant-register-error ${e?.message || e}`);
  }

  // ── 八个业务工具 ──
  // 老工具是 v1 形状：三个导出（name/description/parameters）+ `execute(input, ctx)`。
  // App 里 execute 是单参数，上下文在 `input.context`：
  //   { sessionPath, messageId, messageText, callToken }
  // 没有 agentId。所以这里做个适配层把老 ctx 造出来，工具文件一个字不改。
  // 伙伴从 sessionPath 反推（...\agents\<agentId>\sessions\...）。
  const agentIdFromSessionPath = (p) => {
    const m = String(p || "").match(/[\\/]agents[\\/]([^\\/]+)[\\/]/);
    return m ? m[1] : null;
  };

  // 工具返回值里别再带 base64 像素。App 环境里 express 拿不到 stageFile，
  // 会把整张图 base64 塞进 JSON 文本返回（实测单次 2.9MB），宿主只能截断，
  // 上下文和历史都被搞脏。图已经由投递通道送出去了，这里把那个字段去掉。
  const stripInlineBase64 = (result) => {
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string" || text.length < 4096) return result;
    try {
      const obj = JSON.parse(text);
      const sticker = obj?.data?.sticker;
      if (!sticker?.url || !String(sticker.url).startsWith("data:")) return result;
      delete sticker.url;
      return { ...result, content: [{ ...result.content[0], text: JSON.stringify(obj) }] };
    } catch {
      return result;
    }
  };
  const legacyToolCtx = (input) => {
    const c = input?.context || {};
    return {
      sessionPath: c.sessionPath ?? null,
      messageId: c.messageId ?? null,
      messageText: c.messageText ?? null,
      callToken: c.callToken ?? null,
      agentId: agentIdFromSessionPath(c.sessionPath),
      dataDir: sdk.dataDir,
    };
  };

  const TOOL_MODULES = [
    "./tools/express.js",
    "./tools/search-stickers.js",
    "./tools/pick-sticker.js",
    "./tools/add-sticker.js",
    "./tools/update-sticker-tags.js",
    "./tools/list-stickers.js",
    "./tools/report-bad-match.js",
    "./tools/note-sticker-fit.js",
  ];

  let toolOk = 0;
  const toolFails = [];
  const toolNames = [];
  for (const rel of TOOL_MODULES) {
    try {
      const t = await import(rel);
      await sdk.tools.register({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        execute: async (input) => {
          const result = await t.execute(input, legacyToolCtx(input));
          // express 在 App 里会降级成 base64 文本返回（没有 ctx.stageFile，
          // details 又会被桥接层换成 {bridgedTool}）。这里补一程：
          // 把选中的那张图真的送进对话流（走纸飞机那条 session:send-custom）。
          if (t.name === "express") {
            try {
              const sticker = extractSelectedSticker(result);
              if (sticker) {
                const sessionPath = input?.context?.sessionPath || "";
                // v0.1.38 - 不在这轮的半路上投：那时会话还在生成中，宿主必然会为这条消息
                // 再叫一轮。先排队，等这条回复定稿再投，triggerTurn: false 那时才真的生效。
                const queued = queueStickerDelivery({
                  sdk,
                  dataDir: sdk.dataDir,
                  sessionPath,
                  sticker,
                  text: sticker.description || "",
                  // 配图当时是什么情绪，卡片上的「应景」靠它入账；丢掉就只剩喜欢/不喜欢。
                  emotion: typeof input?.emotion === "string" ? input.emotion : "",
                });
                record(`sticker-queued ${queued?.ok ? "ok" : "fail"} ${queued?.error || ""}`);
                // 图已选定、只等本轮说完，所以这里就记「本轮发过图」，
                // 免得 post-assistant 那段伪标记兜底以为没发、又补一张。
                if (queued?.ok) markInjectionDelivered(sessionPath);
              }
            } catch (e) {
              // 排队出问题不能弄挂工具调用：记一笔，把原始结果照样交回去
              record(`sticker-queue-error ${e?.message || e}`);
            }
            return stripInlineBase64(result);
          }
          return result;
        },
      });
      toolOk++;
      toolNames.push(t.name);
    } catch (e) {
      toolFails.push(`${rel} → ${e?.code || ""} ${e?.message || e}`);
    }
  }
  record(`tools-registered ${toolOk}/${TOOL_MODULES.length} [${toolNames.join(", ")}]${toolFails.length ? " 失败：" + toolFails.join(" ; ") : ""}`);

  // ── 路由层 ──
  // 老路由导出的是 registerRoutes(app, ctx)，内部用的是 Hono 写法（app.get(path, async (c) => …)），
  // 而应用侧 ctx.routes.register(registrar) 给的正是宿主创建的 Hono app。两者形状一致，api.js 整块搬。
  //
  // ⚠ 不能把路由文件放在 routes/ 目录：那是「另一种互斥写法」的入口。
  //   宿主会扫 routes/ 顶层的每个 .js 当路由源，跟 ctx.routes.register() 同时存在 → 整个应用 failed
  //   （实测报错："defines backend routes twice ... mutually exclusive"）。
  //   所以放到 server/（无特殊含义），只走路由注册这一条。
  try {
    const apiRoutes = (await import("./server/api.js")).default;
    const boot = await import("./server/boot.js");
    sdk.routes.register((app) => {
      apiRoutes(app, sdk);
      registerMessageCardRoutes(app, sdk.dataDir);
      // 页面启动数据：App 版页面是静态的，改由页面自己来取（替代老版的服务端注入）
      app.get("/api/boot", (c) => c.json({ ok: true, data: boot.buildBootData() }));
      /* #release-strip-start 构建发布包时这段会被删掉，见 scripts/build-release.mjs */
      // ⚠ 开发期验证入口：确认伙伴配图的投递链路通不通。发布前必须剃掉。
      app.post("/api/_dev/deliver-test", async (c) => {
        try {
          const body = await c.req.json().catch(() => ({}));
          const sessionPath = body?.sessionPath;
          if (!sessionPath) return c.json({ ok: false, error: "缺 sessionPath" }, 400);
          const shared = await import("./lib/shared.js");
          const meta = shared.readMeta();
          record(`dev-diag DATA_DIR=${shared.DATA_DIR} META=${shared.META_FILE} len=${Array.isArray(meta) ? meta.length : "非数组"} env=${process.env.BQB_DATA_DIR || "空"} sdk=${sdk.dataDir}`);
          const sticker = body?.stickerId ? meta.find((s) => s.id === body.stickerId) : meta[0];
          if (!sticker) return c.json({ ok: false, error: "图库里没有可用的图" }, 400);
          // 故意用系统临时目录当 filePath，模拟真实情况（express 复制出的副本在沙箱外读不到），
          // 验证投递会回退到图库里的原图
          const tempLikePath = join(process.env.TEMP || process.env.TMP || '.', 'biaoqingbao_sent', sticker.file);
          const result = await deliverStickerToSession({
            sdk,
            dataDir: sdk.dataDir,
            sessionPath,
            sticker: { id: sticker.id, file: sticker.file, filePath: tempLikePath, description: sticker.description },
            text: sticker.description,
          });
          record(`dev-deliver ${result?.ok ? "ok" : "fail"} ${result?.entryId || result?.error || ""}`);
          return c.json(result, result?.ok ? 200 : 500);
        } catch (e) {
          record(`dev-deliver-error ${e?.message || e}`);
          return c.json({ ok: false, error: e?.message || String(e) }, 500);
        }
      });
      /* #release-strip-end */
    });
    record("routes-registered api.js + /api/boot");
  } catch (e) {
    record(`routes-register-error ${e?.code || ""} ${e?.message || e}`);
  }

  // 伙伴显示名：App 沙箱只能碰自己的数据目录，读不到 <hana 主目录>/agents/...，
  // 自己拼路径取名字会一路失败、最后退化成英文 id（hanako）。宿主名单里带着中文名，
  // 启动时拉一次存进 lib/agent-name.js，卡片标题和悬浮球都走它。
  try {
    const { cacheHostAgentNames } = await import("./lib/agent-name.js");
    const agentList = await sdk.agents?.list?.({ scope: "all" });
    record(`agent-names cached=${cacheHostAgentNames(agentList?.agents)}`);
  } catch (e) {
    record(`agent-names-error ${e?.code || ""} ${e?.message || e}`);
  }

  await sdk.logger.info("biaoqingbao-app ready");
});
