// 面板里「点一张图」到底做什么：这两条规则单独拎出来，好用 vm 直接测。
// 普通脚本（不是 ES 模块），挂全局：面板脚本会被 UI 测试塞进 vm 跑，vm 不认 import 语句。
//
// 起因：原来「从图库添加」页签点图是去收藏，不是进待发送区，
// 于是用户在那页选完图也发不出去（必须写点字才点得动发送），很难受。
// 现在两个页签点图统一是「加入待发送区」，收藏挪到图角上的收藏角标。
(function (global) {
  // 点图：管理态是选中一张做批量操作；平时是加入/移出待发送区。
  function pickAction(managing) {
    return managing ? 'manage' : 'queue';
  }
  // 图角的收藏角标：已收藏就移出，没收藏就加入。
  function favoriteAction(pinned) {
    return pinned ? 'unpin' : 'pin';
  }
  global.stickerComposePick = { pickAction, favoriteAction };
})(typeof window !== 'undefined' ? window : globalThis);
