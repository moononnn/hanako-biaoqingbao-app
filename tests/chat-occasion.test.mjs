// tests/chat-occasion.test.mjs
// v0.8.4 - 「跟小花聊聊」的建议卡支持限用场合。
//
// 为什么单独钉：这条链有四段，掉一段就静默失效——
//   1) 系统提示里模型得知道有这个字段，否则它永远想不起来填
//   2) suggestion 解析得接受 occasion，且区分「没给」和「给了空数组」
//   3) 确认接口的白名单得收它，并且只收词表内的值
//   4) 前端回查落盘得从顶层读，不能从 tags 里翻
// 4) 最容易漏：从 tags 读会永远拿到空，于是「其实改成功了」被报成失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_JS = fs.readFileSync(path.join(ROOT, "server", "api.js"), "utf8");
const CARD_VIEW = fs.readFileSync(path.join(ROOT, "ui", "assets", "message-card-view.js"), "utf8");
const MANAGER_JS = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-manager.js"), "utf8");
const PANEL_HTML = fs.readFileSync(path.join(ROOT, "ui", "panel.html"), "utf8");

function block(startPattern, endPattern) {
  const start = API_JS.search(startPattern);
  if (start < 0) return "";
  const rest = API_JS.slice(start);
  const end = rest.search(endPattern);
  return end < 0 ? rest : rest.slice(0, end);
}

test("系统提示里告诉模型有 occasion 这个字段", () => {
  assert.match(API_JS, /"occasion":\["新场合"\]/, "suggestion 模板没带 occasion");
  assert.match(API_JS, /- occasion: 限用场合/, "字段说明缺 occasion");
  // 当前标签也要给模型看，否则它不知道这张现在锁没锁
  assert.match(API_JS, /'限用场合：'/, "当前标签段没带场合锁");
});

test("suggestion 解析区分「没给」和「给了空数组」", () => {
  const blockText = block(/suggestion = \{/, /\};\s*\n\s*\}/);
  assert.ok(blockText, "找不到 suggestion 解析块");
  assert.match(blockText, /hasOwnProperty\.call\(parsed, 'occasion'\)/, "没区分没给和给空");
  assert.match(blockText, /occasionSet\(/, "occasion 没走词表归一");
});

test("确认接口的白名单收 occasion，且只存词表内的值", () => {
  assert.match(API_JS, /if \(new_tags\.occasion !== undefined\)/, "缺 occasion 白名单校验");
  const blockText = block(/if \(new_tags\.occasion !== undefined\)/, /\n      \}/);
  assert.match(blockText, /Array\.isArray\(new_tags\.occasion\)/, "没校验数组类型");
  assert.match(blockText, /occasionSet\(/, "没归一，模型乱写的词会进库");
});

test("写库时空数组要把字段摘掉，不留空壳", () => {
  const blockText = block(/if \(cleanTags\.occasion !== undefined\)/, /\n      \}/);
  assert.ok(blockText, "找不到写库分支");
  assert.match(blockText, /delete sticker\.occasion/, "空值没摘字段");
});

test("幂等比对认 occasion，否则带锁的建议重试永远对不上", () => {
  assert.match(API_JS, /CHAT_PATCH_FIELDS = \[[^\]]*'occasion'/, "patch 字段表缺 occasion");
  const matchBlock = block(/function chatTagPatchMatchesSticker/, /\n  \}\n/);
  assert.match(matchBlock, /occasion: sticker\?\.occasion \|\| \[\]/, "当前值没归一成数组");
});

test("前端建议卡会渲染限用场合", () => {
  assert.match(CARD_VIEW, /const CHAT_FIELDS = \[[^\]]*'occasion'/, "CHAT_FIELDS 缺 occasion");
  assert.match(CARD_VIEW, /occasion: '限用场合'/, "缺中文字段名");
  // 回查落盘必须从顶层读，从 tags 读永远拿到空
  assert.match(CARD_VIEW, /if \(field === 'occasion'\) return Array\.isArray\(sticker\.occasion\)/, "回查没从顶层读 occasion");
});

test("回查与预览也认 occasion", () => {
  assert.match(MANAGER_JS, /suggestion\.occasion !== undefined/, "回查函数没比对 occasion");
  assert.match(MANAGER_JS, /chat-tag-occasion/, "聊天窗左侧标签块没渲染场合");
  assert.match(PANEL_HTML, /id="chat-tag-occasion"/, "panel.html 缺场合标签块");
  assert.match(MANAGER_JS, /var newOccasion/, "修改预览没显示场合");
});