// 表情包 · 输入面板深浅色回归
// 保护：这个面板的配色是自己硬编码的一整套，不吃宿主的主题样式表，所以深色得自己来。
// 宿主的明暗写在 iframe 地址的 hana-theme-appearance 上：页头内联脚本趁样式表之前先定首帧，
// 之后面板订阅 hana.theme 跟着换。CSS 只换配色变量，布局一条不动。
// 起因：宿主换了深色主题，面板还是那片浅绿，亮得扎眼。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_CSS = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-compose.css"), "utf8");
const PANEL_HTML = fs.readFileSync(path.join(ROOT, "ui", "sticker-compose.html"), "utf8");
const PANEL_JS = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-compose.js"), "utf8");

const LIGHT = PANEL_CSS.match(/:root\{([^}]*)\}/)?.[1] ?? "";
const DARK = PANEL_CSS.match(/:root\[data-appearance=dark\]\{([^}]*)\}/)?.[1] ?? "";

function token(palette, name) {
  return palette.match(new RegExp(`${name}:([^;}]+)`))?.[1]?.trim() ?? "";
}

// 粗略的相对亮度：只用来判「深色确实比浅色深」，不是配色计算。
function luminance(color) {
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return NaN;
  const channel = offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

test("首帧就把明暗定下来：页头内联脚本排在样式表前面", () => {
  const head = PANEL_HTML.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? "";
  const readAt = head.indexOf("hana-theme-appearance");
  const cssAt = head.indexOf("sticker-compose.css");
  assert.ok(readAt > 0, "页头要读地址上的 hana-theme-appearance");
  assert.ok(cssAt > readAt, "这段脚本要排在样式表前面，免得先亮一下再变暗");
  assert.match(head, /prefers-color-scheme: dark/, "宿主没说的时候跟系统偏好");
  assert.match(head, /dataset\.appearance/, "定下来的结果写在 html 的 data-appearance 上");
});

test("面板订阅宿主主题：切换主题不用重开面板", () => {
  assert.match(PANEL_JS, /hana\.theme\.getSnapshot\(\)/, "先取一次当前主题");
  assert.match(PANEL_JS, /hana\.theme\.subscribe\(/, "再订阅变化");
  assert.match(PANEL_JS, /dataset\.appearance/, "变化落到 data-appearance 上");
});

test("深色只换配色变量，布局一条不动", () => {
  assert.ok(DARK, "要有 :root[data-appearance=dark] 这一块");
  for (const name of ["--bg", "--surface", "--primary", "--soft", "--line", "--text", "--muted", "--ink-strong", "--accent", "--danger"]) {
    assert.ok(token(DARK, name), `深色要重定 ${name}`);
    assert.notEqual(token(DARK, name), token(LIGHT, name), `${name} 的深浅两套值不能一样`);
  }
  assert.match(DARK, /color-scheme:dark/, "原生控件和滚动条也要跟着变暗");
  for (const prop of ["padding", "height", "gap", "font-size", "display"]) {
    assert.doesNotMatch(DARK, new RegExp(`(^|;)${prop}:`), `${prop} 属于布局，不该出现在配色块里`);
  }
});

test("深色确实压暗了底、提亮了字", () => {
  const darkBg = luminance(token(DARK, "--bg"));
  const darkText = luminance(token(DARK, "--text"));
  const lightBg = luminance(token(LIGHT, "--bg"));
  assert.ok(Number.isFinite(darkBg), "深色背景要是 #rrggbb");
  assert.ok(darkBg < 0.12, `深色底得够暗，现在是 ${darkBg.toFixed(3)}`);
  assert.ok(darkText > 0.55, `深色下的字得够亮，现在是 ${darkText.toFixed(3)}`);
  assert.ok(darkBg < lightBg, "深色底该比浅色底暗");
});

test("颜色都走变量：规则里不再写死浅色十六进制", () => {
  const rules = PANEL_CSS
    .replace(/:root\{[^}]*\}/, "")
    .replace(/:root\[data-appearance=dark\]\{[^}]*\}/, "");
  for (const hex of ["#f7f9f4", "#fdfcfa", "#315c4b", "#e6f3ed", "#d5e5dd", "#34483d", "#73877a", "#5dae8e", "#a55b67", "#fdecee", "#e4c3c8", "#c9dfd3"]) {
    assert.ok(!rules.includes(hex), `${hex} 应该只出现在配色块里，规则里要用 var()`);
  }
});
