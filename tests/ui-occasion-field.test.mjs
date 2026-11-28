// tests/ui-occasion-field.test.mjs
// v0.8.3 - 图库编辑弹窗的「限用场合」字段。
//
// 为什么值得钉住：场地门禁的数据只有两条写入口（编辑弹窗、工具/接口）。
// 弹窗这一条一旦掉了字段，用户改一次标签就会把已有的锁冲成空，
// 而且界面上看不出任何异常——图会悄悄变回「任何场合都能用」。
//
// 这里守四件事：
//   1) 弹窗里有输入框和重判按钮
//   2) 打开弹窗时把现有 occasion 填进去
//   3) 保存时把 occasion 一起发出去
//   4) 卡片上能看见「限 xx」标记，不用点进去才知道
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_HTML = fs.readFileSync(path.join(ROOT, "ui", "panel.html"), "utf8");
const MANAGER_JS = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-manager.js"), "utf8");
const API_JS = fs.readFileSync(path.join(ROOT, "server", "api.js"), "utf8");

test("编辑弹窗里有场合输入框和重判按钮", () => {
  assert.match(PANEL_HTML, /id="edit-occasion"/, "缺 input#edit-occasion");
  assert.match(PANEL_HTML, /id="editor-occasion-infer-btn"/, "缺「按标签重判」按钮");
  // 提示文案要说清留空是什么含义，否则用户会以为空着等于「还没填」
  assert.match(PANEL_HTML, /留空=不限制|留空＝不限制/);
});

test("打开弹窗时把已有的锁填进输入框", () => {
  const block = MANAGER_JS.match(/function openEditor\(sticker\)\{?[\s\S]*?\n  \}/)?.[0]
    || MANAGER_JS.match(/function openEditor\(sticker\) \{[\s\S]*?\n  \}/)?.[0]
    || "";
  assert.ok(block, "找不到 openEditor");
  assert.match(block, /edit-occasion/, "openEditor 没填场合字段");
  assert.match(block, /sticker\.occasion/, "openEditor 没读 sticker.occasion");
});

test("保存时把场合一起发出去", () => {
  const block = MANAGER_JS.match(/async function saveEdit\(\)[\s\S]*?\n  \}/)?.[0] || "";
  assert.ok(block, "找不到 saveEdit");
  assert.match(block, /occasion:\s*\$\('edit-occasion'\)\.value/, "保存请求没带 occasion");
});

test("后端有重判接口，且只算不写", () => {
  assert.match(API_JS, /action === 'infer_occasion'/, "缺 infer_occasion 分支");
  const block = API_JS.match(/if \(action === 'infer_occasion'\)[\s\S]*?\n    \}/)?.[0] || "";
  assert.ok(block, "找不到 infer_occasion 分支体");
  assert.match(block, /inferOccasions\(/, "没调推断函数");
  // 只算不写：写库交给用户点保存，避免「只重判了一部分还写进去了」
  assert.ok(!/writeMeta\(/.test(block), "重判接口不该直接写库");
});

test("图库卡片能看见限用标记", () => {
  assert.match(MANAGER_JS, /tag occasion/, "卡片没渲染场合标记");
  assert.match(PANEL_HTML, /\.tag\.occasion\{/, "缺 .tag.occasion 样式");
});

test("批量识图 toast 只播最近的任务，不重播历史失败", () => {
  // 起因：10-04 那次「2 张全失败」在 11-28 还被页面加载时重播，看着像刚跑完的
  assert.match(MANAGER_JS, /BATCH_NOTIFY_WINDOW_MS/, "缺提醒时间窗常量");
  const block = MANAGER_JS.match(/async function checkBatchTasks\(\)[\s\S]*?\n  \}/)?.[0] || "";
  assert.ok(block, "找不到 checkBatchTasks");
  assert.match(block, /Date\.now\(\) - createdTs > BATCH_NOTIFY_WINDOW_MS/, "没按时间窗过滤");
});