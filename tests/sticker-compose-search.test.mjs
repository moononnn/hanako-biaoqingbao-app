// 表情包 · 快捷面板搜索回归
// 保护：面板搜索要覆盖描述/语义描述/关键词/情绪/场景/分组名，
// 整串命中要排在单词命中前面。
// 起因：原来只搜 description + keywords，图一多就只能靠翻。
// 收藏分类（原先那版分组筛选胶囊）已经撤掉，搜索不再带分组筛选参数。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 搜索逻辑是普通脚本（不是 ES 模块），这里用 vm 加载后从全局取。
// 不能改成 ES 模块：面板脚本会被另一个测试塞进 vm 跑，vm 不认 import 语句。
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-compose-search.js"), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(SEARCH_SRC, sandbox);
const { searchableText, tokenize, matchScore, filterItems } = sandbox.window.stickerComposeSearch;

const PANEL_JS = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-compose.js"), "utf8");
const PANEL_HTML = fs.readFileSync(path.join(ROOT, "ui", "sticker-compose.html"), "utf8");
const PANEL_CSS = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-compose.css"), "utf8");
const SERVER_JS = fs.readFileSync(path.join(ROOT, "lib", "sticker-input-panel.js"), "utf8");

const 猫 = {
  id: "a",
  description: "大肥鱼一脸嫌弃",
  keywords: ["大肥鱼", "猫meme", "已读不回"],
  emotion: ["傲娇", "嫌弃"],
  scene: ["吐槽", "催回复"],
  semantic_description: "适合吐槽暗恋对象已读不回，又气又爱的纠结心情",
  groups: [{ id: "g1", name: "大肥鱼", terms: ["大肥鱼", "胖鱼"] }],
};
const 狗 = {
  id: "b",
  description: "橘猫伸爪子装无辜",
  keywords: ["橘猫", "呆萌"],
  emotion: ["呆萌"],
  scene: ["卖萌"],
  semantic_description: "适合犯错后装傻认错时发",
  groups: [{ id: "g2", name: "猫猫狗狗", terms: ["猫猫狗狗"] }],
};
const 无组 = { id: "c", description: "没分组的图", keywords: ["散图"], emotion: [], scene: [], semantic_description: "", groups: [] };

test("搜索索引把该搜的字段都收进去（描述/语义描述/关键词/情绪/场景/分组名+别名）", () => {
  const text = searchableText(猫);
  for (const word of ["大肥鱼", "猫meme", "已读不回", "傲娇", "嫌弃", "吐槽", "催回复", "又气又爱", "胖鱼"]) {
    assert.ok(text.includes(word.toLowerCase()), `索引里应该有「${word}」`);
  }
});

test("查询词按空白切开，空查询不产生词", () => {
  // vm 里的数组跟主 realm 的 Array 不是同一个原型，断言前先拷出来
  assert.deepEqual(Array.from(tokenize("猫  狗")), ["猫", "狗"]);
  assert.deepEqual(Array.from(tokenize("   ")), []);
  assert.deepEqual(Array.from(tokenize("")), []);
});

test("整串命中记 2 分，只命中一个词记 1 分，没命中记 0 分", () => {
  const text = searchableText(猫);
  assert.equal(matchScore(text, "已读不回", tokenize("已读不回")), 2);
  assert.equal(matchScore(text, "已读 不回", tokenize("已读 不回")), 1);
  assert.equal(matchScore(text, "zzz", tokenize("zzz")), 0);
  assert.equal(matchScore(text, "", tokenize("")), 0);
});

test("筛选：空格分词按任一命中算，搜得到优先", () => {
  const items = [猫, 狗, 无组];
  const hit = filterItems(items, { query: "猫 已读不回" });
  assert.ok(hit.some(item => item.id === "a"), "含「已读不回」的猫要被搜出来");
});

test("整串命中的排在单词命中的前面", () => {
  // 多词查询才有区别：整串（两个词连着出现）记 2 分，只命中其中一个词记 1 分。
  const 整串 = { id: 'x', description: '猫 已读不回', keywords: [], emotion: [], scene: [], semantic_description: '', groups: [] };
  const 半截 = { id: 'y', description: '猫', keywords: [], emotion: [], scene: [], semantic_description: '', groups: [] };
  const hit = filterItems([半截, 整串], { query: '猫 已读不回' });
  assert.deepEqual(Array.from(hit, i => i.id), ['x', 'y'], '整串命中的排前面');
});

test("服务端把搜索要用的字段一起给前端（情绪/场景/语义描述/分组名+别名）", () => {
  assert.match(SERVER_JS, /emotion: Array\.isArray\(s\.tags\?\.emotion\)/);
  assert.match(SERVER_JS, /scene: Array\.isArray\(s\.tags\?\.scene\)/);
  assert.match(SERVER_JS, /semantic_description: String\(s\.semantic_description \|\| ''\)/);
  assert.match(SERVER_JS, /getRecognitionGroupTerms/);
  assert.match(SERVER_JS, /getStickerGroupIds/);
});

test("面板接上搜索模块", () => {
  assert.match(PANEL_JS, /function searchApi\(\)/);
  assert.match(PANEL_JS, /api\.filterItems\(source, \{ query: \$\('search'\)\.value \}\)/);
  assert.match(PANEL_JS, /没有匹配的表情包/);
});

test("撤掉的分组筛选胶囊不能再回来", () => {
  assert.doesNotMatch(PANEL_HTML, /id="chips"/);
  assert.doesNotMatch(PANEL_JS, /groupFilter/);
  assert.doesNotMatch(PANEL_JS, /renderChips/);
  assert.doesNotMatch(PANEL_CSS, /\.chips\{/);
});

test("面板页面有分类 tab 行，样式里有胶囊 tab", () => {
  assert.match(PANEL_HTML, /id="cats" class="cats"/);
  assert.match(PANEL_CSS, /\.cats\{[^}]*overflow-x:auto/);
  assert.match(PANEL_CSS, /\.cats \.cat\[aria-selected=true\]/);
  // 搜索脚本是普通脚本，必须在面板模块之前加载（模块是 defer 的，普通脚本立即执行）
  assert.match(PANEL_HTML, /<script src="\.\/assets\/sticker-compose-search\.js"><\/script><script type="module" src="\.\/assets\/sticker-compose\.js">/);
});
