// 表情包 · 收藏分类回归
// 保护：我的收藏里自己分的类——新建/改名/删除、一张图进多个分类、
// 移出收藏时分类跟着清、分类文件坏了要显式报错（不能当空库把用户的分类抹掉）。
// 起因：2026-10-21 作者提出「收藏里能自己分类」，参考茶话会那套。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  emptyCategoryStore, readCategoryStore, writeCategoryStore, isCategoryStoreReadable, getCategoryStoreError,
  createCategory, renameCategory, deleteCategory, setStickerCategories, removeStickerFromCategories,
  mergeStickerCategories, removeStickerFromCategory,
  categoryRows, categoriesOfSticker, categoryStorePath, MAX_CATEGORY_NAME_LENGTH,
} from "../lib/favorite-categories.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_HTML = fs.readFileSync(path.join(ROOT, "ui", "sticker-compose.html"), "utf8");
const PANEL_CSS = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-compose.css"), "utf8");
const PANEL_JS = fs.readFileSync(path.join(ROOT, "ui", "assets", "sticker-compose.js"), "utf8");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bqb-cats-"));
}

test("新建分类：名字去空白、重名要拦、编号自己生成", () => {
  const store = emptyCategoryStore();
  const created = createCategory(store, "  摸鱼  ");
  assert.equal(created.ok, true);
  assert.equal(created.category.name, "摸鱼");
  assert.ok(created.category.id.startsWith("cat_"));
  const again = createCategory(created.store, "摸鱼");
  assert.equal(again.ok, false);
  assert.match(again.error, /已经有叫/);
  const empty = createCategory(store, "   ");
  assert.equal(empty.ok, false);
});

test("改名：改完生效，同名和空名都要拦住", () => {
  let store = createCategory(emptyCategoryStore(), "摸鱼").store;
  store = createCategory(store, "无语").store;
  const target = store.categories[0].id;
  const renamed = renameCategory(store, target, "  上班摸鱼  ");
  assert.equal(renamed.ok, true);
  assert.equal(renamed.store.categories[0].name, "上班摸鱼");
  const same = renameCategory(store, store.categories[1].id, "摸鱼");
  assert.equal(same.ok, false, "跟别的分类重名要拦");
  const blank = renameCategory(store, target, "  ");
  assert.equal(blank.ok, false);
  const missing = renameCategory(store, "cat_没有这个", "随便");
  assert.equal(missing.ok, false);
});

test("删分类：分类没了，里面的图不被牵连（只是回到「全部收藏」）", () => {
  let store = createCategory(emptyCategoryStore(), "摸鱼").store;
  store = setStickerCategories(store, "stk_1", [store.categories[0].id]).store;
  const removed = deleteCategory(store, store.categories[0].id);
  assert.equal(removed.ok, true);
  assert.equal(removed.store.categories.length, 0);
  const missing = deleteCategory(removed.store, store.categories[0].id);
  assert.equal(missing.ok, false, "已经删过的分类不能再删一次");
});

test("一张图可以同时进多个分类，移出一个分类不动别的", () => {
  let store = createCategory(emptyCategoryStore(), "摸鱼").store;
  store = createCategory(store, "无语").store;
  const [a, b] = store.categories.map(category => category.id);
  const set = setStickerCategories(store, "stk_1", [a, b]);
  assert.equal(set.ok, true);
  assert.deepEqual(categoriesOfSticker(set.store.categories, "stk_1").sort(), [a, b].sort());
  const onlyOne = setStickerCategories(set.store, "stk_1", [a]);
  assert.deepEqual(categoriesOfSticker(onlyOne.store.categories, "stk_1"), [a]);
});

test("不存在的分类编号要被忽略，不能凭空造出分类", () => {
  const store = createCategory(emptyCategoryStore(), "摸鱼").store;
  const set = setStickerCategories(store, "stk_1", ["cat_根本没有"]);
  assert.equal(set.ok, true);
  assert.equal(set.store.categories.length, 1);
  assert.deepEqual(categoriesOfSticker(set.store.categories, "stk_1"), []);
});

test("移出收藏时，分类里要跟着清掉（分类是收藏的子集）", () => {
  let store = createCategory(emptyCategoryStore(), "摸鱼").store;
  store = setStickerCategories(store, "stk_1", [store.categories[0].id]).store;
  const cleaned = removeStickerFromCategories(store, "stk_1");
  assert.deepEqual(categoriesOfSticker(cleaned.store.categories, "stk_1"), []);
});

test("读出来时按收藏过滤：不在收藏里的图不算这个分类的成员", () => {
  let store = createCategory(emptyCategoryStore(), "摸鱼").store;
  store = setStickerCategories(store, "stk_1", [store.categories[0].id]).store;
  store = setStickerCategories(store, "stk_2", [store.categories[0].id]).store;
  const rows = categoryRows(store, ["stk_1"]);
  assert.deepEqual(rows[0].stickerIds, ["stk_1"], "stk_2 不在收藏里，不该出现");
});

