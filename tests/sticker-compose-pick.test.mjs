// 表情包 · 快捷面板点图动作回归
// 保护：①两个页签点图都是「加入待发送区」，从图库挑图能直接发纯图，不用先收藏；
//      ②管理态的勾选圈本身可点，不必非得点图本体；
//      ③图库页有独立的收藏角标，收藏动作挪到角标上，点了才是收藏/移出收藏。
// 起因：用户报「从图库添加」里选完图发不出去（必须写点字才点得动发送），
// 查下来是那一页点图走的是收藏、根本没进待发送区；顺手把小圆点改成能点的。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 点图规则是普通脚本（不是 ES 模块），这里用 vm 加载后从全局取。
const PICK_SRC = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-compose-pick.js"), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(PICK_SRC, sandbox);
const { pickAction, favoriteAction } = sandbox.window.stickerComposePick;

const PANEL_JS = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-compose.js"), "utf8");
const PANEL_HTML = fs.readFileSync(path.join(ROOT, "ui", "sticker-compose.html"), "utf8");
const PANEL_CSS = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-compose.css"), "utf8");

test("平时点图是加入待发送区，只有管理态才是选中", () => {
  assert.equal(pickAction(false), "queue", "不在管理态时，点图就该进待发送区");
  assert.equal(pickAction(true), "manage", "管理态点图是选中做批量操作");
});

test("收藏角标按当前收藏状态决定加入还是移出", () => {
  assert.equal(favoriteAction(false), "pin");
  assert.equal(favoriteAction(true), "unpin");
});

test("面板点图不再偷偷去收藏（那正是发不出纯图的根因）", () => {
  assert.doesNotMatch(PANEL_JS, /mode === 'library' \? pin\(/, "图库页点图不能走收藏分支");
  assert.match(PANEL_JS, /toggle\(item\.id\)/, "点图要进待发送区");
  assert.match(PANEL_JS, /rules\.pickAction\(managing\)/, "点图动作要走抽出来的规则");
});

test("加进待发送区要说清楚：可以只发图片", () => {
  assert.match(PANEL_JS, /已加入待发送区，可以只发图片/);
});

test("管理态的勾选圈是真按钮，点了就选中（不用点图本体）", () => {
  assert.match(PANEL_JS, /mark\.addEventListener\('click'[\s\S]*?toggleManagePick\(item\.id\)/);
  assert.match(PANEL_CSS, /\.pick-mark\{[^}]*cursor:pointer/, "勾选圈得看起来能点");
  assert.match(PANEL_CSS, /\.pick-mark\{[^}]*padding:0/, "按钮化之后要把内边距压掉");
});

test("图库页另有收藏角标，收藏动作挪到它上面", () => {
  assert.match(PANEL_JS, /fav\.addEventListener\('click'[\s\S]*?pin\(item\.id/);
  assert.match(PANEL_CSS, /\.fav-mark\{/);
  assert.match(PANEL_CSS, /\.fav-mark\.on svg\{/);
});

test("页签改名叫「从图库挑图」，说的就是它现在做的事", () => {
  assert.match(PANEL_HTML, /id="library">从图库挑图</);
  assert.doesNotMatch(PANEL_HTML, /从图库添加/);
});

test("收藏角标画的是矢量心形，不是字符心（字符缩到 15px 会糊成一块饼）", () => {
  assert.match(PANEL_JS, /const ns = 'http:\/\/www\.w3\.org\/2000\/svg'/);
  assert.match(PANEL_JS, /createElementNS\(ns, 'svg'\)/);
  assert.doesNotMatch(PANEL_JS, /fav\.textContent = pinned \? '♥' : '♡'/, "不能再用字符心形");
  assert.match(PANEL_CSS, /\.fav-mark svg\{[^}]*fill:none/, "没收藏是白描边的空心");
  assert.match(PANEL_CSS, /\.fav-mark\.on svg\{[^}]*fill:#ff5c7a/, "已收藏是粉色实心");
});

test("规则脚本先加载，面板模块后加载（模块是 defer 的，普通脚本立即执行）", () => {
  assert.match(
    PANEL_HTML,
    /<script src="\.\/assets\/sticker-compose-pick\.js"><\/script><script src="\.\/assets\/sticker-compose-search\.js"><\/script><script type="module" src="\.\/assets\/sticker-compose\.js">/,
  );
});
