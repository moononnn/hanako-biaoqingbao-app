import { hana } from './sdk.js';
import { createStickerPreview } from './sticker-preview.js';
import { moveSticker } from './sticker-reorder.js';
const $ = id => document.getElementById(id);
let active = false;
let ticket = '', catalog = [], pinnedIds = [], selected = [], mode = 'pinned', busy = false, requestId = '', generation = 0;
let draggedId = '', contextId = '', editingTitleId = '', titleSaving = false;
// 发送编号：宿主页面不一定是安全上下文，randomUUID 可能不存在或调用时抛错。
// 退回到时间戳加随机数，格式仍要过服务端的 [a-zA-Z0-9_-]{8,100}。
let fallbackRequestSeq = 0;
function newRequestId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  fallbackRequestSeq += 1;
  return 'req-' + Date.now().toString(36) + '-' + fallbackRequestSeq + '-' + Math.random().toString(36).slice(2, 10);
}
const images = new Map();
const imageObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    imageObserver.unobserve(entry.target);
    loadImage(entry.target.dataset.stickerId, entry.target);
  }
}, { root: $('gallery'), rootMargin: '160px' }) : null;
function saveDraft() {
  if (!ticket) return;
  try {
    if (!selected.length && !$('text').value && !requestId) sessionStorage.removeItem('bqb-compose:' + ticket);
    else sessionStorage.setItem('bqb-compose:' + ticket, JSON.stringify({ selected, text: $('text').value, requestId }));
  } catch { /* 当前页面中的草稿仍保留。 */ }
}
function clearSentDraft(sentTicket, sentRequestId) {
  try {
    const key = 'bqb-compose:' + sentTicket;
    if (JSON.parse(sessionStorage.getItem(key) || 'null')?.requestId === sentRequestId) sessionStorage.removeItem(key);
  } catch { /* 不覆盖其他草稿。 */ }
}
function restoreDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('bqb-compose:' + ticket) || 'null');
    if (!saved) return;
    selected = Array.isArray(saved.selected) ? saved.selected.filter(id => typeof id === 'string').slice(0, 8) : [];
    $('text').value = typeof saved.text === 'string' ? saved.text.slice(0, 2000) : '';
    requestId = typeof saved.requestId === 'string' ? saved.requestId : '';
  } catch { /* 没有可恢复的草稿。 */ }
}
function note(text) { $('status').textContent = text; }
async function api(route, body) {
  const response = await hana.api.fetch('/api/sticker-compose/' + route, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ticket }),
  });
  const data = await response.json();
  if (!response.ok || data?.ok !== true) throw new Error(data?.error || '操作未确认成功，请重试');
  return data;
}
function imageUrl(id) {
  if (!images.has(id)) images.set(id, hana.api.fetch('/api/image?id=' + encodeURIComponent(id)).then(async response => {
    if (!response.ok) throw new Error('图片读取失败');
    return URL.createObjectURL(await response.blob());
  }).catch(() => { images.delete(id); return ''; }));
  return images.get(id);
}
function loadImage(id, img) {
  imageUrl(id).then(url => { if (url && img.isConnected) img.src = url; });
}
const stickerPreview = createStickerPreview({ imageUrl, description: id => catalog.find(item => item.id === id)?.description });
$('gallery').addEventListener('scroll', () => { stickerPreview.hide(); closeContextMenu(); }, { passive: true });
function makeImage(id, lazy = false) {
  const image = document.createElement('img');
  image.draggable = false;
  image.alt = catalog.find(s => s.id === id)?.description || '表情包';
  image.decoding = 'async';
  if (lazy && imageObserver) {
    image.dataset.stickerId = id;
    queueMicrotask(() => { if (image.isConnected) imageObserver.observe(image); });
  } else queueMicrotask(() => loadImage(id, image));
  return image;
}
function button(text, action) { const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.addEventListener('click', action); return el; }
function editable() { if (busy) return false; if (requestId) { note('上次发送还未确认。请先重试或检查对话；文字和选图暂时保留。'); return false; } return true; }
function toggle(id) {
  if (!editable()) return;
  if (selected.includes(id)) selected = selected.filter(value => value !== id);
  else { if (selected.length >= 8) return note('一次最多选 8 张'); selected.push(id); }
  note(''); render();
}
async function reload(quiet = false) {
  if (!ticket) return;
  const current = ticket, seq = ++generation;
  try {
    const data = await api('library?ticket=' + encodeURIComponent(ticket) + '&requestId=' + encodeURIComponent(requestId));
    if (ticket !== current || seq !== generation || draggedId) return;
    // 面板重挂可能错过发送回包；以后台已确认完成的编号清理旧草稿。
    const completed = !!requestId && data.completedRequestId === requestId;
    if (completed) { clearSentDraft(ticket, requestId); selected = []; $('text').value = ''; requestId = ''; busy = false; note('已发送'); }
    const changed = JSON.stringify([catalog, pinnedIds]) !== JSON.stringify([data.data, data.pinnedIds]);
    catalog = data.data; pinnedIds = data.pinnedIds;
    if (changed || completed) render();
    if (!quiet) note('图集已刷新，与纸飞机共用');
  } catch (error) { if (ticket === current && !quiet) note(error.message); }
}
async function pin(id, value) {
  if (!editable()) return;
  busy = true; render(); note('正在更新图集…');
  try { await api('pin', { stickerId: id, pinned: value }); await reload(true); note(value ? '已加入图集，纸飞机里也有了' : '已从两边图集移出，原图仍留在图库'); }
  catch (error) { note(error.message); }
  finally { busy = false; render(); }
}
async function removeOriginal(id) {
  if (!editable()) return;
  const dialog = $('delete-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  const answer = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  if (answer !== 'delete' || !editable()) return;
  busy = true; render(); note('正在删除…');
  try {
    const response = await hana.api.fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', id }) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '删除未成功');
    selected = selected.filter(value => value !== id);
    // readBallConfig 与纸飞机都按现存图库过滤已删除编号。
    await reload(true); note('已从共享图库删除');
  } catch (error) { await reload(true); note(error.message); }
  finally { busy = false; render(); }
}
function closeContextMenu() { $('context-menu').hidden = true; contextId = ''; }
function openContextMenu(event, id, anchor) {
  if (mode !== 'pinned' || !editable()) return;
  event.preventDefault();
  closeContextMenu(); stickerPreview.hide(); contextId = id;
  const menu = $('context-menu'); menu.hidden = false;
  const rect = menu.getBoundingClientRect(), tile = anchor.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(event.clientX || tile.left, window.innerWidth - rect.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(event.clientY || tile.bottom, window.innerHeight - rect.height - 4)) + 'px';
  $('context-title').focus();
}
async function reorder(source, target) {
  if (!editable()) return;
  const ids = moveSticker(pinnedIds, source, target);
  if (!ids) return;
  busy = true; generation++; render(); note('正在保存顺序…');
  try { await api('reorder', { ids }); await reload(true); note('顺序已保存，两边图集会同步'); }
  catch (error) { await reload(true); note(error.message); }
  finally { busy = false; render(); }
}
function render() {
  closeContextMenu();
  stickerPreview.hide();
  saveDraft();
  const search = $('search').value.trim().toLowerCase();
  const byId = new Map(catalog.map(item => [item.id, item]));
  const source = mode === 'pinned' ? pinnedIds.map(id => byId.get(id)).filter(Boolean) : catalog;
  const filtered = source.filter(item => !search || (item.description + ' ' + item.keywords.join(' ')).toLowerCase().includes(search));
  const scrollTop = $('gallery').scrollTop;
  imageObserver?.disconnect();
  $('gallery').replaceChildren();
  for (const item of filtered) {
    const tile = document.createElement('div'); tile.className = 'tile';
    const pick = button('', () => mode === 'library' ? pin(item.id, !pinnedIds.includes(item.id)) : toggle(item.id));
    stickerPreview.bind(pick, item.id);
    pick.addEventListener('contextmenu', event => openContextMenu(event, item.id, pick));
    pick.draggable = mode === 'pinned' && !busy && !requestId;
    pick.addEventListener('dragstart', event => {
      if (mode !== 'pinned' || !editable()) { event.preventDefault(); return; }
      draggedId = item.id; generation++; closeContextMenu(); stickerPreview.hide();
      event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move';
      tile.classList.add('dragging');
    });
    pick.addEventListener('dragover', event => { if (draggedId && mode === 'pinned') { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; tile.classList.add('drop-target'); } });
    pick.addEventListener('dragleave', () => tile.classList.remove('drop-target'));
    pick.addEventListener('drop', event => {
      event.preventDefault(); const source = draggedId; draggedId = ''; tile.classList.remove('drop-target');
      if (source && mode === 'pinned') reorder(source, item.id);
    });
    pick.addEventListener('dragend', () => { draggedId = ''; tile.classList.remove('dragging', 'drop-target'); });
    pick.className = 'pick'; pick.disabled = busy || !!requestId;
    pick.setAttribute('aria-pressed', String(mode === 'library' ? pinnedIds.includes(item.id) : selected.includes(item.id)));
    pick.title = mode === 'library' ? (pinnedIds.includes(item.id) ? '已加入，点一下移出两边图集' : '加入两边共享图集') : '加入或移出待发送区';
    pick.append(makeImage(item.id, true));
    const label = document.createElement('span'); label.className = 'caption'; label.textContent = (mode === 'library' && pinnedIds.includes(item.id) ? '✓ ' : '') + (item.description || '表情包'); pick.append(label); tile.append(pick);
    $('gallery').append(tile);
  }
  if (!filtered.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = mode === 'pinned' ? '图集还空着，点「从图库添加」挑几张吧。' : '没有找到表情包。'; $('gallery').append(empty); }
  $('gallery').scrollTop = scrollTop;
  $('pinned').classList.toggle('active', mode === 'pinned'); $('library').classList.toggle('active', mode === 'library');
  $('queue').replaceChildren(...selected.map(id => { const remove = button('', () => toggle(id)); remove.title = '移出待发送区（不删原图）'; remove.disabled = busy || !!requestId; remove.append(makeImage(id)); const mark = document.createElement('span'); mark.textContent = '×'; remove.append(mark); return remove; }));
  $('reset').hidden = !requestId || busy;
  $('send').disabled = busy || !active || !ticket || (!selected.length && !$('text').value.trim()); $('send').textContent = busy ? '处理中…' : requestId ? '重试发送' : '发送';
  $('text').disabled = busy || !!requestId;
}
$('context-title').onclick = () => {
  const id = contextId; closeContextMenu();
  if (!id || titleSaving || !editable()) return;
  const item = catalog.find(item => item.id === id);
  if (!item) return;
  editingTitleId = id;
  $('title-value').value = item.description || ''; $('title-status').textContent = '';
  $('title-dialog').showModal();
  const input = $('title-value');
  input.focus(); input.setSelectionRange(0, 0); input.scrollLeft = 0;
};
$('title-cancel').onclick = () => { if (!titleSaving) $('title-dialog').close(); };
$('title-dialog').addEventListener('cancel', event => { if (titleSaving) event.preventDefault(); });
$('title-form').onsubmit = async event => {
  event.preventDefault();
  if (titleSaving || !editingTitleId) return;
  const description = $('title-value').value.trim();
  if (!description) { $('title-status').textContent = '标题不能为空'; return; }
  titleSaving = true;
  $('title-value').disabled = true; $('title-save').disabled = true; $('title-cancel').disabled = true;
  $('title-status').textContent = '正在保存…';
  try {
    // 与主页完全复用 update：修改共享图库，交给现有后台处理识图教学。
    const response = await hana.api.fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update', id: editingTitleId, description }) });
    const data = await response.json();
    if (!response.ok || data?.ok !== true) throw new Error(data?.error || '保存未确认成功，请重试');
    await reload(true);
    $('title-dialog').close(); note('标题已保存');
  } catch (error) { $('title-status').textContent = error.message + '，标题仍保留，可以重试。'; }
  finally { titleSaving = false; $('title-value').disabled = false; $('title-save').disabled = false; $('title-cancel').disabled = false; }
};
$('context-unpin').onclick = () => { const id = contextId; closeContextMenu(); if (id) pin(id, false); };
$('context-delete').onclick = () => { const id = contextId; closeContextMenu(); if (id) removeOriginal(id); };
window.addEventListener('pointerdown', event => { if (!$('context-menu').contains(event.target)) closeContextMenu(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape') closeContextMenu(); });
window.addEventListener('resize', closeContextMenu);
$('pinned').onclick = () => { mode = 'pinned'; $('gallery').scrollTop = 0; render(); };
$('library').onclick = () => { mode = 'library'; $('gallery').scrollTop = 0; render(); reload(true); };
$('search').oninput = () => { $('gallery').scrollTop = 0; render(); };
$('text').oninput = () => {
  saveDraft();
  $('send').disabled = busy || !active || !ticket || (!selected.length && !$('text').value.trim());
};
$('refresh').onclick = () => reload();
$('send').onclick = async () => {
  if (busy || !active || !ticket) return;
  const sendingTicket = ticket;
  busy = true; requestId ||= newRequestId();
  const sendingRequestId = requestId;
  let ownsReply = false;
  render(); note('正在发送…');
  try {
    await api('send', { requestId, text: $('text').value, stickerIds: [...selected] });
    clearSentDraft(sendingTicket, sendingRequestId);
    // 收起/重开改变可见状态，但同一编号的成功回执仍须清空；其他草稿不能被迟到回执清掉。
    ownsReply = ticket === sendingTicket && requestId === sendingRequestId;
    if (!ownsReply) return;
    selected = []; $('text').value = ''; requestId = ''; note('已发送');
  } catch (error) {
    ownsReply = ticket === sendingTicket && requestId === sendingRequestId;
    if (ownsReply) note(error.message + '。待发送内容已保留。');
  } finally { if (ownsReply) { busy = false; render(); } }
};
$('reset').onclick = () => {
  const dialog = $('reset-dialog');
  dialog.returnValue = ''; dialog.showModal();
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'edit') { requestId = ''; note('内容已保留，可继续编辑；已送达的部分不要重复发送。'); render(); }
  }, { once: true });
};
function bind(context) {
  const next = context?.data?.ticket || '';
  active = !!next;
  if (!next) { busy = false; render(); return; }
  if (next === ticket) { render(); reload(true); return; }
  ticket = next; busy = false; catalog = []; pinnedIds = []; selected = []; requestId = ''; $('text').value = ''; $('gallery').scrollTop = 0;
  restoreDraft(); render(); reload();
}
hana.inputPanel.onContextChanged(bind);
bind(hana.inputPanel.getContext());
// 仅可见时读共享数据，纸飞机改图集后无需关闭重开面板。
const refresh = setInterval(() => { if (!document.hidden && !busy && !draggedId) reload(true); }, 8000);
window.addEventListener('pagehide', () => { stickerPreview.dispose(); imageObserver?.disconnect(); clearInterval(refresh); for (const image of images.values()) image.then(url => { if (url) URL.revokeObjectURL(url); }); });
hana.ready();
