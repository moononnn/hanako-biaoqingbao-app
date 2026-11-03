// 表情包 · 输入面板顶栏与宿主关闭键的排版回归
// 保护：新版宿主在输入面板右上角自绘一颗关闭叉叉（28px 见方、离边 4px，压在 iframe 上面），
// 面板这边就不再自绘收起按钮；顶栏要跟叉叉排在同一行、右边让出它的位置，
// 别让「刷新」和计数被遮住，也别一高一低看着别扭。
// 起因：宿主加了叉叉之后，顶栏最右边那个按钮既落在它的覆盖范围里，又比它低 8px。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_HTML = fs.readFileSync(path.join(ROOT, "ui", "sticker-compose.html"), "utf8");
const PANEL_CSS = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-compose.css"), "utf8");
const HEADER_HTML = PANEL_HTML.match(/<header>([\s\S]*?)<\/header>/)?.[1] ?? "";

// 宿主那颗叉叉：28px 见方 + 右边 4px 贴边 = 压住面板右侧 32px，顶边离面板 4px。
const HOST_CLOSE_SIZE = 28;
const HOST_CLOSE_INSET = 4;
const HOST_CLOSE_BAND = HOST_CLOSE_SIZE + HOST_CLOSE_INSET;
// 除了让开，还要留一点视觉余量，不然按钮贴着叉叉一样难看。
const MIN_CLEARANCE = HOST_CLOSE_BAND + 8;

function rules(selector) {
  return [...PANEL_CSS.matchAll(new RegExp(`(?<![-\\w.])${selector}\\{[^}]*\\}`, "g"))].map(hit => hit[0]);
}

function rule(selector) {
  return rules(selector)[0] ?? "";
}

// 同一选择器可能分几段写（先 padding 简写、后面再补 padding-top），取最后一个带该属性的。
function lastWith(selector, prop) {
  return rules(selector).reverse().find(block => block.includes(`${prop}:`)) ?? "";
}

function px(block, prop) {
  const hit = block.match(new RegExp(`${prop}:(\\d+)px`));
  return hit ? Number(hit[1]) : NaN;
}

// main 用 padding 简写（12px 16px），只取右边那个值。
function mainRightInset() {
  const shorthand = rule("main").match(/padding:([^;}]+)/)?.[1]?.trim();
  if (!shorthand) return 0;
  const parts = shorthand.split(/\s+/).map(value => Number(value.replace(/px$/, "")));
  const right = parts.length >= 2 ? parts[1] : parts[0];
  return Number.isFinite(right) ? right : 0;
}

test("顶栏不自绘收起：关闭交给宿主右上角那颗叉叉", () => {
  assert.ok(HEADER_HTML.includes('id="refresh"'), "顶栏还在，刷新按钮也还在原位");
  assert.doesNotMatch(HEADER_HTML, /收起|关闭|✕|×/, "顶栏不该再出现自绘的收起/关闭控件");
  assert.doesNotMatch(rule("header"), /position:absolute/, "标题行不该拿绝对定位去抢右上角");
});

test("顶栏右侧给宿主叉叉让位：header 的右内边距加上 main 的右内边距够宽", () => {
  const headerRight = px(rule("header"), "padding-right");
  assert.ok(headerRight > 0, "标题行要单独给右侧留白，叉叉就盖在这里");
  const total = headerRight + mainRightInset();
  assert.ok(total >= MIN_CLEARANCE, `顶栏右侧一共要让出 ${MIN_CLEARANCE}px，现在只有 ${total}px`);
});

test("顶栏跟叉叉同一水平线：上内边距和行高都对上 28px 的叉叉", () => {
  assert.equal(px(lastWith("main", "padding-top"), "padding-top"), HOST_CLOSE_INSET, "顶栏要从离边 4px 起，才跟叉叉顶边齐平");
  assert.equal(px(rule("header"), "height"), HOST_CLOSE_SIZE, "标题行定高 28px，正好跟叉叉一样高");
  assert.equal(px(rule("#refresh"), "height"), HOST_CLOSE_SIZE, "刷新按钮也要 28px 高");
});

test("刷新是个看得见的按钮，不是一行光秃秃的字", () => {
  const refresh = rule("#refresh");
  assert.match(refresh, /border:1px solid var\(--line\)/, "要有描边");
  assert.match(refresh, /background:var\(--surface\)/, "要有底色");
  assert.match(refresh, /border-radius:8px/, "圆角跟面板里其它按钮一个调子");
});

test("只有顶栏这一行动让位和对齐：下面几行不受影响，搜索框还用满宽度", () => {
  for (const selector of ["nav", "#gallery", ".compose"]) {
    assert.doesNotMatch(rule(selector), /padding-right/, `${selector} 在叉叉下面，不用跟着缩`);
  }
  assert.match(PANEL_CSS, /@media\(max-width:420px\)\{main\{padding:8px/, "窄屏 main 的内边距还得在，让位量按它算");
});
