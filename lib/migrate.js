// lib/migrate.js — 插件数据 → App 数据（一次性搬迁）
//
// 纯 Node，只用 fs / path，不依赖任何宿主 API。这样一份代码两用：
//   · 开发期：用工作台的脚本在 Hana 外面跑，可以先 dry-run 核对清单
//   · 发布版：App 在 apply 里调用，老用户装上 App 后自动把插件数据搬过来
//
// 原则：**只读旧的、只写新的**。源目录一个字节都不动，随时可以回头。

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";

/** 必须迁移的用户资产（相对源目录的文件名） */
export const ASSET_FILES = [
  "stickers.json", // 图库元数据：标签 / 情绪 / 场景 / 描述，最金贵的一份
  "sticker-groups.json", // 自定义分组
  "preferences.json", // 用户偏好
  "agent-freq.json", // 伙伴配图频率
  "agent-fit-notes.json", // 伙伴配图自评降权
  "hidden-agents.json", // 伙伴名单（隐藏）
  "ignored-agents.json", // 伙伴名单（忽略）
  "blocked-agents.json", // 伙伴名单（屏蔽）
  "dialect-config.json", // 方言配置
  "style-profile.json", // 学我说话：画像
  "style-template.json", // 学我说话：模板
  "style-feedback.json", // 学我说话：修正回流
  "context-feedback.json", // 上下文反馈：用户点「不喜欢」的记录与修改建议
  "image-fingerprints.json", // 图片指纹（查重用）
  "vectors.json", // 语义向量检索（重建要花模型调用，值得带）
  "teaching-samples.json", // 教学样本
  "ball-config.json", // 悬浮球配置
  "vision-config.json", // 识图模型配置
  "text-config.json", // 文本模型配置
  "embedding-config.json", // 向量模型配置
  "jev-config.json",
  "display-config.json",
  "export-config.json",
];

/** 必须迁移的目录（图库图片本体） */
export const ASSET_DIRS = ["stickers"];

/** 明确不迁移的，写清原因是为了报告能解释清楚 */
export const SKIP_REASONS = {
  "decision-log.json": "运行日志，可重建",
  "recent-match.json": "运行日志，可重建",
  "exposure-stats.json": "运行统计，可重建",
  "jev-shadow-log.json": "影子日志，可重建",
  "observer-debug.log": "调试日志",
  "dialect-log.json": "运行日志",
  "bad-matches.json": "运行状态，可重建",
  "ball-state.json": "悬浮球运行态，重启重建",
  "batch-tasks.json": "批量任务队列，App 侧功能未搬过来之前没有意义",
  "pending-stage.json": "临时暂存态",
  "public-index.json": "对外索引，启动时自动重建",
  "style-tasks.json": "学我说话任务队列，跑完即弃",
  "generated": "App 运行期产物目录",
  "probe.log": "PoC 探针日志",
};

function isBak(name) {
  return /\.bak($|[-.])/i.test(name) || name.includes(".pre-v");
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

/** 只算账、不动手。给 dry-run 和报告用。 */
export function planMigration({ sourceDir, targetDir }) {
  const files = [];
  const dirs = [];
  const skipped = [];
  const unknown = [];

  for (const name of ASSET_FILES) {
    const src = join(sourceDir, name);
    if (existsSync(src)) files.push({ name, size: statSync(src).size });
  }

  for (const name of ASSET_DIRS) {
    const src = join(sourceDir, name);
    if (!existsSync(src)) continue;
    const list = walkFiles(src);
    let size = 0;
    for (const f of list) size += statSync(f).size;
    dirs.push({ name, fileCount: list.length, size });
  }

  if (existsSync(sourceDir)) {
    const known = new Set([...ASSET_FILES, ...ASSET_DIRS]);
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const name = entry.name;
      if (known.has(name)) continue;
      if (isBak(name)) skipped.push({ name, reason: "备份文件" });
      else if (SKIP_REASONS[name]) skipped.push({ name, reason: SKIP_REASONS[name] });
      else unknown.push(name);
    }
  }

  const totalBytes = files.reduce((a, b) => a + b.size, 0) + dirs.reduce((a, b) => a + b.size, 0);
  return { sourceDir, targetDir, files, dirs, skipped, unknown, totalBytes };
}

/** 真搬。dryRun 显式为 false 才动手。 */
export function runMigration({ sourceDir, targetDir, dryRun = true, onProgress } = {}) {
  const plan = planMigration({ sourceDir, targetDir });
  if (dryRun) return { ok: true, dryRun: true, plan, copiedFiles: 0, copiedBytes: 0, errors: [] };

  const errors = [];
  let copiedFiles = 0;
  let copiedBytes = 0;

  const report = (msg) => {
    if (typeof onProgress === "function") onProgress(msg);
  };

  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (e) {
    return { ok: false, dryRun: false, plan, copiedFiles: 0, copiedBytes: 0, errors: [e.message] };
  }

  for (const item of plan.files) {
    try {
      copyFileSync(join(sourceDir, item.name), join(targetDir, item.name));
      copiedFiles += 1;
      copiedBytes += item.size;
      report(`file ${item.name}`);
    } catch (e) {
      errors.push(`file ${item.name}: ${e.message}`);
    }
  }

  for (const item of plan.dirs) {
    const srcRoot = join(sourceDir, item.name);
    const dstRoot = join(targetDir, item.name);
    try {
      const list = walkFiles(srcRoot);
      let n = 0;
      for (const full of list) {
        const rel = full.slice(srcRoot.length + 1);
        const dst = join(dstRoot, rel);
        mkdirSync(join(dst, ".."), { recursive: true });
        copyFileSync(full, dst);
        n += 1;
        copiedBytes += statSync(full).size;
        if (n % 50 === 0) report(`dir ${item.name} ${n}/${list.length}`);
      }
      copiedFiles += n;
      report(`dir ${item.name} 完成 ${n} 个文件`);
    } catch (e) {
      errors.push(`dir ${item.name}: ${e.message}`);
    }
  }

  return { ok: errors.length === 0, dryRun: false, plan, copiedFiles, copiedBytes, errors };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
