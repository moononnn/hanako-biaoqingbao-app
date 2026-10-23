// 表情包 · 自定义下拉组件回归
// 保护：图库页「全部分组 / 全部情绪 / 排序」三个下拉的选项文字要能完整显示。
// 起因：原生 select 被 display:none 藏起来后，包裹层只剩触发栏文字那么宽，
// 面板又锁死 left:0;right:0 跟触发栏等宽，选项全被省略号吃掉（「未分…」「大肥…」）。
// 修法：面板按内容宽度展开（width: max-content + min-width:100%），
// 右边放不下时 JS 改成右对齐，两边都不够才按可用宽度收窄。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DD_JS = fs.readFileSync(path.join(ROOT, "ui", "assets", "beautify-select.js"), "utf8");
const DD_CSS = fs.readFileSync(path.join(ROOT, "ui", "assets", "beautify-select.css"), "utf8");
const MANAGER = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-manager.js"), "utf8");
const PANEL_HTML = fs.readFileSync(path.join(ROOT, "ui", "panel.html"), "utf8");

test("下拉面板按内容宽度展开，不再锁死与触发栏等宽", () => {
  assert.match(DD_CSS, /\.dd-panel\s*\{[^}]*width: max-content;/s);
  assert.match(DD_CSS, /\.dd-panel\s*\{[^}]*min-width: 100%;/s);
  // 面板不再被 left:0; right:0 锁成触发栏宽度
  assert.doesNotMatch(DD_CSS, /\.dd-panel\s*\{[^}]*right: 0;/s);
});

test("下拉面板保留换肤样式与选中态（改宽度不能把样式改丢）", () => {
  assert.match(DD_CSS, /\.dd-opt\.on/);
  assert.match(DD_CSS, /\.dd-check/);
  assert.match(DD_CSS, /\.dd-opt-text\s*\{[^}]*text-overflow: ellipsis;/s);
  assert.match(DD_CSS, /::-webkit-scrollbar/);
});

test("面板挑边：右边放不下改右对齐，两边都不够才收窄", () => {
  assert.match(DD_JS, /function positionPanel\(\)/);
  assert.match(DD_JS, /panel\.scrollWidth/); // 量内容真正需要的宽度
  assert.match(DD_JS, /panel\.style\.right = "0px"/); // 翻到右对齐
  assert.match(DD_JS, /panel\.style\.width = w \+ "px"/); // 兜底收窄
  assert.match(DD_JS, /wrap\.classList\.add\("open"\);\s*positionPanel\(\);/s); // 展开后再量，量得到
});

test("组件原有能力不被改宽面板弄丢：change 事件链、值同步、动态选项、穿模防护", () => {
  assert.match(DD_JS, /sel\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)/);
  assert.match(DD_JS, /sel\.selectedIndex = Number\(opt\.dataset\.i\)/);
  assert.match(DD_JS, /wrap\._ddRefresh = renderPanel/);
  assert.match(DD_JS, /new MutationObserver/);
  assert.match(DD_JS, /findLiftTarget/);
  assert.match(DD_JS, /classList\.add\("dd-open-card"\)/);
  assert.match(DD_JS, /classList\.remove\("dd-open-card"\)/);
});

test("图库页三个下拉都换肤，分组下拉用的是同一个组件", () => {
  assert.match(MANAGER, /\['filter-emotion', 'filter-group', 'filter-sort'\]\.forEach/);
  assert.match(MANAGER, /window\.beautifySelect\(el\)/);
  assert.match(PANEL_HTML, /<select id="filter-group">/);
  assert.match(PANEL_HTML, /<select id="filter-emotion">/);
  assert.match(PANEL_HTML, /<select id="filter-sort"/);
});

test("分组下拉的选项带名称与数量，面板按内容宽度就能完整显示", () => {
  assert.match(MANAGER, /<option value="">全部分组<\/option>/);
  assert.match(MANAGER, /未分组（'/);
  assert.match(MANAGER, /escHtml\(group\.name\)/);
  assert.match(MANAGER, /group\.stickerCount \|\| 0/);
});
