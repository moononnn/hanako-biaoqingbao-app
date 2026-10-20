// 预览放在页面根部，不进入图库的滚动裁切区。
export function previewPosition(rect, viewportWidth, viewportHeight) {
  const width = Math.max(1, Math.min(280, viewportWidth - 16));
  const height = Math.max(1, Math.min(320, viewportHeight - 16));
  let left = rect.right + 10;
  if (left + width > viewportWidth - 8) left = rect.left - width - 10;
  left = Math.max(8, Math.min(left, viewportWidth - width - 8));
  const top = Math.max(8, Math.min(rect.top + rect.height / 2 - height / 2, viewportHeight - height - 8));
  return { left, top, width, height };
}

export function createStickerPreview({ imageUrl, description, doc = document, view = window }) {
  const preview = doc.createElement('figure');
  preview.id = 'sticker-preview'; preview.hidden = true;
  preview.setAttribute('aria-hidden', 'true');
  const image = doc.createElement('img'); image.alt = '';
  const caption = doc.createElement('figcaption');
  preview.append(image, caption); doc.body.append(preview);
  let timer = null, epoch = 0;
  function hide() {
    epoch++; if (timer !== null) view.clearTimeout(timer); timer = null;
    preview.hidden = true; image.removeAttribute('src');
  }
  async function show(target, id, current) {
    timer = null;
    if (current !== epoch || !target.isConnected || view.innerWidth < 32 || view.innerHeight < 32) return;
    const position = previewPosition(target.getBoundingClientRect(), view.innerWidth, view.innerHeight);
    for (const [key, value] of Object.entries(position)) preview.style[key] = value + 'px';
    caption.textContent = '正在加载…'; preview.hidden = false;
    let url = '';
    try { url = await imageUrl(id); } catch { /* 只影响预览，不影响选图和发送。 */ }
    if (current !== epoch || !target.isConnected) return;
    if (!url) { caption.textContent = '图片暂时读不到'; return; }
    image.src = url; caption.textContent = description(id) || '表情包';
  }
  function bind(target, id) {
    function enter(event) {
      if (event?.pointerType === 'touch') return;
      hide(); const current = epoch;
      timer = view.setTimeout(() => { void show(target, id, current); }, event?.type === 'focus' ? 0 : 220);
    }
    target.addEventListener('pointerenter', enter);
    target.addEventListener('focus', enter);
    for (const event of ['pointerleave', 'blur', 'pointerdown']) target.addEventListener(event, hide);
  }
  view.addEventListener('resize', hide);
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) hide(); });
  return { bind, hide, dispose() { hide(); view.removeEventListener('resize', hide); preview.remove(); } };
}