test("存盘再读回来，分类还在", () => {
  const dir = tempDir();
  const created = createCategory(emptyCategoryStore(), "摸鱼");
  writeCategoryStore(created.store, dir);
  const back = readCategoryStore(dir);
  assert.equal(isCategoryStoreReadable(back), true);
  assert.equal(back.categories.length, 1);
  assert.equal(back.categories[0].name, "摸鱼");
});

test("分类文件坏了要显式报错，不能当空库把用户的分类抹掉", () => {
  const dir = tempDir();
  fs.writeFileSync(categoryStorePath(dir), "{ 这不是 JSON", "utf8");
  const broken = readCategoryStore(dir);
  assert.equal(isCategoryStoreReadable(broken), false);
  assert.ok(getCategoryStoreError(broken).length > 0);
});

test("还没有分类文件属于正常空库", () => {
  const dir = tempDir();
  const store = readCategoryStore(dir);
  assert.equal(isCategoryStoreReadable(store), true);
  assert.equal(store.categories.length, 0);
});

test("分类名太长会被截断，不至于把界面撑破", () => {
  const long = "a".repeat(MAX_CATEGORY_NAME_LENGTH + 30);
  const created = createCategory(emptyCategoryStore(), long);
  assert.equal(created.category.name.length, MAX_CATEGORY_NAME_LENGTH);
});

test("弹层文案用「创建/保存」，不用「建好/改好」这种怪词", () => {
  assert.match(PANEL_HTML, /id="rename-category-save" class="primary">创建<\/button>/);
  assert.match(PANEL_HTML, /id="category-new-add" type="button">创建<\/button>/);
  assert.doesNotMatch(PANEL_HTML, /建好|改好/);
  // 改名时按钮文案换成「保存」，新建时是「创建」
  assert.match(PANEL_JS, /action === 'create' \? '创建' : '保存'/);
  // 新建/改名各有一句人话说明，别让人对着空白框发呆
  assert.match(PANEL_HTML, /id="rename-category-hint"/);
  assert.match(PANEL_HTML, /placeholder="分类名字"/);
});

test("弹层里的勾选框不能被全局 input 样式撑成一条杠", () => {
  assert.match(PANEL_CSS, /\.category-row input\[type=checkbox\]\{[^}]*width:16px;[^}]*flex:none;/);
  assert.match(PANEL_CSS, /\.category-row input\[type=checkbox\]\{[^}]*accent-color:var\(--primary\)/);
  assert.match(PANEL_CSS, /\.sheet input:focus-visible\{[^}]*box-shadow/);
});

