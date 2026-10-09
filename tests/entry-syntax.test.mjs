// 入口装载体检 — 2026-10-10 事故后补的
//
// 事故经过：一次性修复脚本在恢复 index.js 时漏掉了一行 `try {`，箭头函数里
// 剩下一个没有配对的 `catch`，整个文件的解析直接失败。结果宿主每次启动都报
// `plugin "biaoqingbao-app" failed to load: missing ) after argument list`，
// 应用一次都没起来（hook、工具、卡片全没有），界面上表现为「表情包彻底没了」。
//
// 这类故障有个特点：lib 层的测试全部照过（测试根本不 import 入口），
// 静态校验也不管语法，只有真的去装载才会炸。所以这里把「入口能不能被解析」
// 变成一个可自动跑的断言。
//
// 注意：`node --check file.js` 在 App 目录（没有 package.json）下是按 CommonJS
// 解析的，遇到 ESM 的 import 会给出误导性结论。这里统一复制成 .mjs 再检查，
// 强制走 ESM 解析。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const entry = join(appRoot, "index.js");

test("入口能被 ESM 解析：漏一个括号、一个 try，整个应用就装载不了", () => {
  const dir = mkdtempSync(join(tmpdir(), "bqb-entry-"));
  const copy = join(dir, "entry.mjs");
  try {
    copyFileSync(entry, copy);
    execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" });
  } catch (e) {
    const detail = e?.stderr?.toString()?.trim() || e?.message || String(e);
    assert.fail(`入口语法解析失败，宿主会拒绝装载整个应用：\n${detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("入口里每个相对 import 都指得到真实文件", () => {
  const src = readFileSync(entry, "utf8");
  const re = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
  const seen = new Set();
  const missing = [];
  for (const m of src.matchAll(re)) {
    const spec = m[1];
    if (!spec.startsWith(".") || seen.has(spec)) continue;
    seen.add(spec);
    if (!existsSync(resolve(dirname(entry), spec))) missing.push(spec);
  }
  assert.deepEqual(missing, [], `这些 import 指不到文件，装载时会模块解析失败：${missing.join(", ")}`);
});
