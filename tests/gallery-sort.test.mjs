import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');

// 排序逻辑是浏览器脚本，按真实源码加载到 vm 沙箱里测，不用另写一份假逻辑
const src = fs.readFileSync(path.join(appRoot, 'ui', 'assets', 'gallery-sort.js'), 'utf-8');
const sandbox = { Intl, Date, Array, String, module: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const GallerySort = sandbox.GallerySort;

function stk(id, added, tagged, desc, groups) {
  return { id, added_at: added, tagged_at: tagged || '', description: desc || '', __groups: groups || [] };
}

const ids = (list) => list.map((s) => s.id);

test('默认档位是加入时间 新→旧', () => {
  assert.equal(GallerySort.DEFAULT_MODE, 'added_desc');
  const list = [
    stk('stk_1', '2026-10-01T00:00:00.000Z'),
    stk('stk_3', '2026-10-03T00:00:00.000Z'),
    stk('stk_2', '2026-10-02T00:00:00.000Z'),
  ];
  assert.deepEqual(ids(GallerySort.sortStickers(list)), ['stk_3', 'stk_2', 'stk_1']);
});

test('加入时间 旧→新 是默认的反过来', () => {
  const list = [
    stk('stk_1', '2026-10-01T00:00:00.000Z'),
    stk('stk_3', '2026-10-03T00:00:00.000Z'),
    stk('stk_2', '2026-10-02T00:00:00.000Z'),
  ];
  assert.deepEqual(ids(GallerySort.sortStickers(list, 'added_asc')), ['stk_1', 'stk_2', 'stk_3']);
});

test('识别时间 新→旧：没识图的沉到后面，不跟刚识完的混在一起', () => {
  const list = [
    stk('stk_1', '2026-10-01T00:00:00.000Z', ''),
    stk('stk_2', '2026-10-02T00:00:00.000Z', '2026-10-05T00:00:00.000Z'),
    stk('stk_3', '2026-10-03T00:00:00.000Z', '2026-10-04T00:00:00.000Z'),
  ];
  assert.deepEqual(ids(GallerySort.sortStickers(list, 'tagged_desc')), ['stk_2', 'stk_3', 'stk_1']);
});

test('未识图的排最前，其余按加入时间新→旧', () => {
  const list = [
    stk('stk_1', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
    stk('stk_2', '2026-10-05T00:00:00.000Z', ''),
    stk('stk_3', '2026-10-04T00:00:00.000Z', ''),
    stk('stk_4', '2026-10-03T00:00:00.000Z', '2026-10-06T00:00:00.000Z'),
  ];
  assert.deepEqual(ids(GallerySort.sortStickers(list, 'untagged_first')), ['stk_2', 'stk_3', 'stk_4', 'stk_1']);
});

test('按描述排：中文按拼音，空描述沉底', () => {
  const list = [
    stk('stk_1', '2026-10-01T00:00:00.000Z', '', '竹子猫'),
    stk('stk_2', '2026-10-02T00:00:00.000Z', '', ''),
    stk('stk_3', '2026-10-03T00:00:00.000Z', '', '阿呆'),
  ];
  // 拼音序：a(阿) < z(竹)；空描述排在最后
  assert.deepEqual(ids(GallerySort.sortStickers(list, 'description')), ['stk_3', 'stk_1', 'stk_2']);
});

test('按分组排：同组挨在一起，组内按加入时间新→旧', () => {
  const groupIds = (s) => s.__groups;
  const list = [
    stk('stk_1', '2026-10-01T00:00:00.000Z', '', '', ['日常']),
    stk('stk_2', '2026-10-05T00:00:00.000Z', '', '', ['日常']),
    stk('stk_3', '2026-10-02T00:00:00.000Z', '', '', ['抱抱']),
    stk('stk_4', '2026-10-03T00:00:00.000Z', '', '', []),
  ];
  const out = ids(GallerySort.sortStickers(list, 'group', { groupIds }));
  assert.deepEqual(out.slice(0, 2).sort(), ['stk_2', 'stk_3']); // 抱抱 组在前（拼音 b < r）
  assert.ok(out.indexOf('stk_2') < out.indexOf('stk_1'));        // 组内新→旧
  assert.equal(out[out.length - 1], 'stk_4');                   // 无组的排最后
});

test('不认识的档位退回默认，时间相同的按 id 兜底不跳序', () => {
  const list = [
    stk('stk_1', '2026-10-01T00:00:00.000Z'),
    stk('stk_9', '2026-10-01T00:00:00.000Z'),
    stk('stk_5', '2026-10-01T00:00:00.000Z'),
  ];
  assert.deepEqual(ids(GallerySort.sortStickers(list, '乱写的档位')), ['stk_9', 'stk_5', 'stk_1']);
  assert.equal(GallerySort.normalizeMode('乱写的档位'), 'added_desc');
});

test('不改原数组', () => {
  const list = [stk('stk_1', '2026-10-01T00:00:00.000Z'), stk('stk_2', '2026-10-02T00:00:00.000Z')];
  const before = ids(list);
  GallerySort.sortStickers(list, 'added_desc');
  assert.deepEqual(ids(list), before);
});

test('服务端与页面的档位清单必须一致', () => {
  const api = fs.readFileSync(path.join(appRoot, 'server', 'api.js'), 'utf-8');
  const panel = fs.readFileSync(path.join(appRoot, 'ui', 'panel.html'), 'utf-8');
  const apiList = api.slice(api.indexOf('GALLERY_SORT_MODES = ['));
  const serverModes = apiList.slice(apiList.indexOf('[') + 1, apiList.indexOf(']'))
    .match(/'([a-z_]+)'/g).map((m) => m.replace(/'/g, ''));
  const htmlList = panel.slice(panel.indexOf('id="filter-sort"'));
  const htmlModes = (htmlList.slice(0, htmlList.indexOf('</select>')).match(/value="([a-z_]+)"/g) || [])
    .map((m) => m.replace(/value="|"/g, ''));
  const uiModes = JSON.parse(JSON.stringify(GallerySort.SORT_MODES.map((m) => m.value)));

  // 沙箱里产生的数组原型跟宿主不同，deepStrictEqual 会误报；统一成字符串比。
  assert.equal(serverModes.join('|'), uiModes.join('|'), 'server/api.js 的 GALLERY_SORT_MODES 与 gallery-sort.js 不一致');
  assert.equal(htmlModes.join('|'), uiModes.join('|'), 'panel.html 里 filter-sort 的选项与 gallery-sort.js 不一致');
});