test("「改名」「删分类」不常驻：只有管理态里才露出来", () => {
  assert.match(PANEL_JS, /if \(selected && managing\) \{/);
  // 平常那行只有：分类 tab、＋新建分类、管理；管理态的出口在底部操作条上
  assert.match(PANEL_JS, /if \(!managing\) \{[\s\S]*?manage\.textContent = '管理'/);
  assert.doesNotMatch(PANEL_JS, /remove\.textContent = categoryArmedDelete === category\.id \? '再点一次' : '删除'/);
});

test("管理态：图角上是勾选圈（多选），移出分类走批量接口", () => {
  assert.match(PANEL_JS, /if \(managing\) \{/);
  assert.match(PANEL_JS, /mark\.className = on \? 'pick-mark on' : 'pick-mark'/);
  assert.match(PANEL_JS, /api\('category-remove-batch', \{ stickerIds: ids, categoryId: categoryFilter \}\)/);
  // 移出只动这个分类，别的分类和原图、收藏都不动
  assert.match(PANEL_CSS, /\.pick-mark\{/);
  assert.doesNotMatch(PANEL_JS, /\.kill/);
});

test("管理态对整个收藏页生效：多选 + 批量操作条", () => {
  // 入口不再要求先选具体分类
  assert.doesNotMatch(PANEL_JS, /先点一个具体的分类，再管里面的图/);
  assert.match(PANEL_JS, /managing = true; selectedManage = new Set\(\);/);
  // 多选：点图切换选中，图角上出勾选圈
  assert.match(PANEL_JS, /function toggleManagePick\(id\)/);
  assert.match(PANEL_JS, /mark\.className = on \? 'pick-mark on' : 'pick-mark'/);
  // 底部操作条：已选多少、全选、放进分类、移出收藏、完成
  assert.match(PANEL_HTML, /id="manage-bar" class="manage-bar"/);
  assert.match(PANEL_JS, /已选 \$\{selectedManage\.size\} 张/);
  assert.match(PANEL_JS, /textContent = allPicked \? '全不选' : '全选'/);
  assert.match(PANEL_JS, /textContent = '放进分类…'/);
  assert.match(PANEL_JS, /textContent = '移出收藏'/);
  // 管理态时收起发送区，避免误发
  assert.match(PANEL_JS, /if \(compose\) compose\.hidden = true;/);
  assert.match(PANEL_CSS, /\.manage-bar\{/);
  assert.match(PANEL_CSS, /\.pick-mark\.on\{/);
});

test("批量：多张一起放进分类是「合并」，不是替换", () => {
  let store = createCategory(emptyCategoryStore(), '摸鱼').store;
  store = createCategory(store, '打工人').store;
  const [moyu, dagong] = store.categories.map(category => category.id);
  store = setStickerCategories(store, 'stk_1', [moyu]).store;
  const merged = mergeStickerCategories(store, ['stk_1', 'stk_2'], [dagong]);
  assert.equal(merged.ok, true);
  // stk_1 原来的摸鱼还在，同时加进打工人
  assert.deepEqual(categoriesOfSticker(merged.store.categories, 'stk_1').sort(), [dagong, moyu].sort());
  assert.deepEqual(categoriesOfSticker(merged.store.categories, 'stk_2'), [dagong]);
  const noTarget = mergeStickerCategories(store, [], [dagong]);
  assert.equal(noTarget.ok, false);
  const noCategory = mergeStickerCategories(store, ['stk_2'], []);
  assert.equal(noCategory.ok, false);
});

test("批量：把好几张从某个分类里踢出去（只动这个分类）", () => {
  let store = createCategory(emptyCategoryStore(), '摸鱼').store;
  const moyu = store.categories[0].id;
  store = setStickerCategories(store, 'stk_1', [moyu]).store;
  store = setStickerCategories(store, 'stk_2', [moyu]).store;
  store = setStickerCategories(store, 'stk_3', [moyu]).store;
  const removed = removeStickerFromCategory(store, ['stk_1', 'stk_2'], moyu);
  assert.equal(removed.ok, true);
  assert.deepEqual(categoriesOfSticker(removed.store.categories, 'stk_1'), []);
  assert.deepEqual(categoriesOfSticker(removed.store.categories, 'stk_3'), [moyu], '没选中的那张还在分类里');
});

test("批量接口一次落盘，不是一张一张写文件", () => {
  const server = fs.readFileSync(path.join(ROOT, "lib", "sticker-input-panel.js"), "utf8");
  assert.match(server, /\/api\/sticker-compose\/category-set-batch/);
  assert.match(server, /\/api\/sticker-compose\/category-remove-batch/);
  assert.match(server, /\/api\/sticker-compose\/unpin-batch/);
  // 批量移出收藏走 ball.js 的批量接口（一次写盘）
  assert.match(server, /setBallPinnedMany\(sdk, ids, false\)/);
  const ball = fs.readFileSync(path.join(ROOT, "lib", "ball.js"), "utf8");
  assert.match(ball, /export function setBallPinnedMany\(ctx, stickerIds, pinned\)/);
});

test("批量弹层标题要说清是几张，单张和批量不是一回事", () => {
  assert.match(PANEL_JS, /categoryMode = 'batch'; categoryBatchIds = ids; categoryTarget = '';/);
  assert.match(PANEL_JS, /textContent = `把 \$\{ids\.length\} 张放进分类`/);
  assert.match(PANEL_JS, /api\('category-set-batch', \{ stickerIds: categoryBatchIds, categoryIds: \[\.\.\.categoryDraft\] \}\)/);
  assert.match(PANEL_HTML, /id="category-dialog-title"/);
});

test("纸飞机（球）也接同一套分类：/pinned 带分类，批量走代理路由", () => {
  const ball = fs.readFileSync(path.join(ROOT, "lib", "ball.js"), "utf8");
  // /pinned 把分类一起给球
  assert.match(ball, /categories: catRows\.map\(row => \(\{ id: row\.id, name: row\.name, count: row\.stickerIds\.length \}\)\)/);
  assert.match(ball, /categoryIds: categoriesOfSticker\(catRows, id\)/);
  // 球用的代理路由
  for (const route of ['/category-create', '/category-rename', '/category-delete', '/category-set-batch', '/category-remove-batch', '/unpin-batch']) {
    assert.ok(ball.includes(`ipc.route('POST', '${route}'`), `球要能用 ${route}`);
  }
  assert.match(ball, /setBallPinnedMany\(runtimeState\.ctx, ids, false\)/);
});

test("球的界面：分类行、多选管理、分类弹层都在", () => {
  const py = fs.readFileSync(path.join(ROOT, "python", "ball_app.py"), "utf8");
  assert.match(py, /class CategoryPicker\(QFrame\)/);
  assert.match(py, /def _build_category_bar\(self\)/);
  assert.match(py, /def _build_manage_bar\(self\)/);
  assert.match(py, /def _toggle_manage\(self\)/);
  assert.match(py, /def _manage_batch_category\(self\)/);
  assert.match(py, /def _manage_batch_unpin\(self\)/);
  assert.match(py, /def _manage_batch_remove_category\(self\)/);
  // 管理态点图是勾选，不是选待发送
  assert.match(py, /if self\._managing:\s*\n\s*# 管理态：点击是勾选，不是选待发送/);
  assert.match(py, /def set_managed\(self, managed\)/);
});