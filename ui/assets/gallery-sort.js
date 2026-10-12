/* 图库排序：纯逻辑，不碰 DOM，浏览器与 Node 两侧都能加载。
   单独成文件是为了能直接喂进测试（vm 沙箱取 window.GallerySort）。 */
(function (root) {
  'use strict';

  // 加入时间：新→旧（默认）、旧→新、识别时间新→旧、描述拼音、未识图在前、按分组
  var SORT_MODES = [
    { value: 'added_desc', label: '加入时间：新 → 旧' },
    { value: 'added_asc', label: '加入时间：旧 → 新' },
    { value: 'tagged_desc', label: '识别时间：新 → 旧' },
    { value: 'description', label: '按图片描述' },
    { value: 'untagged_first', label: '未识图的排最前' },
    { value: 'group', label: '按分组' },
  ];

  var DEFAULT_MODE = 'added_desc';
  var MODE_VALUES = SORT_MODES.map(function (m) { return m.value; });
  // 未分组用的哨兵值：直接拿空串会让「未分组」排到最前面去
  var LAST_GROUP = '￿';

  function normalizeMode(mode) {
    return MODE_VALUES.indexOf(mode) >= 0 ? mode : DEFAULT_MODE;
  }

  function timeOf(sticker, field) {
    var t = Date.parse((sticker && sticker[field]) || '');
    return isNaN(t) ? 0 : t;
  }

  // 中文按拼音排序：交给浏览器的 Collator，不自己维护拼音表
  var collator = null;
  function compareText(a, b) {
    if (!collator) {
      try {
        collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });
      } catch (_) {
        try { collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }); }
        catch (__) { collator = null; }
      }
    }
    if (collator) return collator.compare(a, b);
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  function descriptionOf(sticker) {
    return String((sticker && sticker.description) || '').trim();
  }

  /**
   * @param {Array} list 原数组不改动，返回新数组
   * @param {string} mode 排序档位
   * @param {{ groupIds?: (sticker) => string[] }} [opts] 分组解析器；没有就不分组
   */
  function sortStickers(list, mode, opts) {
    var input = Array.isArray(list) ? list.slice() : [];
    var m = normalizeMode(mode);
    var getGroupIds = (opts && typeof opts.groupIds === 'function') ? opts.groupIds : null;

    // 同档位里统一用 id 兜底，避免同时间的条目顺序每次刷新都跳
    var byIdDesc = function (a, b) {
      return String(b && b.id || '').localeCompare(String(a && a.id || ''));
    };

    input.sort(function (a, b) {
      if (m === 'added_asc') {
        return (timeOf(a, 'added_at') - timeOf(b, 'added_at')) || byIdDesc(a, b);
      }
      if (m === 'tagged_desc') {
        // 没识图的沉到后面，别跟刚识完的混在一起
        var ta = timeOf(a, 'tagged_at'), tb = timeOf(b, 'tagged_at');
        if (!ta && tb) return 1;
        if (ta && !tb) return -1;
        return (tb - ta) || byIdDesc(a, b);
      }
      if (m === 'description') {
        // 还没识图、描述为空的那批沉到最后：空串本来会排最前，等于把“欠账的”顶到最显眼处
        var da = descriptionOf(a) || LAST_GROUP;
        var db = descriptionOf(b) || LAST_GROUP;
        var cmp = compareText(da, db);
        return cmp || (timeOf(b, 'added_at') - timeOf(a, 'added_at')) || byIdDesc(a, b);
      }
      if (m === 'untagged_first') {
        var ua = a && a.tagged_at ? 1 : 0, ub = b && b.tagged_at ? 1 : 0;
        if (ua !== ub) return ua - ub;
        return (timeOf(b, 'added_at') - timeOf(a, 'added_at')) || byIdDesc(a, b);
      }
      if (m === 'group' && getGroupIds) {
        var ga = (getGroupIds(a) || []).join(' ') || LAST_GROUP;
        var gb = (getGroupIds(b) || []).join(' ') || LAST_GROUP;
        var gc = compareText(ga, gb);
        if (gc) return gc;
        return (timeOf(b, 'added_at') - timeOf(a, 'added_at')) || byIdDesc(a, b);
      }
      // added_desc
      return (timeOf(b, 'added_at') - timeOf(a, 'added_at')) || byIdDesc(a, b);
    });

    return input;
  }

  var api = {
    SORT_MODES: SORT_MODES,
    DEFAULT_MODE: DEFAULT_MODE,
    normalizeMode: normalizeMode,
    sortStickers: sortStickers,
  };

  root.GallerySort = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);