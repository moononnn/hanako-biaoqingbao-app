// tests/occasion-preserve.test.mjs
// v0.8.0 - 重识不许把已有的场合锁静默摘掉。
//
// 事故现场（2026-11-28 发布前独立审包）：单张识图和批量自动应用都把「空数组」
// 当成「这次重新判过、没有场合」，于是 delete 掉旧的 occasion。但识图 JSON 模板里
// occasion 字段恒存在，归一化后永远是数组，模型拿不准时给的就是空数组——等于
// 「模型不确定」被当成「这张图不属于任何场合」。
//
// 后果正好是这版要修的回归：用户手动设的「限 早安」，点一次识图就没了，这张图
// 重新在任意场合出场，而界面上那个标记还在（本地状态没刷新）。
//
// 这里守的规则：
//   1) 识图/推断链路的空数组 = 这轮没判出来，保留旧锁
//   2) 非空值照常覆写（用户重识就是想改）
//   3) 取消限制只走用户显式操作，不在这两条链路上
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyItemsToMeta } from '../lib/batch-apply.js';

// 不带任何场合线索的一张普通图：标签里没有早安晚安，描述里也没有「字样」这类转述。
const plain = (extra = {}) => ({
  id: 'stk_t1',
  description: '棕发少女戴猫耳帽闭眼甜笑',
  semantic_description: '适合卖萌撒娇时发',
  tags: { emotion: ['甜美'], scene: ['撒娇'], keywords: ['猫耳帽', '甜笑'] },
  ...extra,
});

test('重识时场景锁没判出来，旧锁保留', () => {
  const meta = [plain({ occasion: ['早安'] })];
  applyItemsToMeta(meta, [{ id: 'stk_t1', occasion: [] }]);
  assert.deepEqual(meta[0].occasion, ['早安'], '空数组不该被当成取消限制');
});

test('重识给了明确的场合，照常覆写', () => {
  const meta = [plain({ occasion: ['早安'] })];
  applyItemsToMeta(meta, [{ id: 'stk_t1', occasion: ['晚安'] }]);
  assert.deepEqual(meta[0].occasion, ['晚安']);
});

test('没锁的图重识仍判不出来，也不会凭空多出锁', () => {
  const meta = [plain()];
  applyItemsToMeta(meta, [{ id: 'stk_t1', occasion: [] }]);
  assert.equal(meta[0].occasion, undefined);
});

test('别的字段空值走同样的口径，不覆盖旧内容', () => {
  const meta = [plain({ occasion: ['晚安'] })];
  applyItemsToMeta(meta, [{ id: 'stk_t1', occasion: [], description: '新描述' }]);
  assert.equal(meta[0].description, '新描述');
  assert.deepEqual(meta[0].occasion, ['晚安']);
});

test('单张识图应用这条链也没有「空数组就删锁」的写法', () => {
  // 这条路径和 applyItemsToMeta 是两份独立代码，改一处不改另一处等于没改，
  // 所以这里直接钉源码：识图段落里不许出现 delete ... occasion。
  const src = readFileSync(new URL('../server/api.js', import.meta.url), 'utf8');
  const start = src.indexOf('识图给的场合锁');
  assert.ok(start > 0, '找不到单张识图的场合锁段落');
  const segment = src.slice(start, start + 600);
  assert.doesNotMatch(segment, /delete\s+latest\[idx\]\.occasion/, '单张识图仍在删锁');
  assert.match(segment, /nextOccasions\.length/, '单张识图没有「非空才写」的判断');
});