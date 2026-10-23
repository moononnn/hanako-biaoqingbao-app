// 快捷面板的搜索：纯逻辑，普通脚本（不是 ES 模块）。
// 为什么不用 ES 模块：这个文件会被 tests/sticker-input-panel.test.mjs 塞进 vm 里跑，
// vm 不认 import 语句，sticker-compose.js 里一旦 import 这个模块，那边的 UI 测试就全挂。
// 所以这里挂到全局上，页面用 <script> 先加载它，面板再从全局取。
// 起因（2026-10-21）：面板原来只搜 description + keywords 两个字段，
// 情绪、场景、语义描述、分组名全搜不到，图一多就只能靠翻。
(function () {
  'use strict';

  // 一张图能被人搜到的所有词：描述、语义描述、关键词、情绪、场景、分组名与识别别名。
  function searchableText(item) {
    if (!item) return '';
    var parts = [item.description, item.semantic_description];
    var keys = ['keywords', 'emotion', 'scene'];
    for (var k = 0; k < keys.length; k++) {
      var list = item[keys[k]];
      if (!Array.isArray(list)) continue;
      for (var i = 0; i < list.length; i++) if (list[i]) parts.push(String(list[i]));
    }
    var groups = Array.isArray(item.groups) ? item.groups : [];
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      if (!group) continue;
      if (group.name) parts.push(String(group.name));
      var terms = Array.isArray(group.terms) ? group.terms : [];
      for (var t = 0; t < terms.length; t++) if (terms[t]) parts.push(String(terms[t]));
    }
    return parts.filter(Boolean).join(' ').toLowerCase();
  }

  // 查询词按空白切开：整串命中排前面，任意一个词命中也算数（搜得到优先）。
  function tokenize(query) {
    var raw = String(query || '').trim().toLowerCase();
    if (!raw) return [];
    return raw.split(/\s+/).filter(Boolean);
  }

  // 2 = 整串命中；1 = 单词命中；0 = 没命中。
  function matchScore(text, query, tokens) {
    if (!query) return 0;
    var haystack = String(text || '');
    if (haystack.includes(query)) return 2;
    for (var i = 0; i < tokens.length; i++) if (haystack.includes(tokens[i])) return 1;
    return 0;
  }

  // 过滤 + 排序：整串命中在前，只命中一个词的排在后面，其余保持原顺序。
  function filterItems(items, options) {
    var opts = options || {};
    var list = Array.isArray(items) ? items : [];
    var query = String(opts.query || '').trim().toLowerCase();
    var tokens = tokenize(query);
    var textOf = typeof opts.textOf === 'function' ? opts.textOf : searchableText;
    var scored = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!query) { scored.push({ item: item, score: 0 }); continue; }
      var score = matchScore(textOf(item), query, tokens);
      if (score > 0) scored.push({ item: item, score: score });
    }
    if (query) scored.sort(function (a, b) { return b.score - a.score; });
    return scored.map(function (entry) { return entry.item; });
  }

  var api = {
    searchableText: searchableText,
    tokenize: tokenize,
    matchScore: matchScore,
    filterItems: filterItems,
  };
  if (typeof window !== 'undefined') window.stickerComposeSearch = api;
  if (typeof globalThis !== 'undefined') globalThis.stickerComposeSearch = api;
})();
