// 落到目标图片所在位置；不修改输入数组。
export function moveSticker(ids, source, target) {
  const from = ids.indexOf(source), to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, source);
  return next;
}
