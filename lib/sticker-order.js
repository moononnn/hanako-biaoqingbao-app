// 展示按入库时间新→旧；只排序副本，不改图库或快捷图集的持久数据。
export function newestStickersFirst(stickers) {
  const addedTime = sticker => {
    const value = sticker?.added_at;
    const time = typeof value === 'number' ? value : Date.parse(value || '');
    return Number.isFinite(time) ? time : 0;
  };
  return [...stickers].sort((a, b) => (addedTime(b) - addedTime(a))
    || String(b?.id || '').localeCompare(String(a?.id || '')));
}
