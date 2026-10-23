import { hana } from './sdk.js';
import { createStickerPreview } from './sticker-preview.js';
import { moveSticker } from './sticker-reorder.js';
const $ = id => document.getElementById(id);
let active = false;
let ticket = '', catalog = [], pinnedIds = [], selected = [], mode = 'pinned', busy = false, requestId = '', generation = 0;
// 收藏分类：我的收藏里自己分的类。空 = 全部收藏，其余是分类 id。
let categories = [], categoryFilter = '';
// 管理态：对整个收藏页生效的多选。进来能批量放进分类、移出分类、移出收藏。
let managing = false, selectedManage = new Set();
// 分类弹层两种用法：single = 单张（勾选的就是最终结果）；batch = 多张（勾选的是要加进去的）。
let categoryMode = 'single', categoryBatchIds = [];
// 分类弹层：正在给哪张图分类、勾了哪些、弹层里新建的分类名
let categoryTarget = '', categoryDraft = new Set(), categorySaving = false, categoryArmedDelete = '';
// 搜索与筛选的纯逻辑在 sticker-compose-search.js（普通脚本，挂全局）。
// 这个文件会被 UI 测试塞进 vm 跑，vm 不认 import 语句，所以只能从全局取，不能 import。
function searchApi() {
  if (typeof globalThis !== 'undefined' && globalThis.stickerComposeSearch) return globalThis.stickerComposeSearch;
  if (typeof window !== 'undefined' && window.stickerComposeSearch) return window.stickerComposeSearch;
  return null;
}
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
    const changed = JSON.stringify([catalog, pinnedIds, categories]) !== JSON.stringify([data.data, data.pinnedIds, data.categories || []]);
    catalog = data.data; pinnedIds = data.pinnedIds;
    categories = Array.isArray(data.categories) ? data.categories : [];
    if (data.categoryError) note('收藏分类没读出来：' + data.categoryError);
    if (changed || completed) render();
    if (!quiet) note('收藏已刷新，与纸飞机共用');
  } catch (error) { if (ticket === current && !quiet) note(error.message); }
}
async function pin(id, value) {
  if (!editable()) return;
  busy = true; render(); note('正在更新收藏…');
  try { await api('pin', { stickerId: id, pinned: value }); await reload(true); note(value ? '已加入收藏，纸飞机里也有了' : '已从收藏移出，原图仍留在图库'); }
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
  try { await api('reorder', { ids }); await reload(true); note('顺序已保存，纸飞机那边会同步'); }
  catch (error) { await reload(true); note(error.message); }
  finally { busy = false; render(); }
}
function render() {
  closeContextMenu();
  stickerPreview.hide();
  saveDraft();
  const byId = new Map(catalog.map(item => [item.id, item]));
  const collected = mode === 'pinned' ? pinnedIds.map(id => byId.get(id)).filter(Boolean) : catalog;
  // 选中的分类只对收藏有效（分类是收藏的子集）；分类在收藏里一张都没有时自动放开。
  if (categoryFilter && !categories.some(category => category.id === categoryFilter)) categoryFilter = '';
  const source = categoryFilter
    ? collected.filter(item => (item.categories || []).includes(categoryFilter))
    : collected;
  const api = searchApi();
  const filtered = api ? api.filterItems(source, { query: $('search').value }) : source;
  if (!api && $('search').value.trim()) note('搜索组件没加载，搜索暂时用不了');
  renderCats();
  renderManageBar();
  const scrollTop = $('gallery').scrollTop;
  imageObserver?.disconnect();
  $('gallery').replaceChildren();
  for (const item of filtered) {
    const tile = document.createElement('div'); tile.className = 'tile';
    const pick = button('', () => {
      if (managing) { toggleManagePick(item.id); return; }
      return mode === 'library' ? pin(item.id, !pinnedIds.includes(item.id)) : toggle(item.id);
    });
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
    pick.title = mode === 'library' ? (pinnedIds.includes(item.id) ? '已加入，点一下移出收藏' : '加入我的收藏') : '加入或移出待发送区';
    pick.append(makeImage(item.id, true));
    const label = document.createElement('span'); label.className = 'caption'; label.textContent = (mode === 'library' && pinnedIds.includes(item.id) ? '✓ ' : '') + (item.description || '表情包'); pick.append(label); tile.append(pick);
    // 管理态：图角上是一个勾选圈，点一下选一张，可以批量操作
    if (managing) {
      const on = selectedManage.has(item.id);
      const mark = document.createElement('span');
      mark.className = on ? 'pick-mark on' : 'pick-mark';
      mark.textContent = on ? '✓' : '';
      tile.append(mark);
    }
    $('gallery').append(tile);
  }
  if (!filtered.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = mode === 'pinned'
      ? (collected.length === 0
        ? '收藏还空着，点「从图库添加」挑几张吧。'
        : (source.length === 0
          ? '这个分类还没有图。右键一张图就能把它分进来。'
          : '没有匹配的表情包。换个词，或者点一下上面的分类。'))
      : '图库里还没有表情包。';
    $('gallery').append(empty);
  }
  const counter = $('count');
  if (counter) counter.textContent = filtered.length === source.length ? `${source.length} 张` : `${filtered.length} / ${source.length} 张`;
  $('gallery').scrollTop = scrollTop;
  $('pinned').classList.toggle('active', mode === 'pinned'); $('library').classList.toggle('active', mode === 'library');
  $('queue').replaceChildren(...selected.map(id => { const remove = button('', () => toggle(id)); remove.title = '移出待发送区（不删原图）'; remove.disabled = busy || !!requestId; remove.append(makeImage(id)); const mark = document.createElement('span'); mark.textContent = '×'; remove.append(mark); return remove; }));
  $('reset').hidden = !requestId || busy;
  $('send').disabled = busy || !active || !ticket || (!selected.length && !$('text').value.trim()); $('send').textContent = busy ? '处理中…' : requestId ? '重试发送' : '发送';
  $('text').disabled = busy || !!requestId;
}
// 收藏分类 tab 行：全部收藏 + 每个分类（带张数）+ ＋新建 + 管理。
// 「改名」「删分类」不常驻：只有进了管理态才露出来，平常那行干干净净。
function renderCats() {
  const box = $('cats');
  if (!box) return;
  if (mode !== 'pinned') { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const nodes = [];
  const make = (label, count, selected, onClick, className) => {
    const tab = document.createElement('button');
    tab.type = 'button'; tab.className = className || 'cat';
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (count !== null && count !== undefined) {
      const name = document.createElement('span'); name.textContent = label;
      const num = document.createElement('span'); num.className = 'n'; num.textContent = String(count);
      tab.append(name, num);
    } else {
      tab.textContent = label;
    }
    tab.addEventListener('click', onClick);
    return tab;
  };
  nodes.push(make('全部收藏', pinnedIds.length, !categoryFilter, () => selectCategory('')));
  for (const category of categories) {
    const selected = categoryFilter === category.id;
    nodes.push(make(category.name, category.count, selected, () => selectCategory(category.id)));
    if (selected && managing) {
      const rename = document.createElement('button');
      rename.type = 'button'; rename.className = 'cat-tool'; rename.textContent = '改名';
      rename.addEventListener('click', () => openCategoryNameDialog('rename', category.id, category.name));
      nodes.push(rename);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'cat-tool danger';
      remove.textContent = categoryArmedDelete === category.id ? '再点一次' : '删分类';
      remove.addEventListener('click', () => armOrDeleteCategory(category.id));
      nodes.push(remove);
    }
  }
  const add = make('＋ 新建分类', null, false, () => openCategoryNameDialog('create'), 'cat add');
  nodes.push(add);
  // 管理态的出口在底部操作条上（那里有「完成」），这里就不再放一个同义的按钮。
  if (!managing) {
    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'cat-tool manage';
    manage.textContent = '管理';
    manage.title = '管理收藏：多选图片，批量放进分类或移出收藏';
    manage.addEventListener('click', () => toggleManage());
    nodes.push(manage);
  }
  box.replaceChildren(...nodes);
}
// 管理态：整个收藏页都能管，不限某个分类。平常那行干干净净。
function toggleManage() {
  if (managing) { managing = false; selectedManage = new Set(); render(); return; }
  managing = true; selectedManage = new Set();
  render();
  note('管理中：点图选中，可以批量放进分类、移出收藏');
}
function toggleManagePick(id) {
  if (selectedManage.has(id)) selectedManage.delete(id); else selectedManage.add(id);
  render();
}
// 当前视图里显示着的图（管理态的全选范围）
function currentViewIds() {
  const byId = new Map(catalog.map(item => [item.id, item]));
  const collected = mode === 'pinned' ? pinnedIds.map(id => byId.get(id)).filter(Boolean) : catalog;
  return (categoryFilter ? collected.filter(item => (item.categories || []).includes(categoryFilter)) : collected).map(item => item.id);
}
// 管理态底部的操作条：已选多少、全选、批量放进分类、移出分类、移出收藏。
function renderManageBar() {
  const bar = $('manage-bar');
  const compose = $('compose');
  if (!bar) return;
  if (!managing) { bar.hidden = true; if (compose) compose.hidden = false; return; }
  bar.hidden = false;
  if (compose) compose.hidden = true;
  const nodes = [];
  const count = document.createElement('span'); count.className = 'manage-count';
  count.textContent = `已选 ${selectedManage.size} 张`;
  nodes.push(count);
  const viewIds = currentViewIds();
  const allPicked = viewIds.length > 0 && viewIds.every(id => selectedManage.has(id));
  const toggleAll = document.createElement('button');
  toggleAll.type = 'button'; toggleAll.className = 'manage-btn';
  toggleAll.textContent = allPicked ? '全不选' : '全选';
  toggleAll.addEventListener('click', () => {
    if (allPicked) selectedManage.clear(); else for (const id of viewIds) selectedManage.add(id);
    render();
  });
  nodes.push(toggleAll);
  const toCategory = document.createElement('button');
  toCategory.type = 'button'; toCategory.className = 'manage-btn';
  toCategory.textContent = '放进分类…'; toCategory.disabled = !selectedManage.size;
  toCategory.addEventListener('click', () => openBatchCategoryDialog());
  nodes.push(toCategory);
  if (categoryFilter) {
    const out = document.createElement('button');
    out.type = 'button'; out.className = 'manage-btn';
    out.textContent = '移出这个分类'; out.disabled = !selectedManage.size;
    out.addEventListener('click', () => batchRemoveFromCategory());
    nodes.push(out);
  }
  const unpin = document.createElement('button');
  unpin.type = 'button'; unpin.className = 'manage-btn danger';
  unpin.textContent = '移出收藏'; unpin.disabled = !selectedManage.size;
  unpin.addEventListener('click', () => batchUnpin());
  nodes.push(unpin);
  const done = document.createElement('button');
  done.type = 'button'; done.className = 'manage-btn primary';
  done.textContent = '完成';
  done.addEventListener('click', () => { managing = false; selectedManage = new Set(); render(); });
  nodes.push(done);
  bar.replaceChildren(...nodes);
}
// 批量放进分类 / 移出分类 / 移出收藏：一次请求一次落盘，不是一张一张发。
async function batchRemoveFromCategory() {
  const ids = [...selectedManage];
  if (!ids.length || !categoryFilter) return;
  try {
    await api('category-remove-batch', { stickerIds: ids, categoryId: categoryFilter });
    selectedManage = new Set();
    await reload(true);
    note('已从这个分类移出，原图还在收藏里');
  } catch (error) { note(error.message); }
  render();
}
async function batchUnpin() {
  const ids = [...selectedManage];
  if (!ids.length) return;
  try {
    await api('unpin-batch', { stickerIds: ids });
    selectedManage = new Set();
    await reload(true);
    note('已移出收藏，原图还在图库里');
  } catch (error) { note(error.message); }
  render();
}
function selectCategory(id) {
  categoryFilter = categoryFilter === id ? '' : id;
  categoryArmedDelete = '';
  managing = false;
  selectedManage = new Set();
  $('gallery').scrollTop = 0;
  render();
}
// 删分类也是两步：先变「再点一次」，再点才真删。分类里的图不会被删，只是回到「全部收藏」。
async function armOrDeleteCategory(id) {
  if (categoryArmedDelete !== id) { categoryArmedDelete = id; render(); note('再点一次「删分类」才真的会删掉这个分类'); return; }
  categoryArmedDelete = '';
  try {
    await api('category-delete', { id });
    if (categoryFilter === id) { categoryFilter = ''; managing = false; }
    await reload(true);
    note('分类删掉了，里面的图还在收藏里');
  } catch (error) { note(error.message); }
  render();
}
// 新建分类 / 改分类名字，共用一个输入弹层
function openCategoryNameDialog(action, id = '', name = '') {
  const dialog = $('rename-category-dialog');
  $('rename-category-title').textContent = action === 'create' ? '新建分类' : '改分类名字';
  $('rename-category-hint').textContent = action === 'create'
    ? '给收藏里的图起个名字，比如「打工人」「想发给 ta 的」。'
    : '换个名字，图还留在这个分类里。';
  $('rename-category-save').textContent = action === 'create' ? '创建' : '保存';
  $('rename-category-name').value = name;
  $('rename-category-status').textContent = '';
  dialog.dataset.action = action;
  dialog.dataset.categoryId = id;
  dialog.showModal();
  const input = $('rename-category-name');
  input.focus(); input.select();
}
async function submitCategoryName() {
  const dialog = $('rename-category-dialog');
  const action = dialog.dataset.action || 'create';
  const name = $('rename-category-name').value.trim();
  if (!name) { $('rename-category-name').focus(); $('rename-category-status').textContent = '总得有个名字吧'; return; }
  $('rename-category-save').disabled = true;
  try {
    if (action === 'create') {
      const created = await api('category-create', { name });
      await reload(true);
      categoryFilter = created.category?.id || categoryFilter;
      note(`分类「${created.category?.name || name}」建好了`);
    } else {
      const renamed = await api('category-rename', { id: dialog.dataset.categoryId, name });
      await reload(true);
      note(`改名了：${renamed.category?.name || name}`);
    }
    dialog.close();
    render();
  } catch (error) {
    $('rename-category-status').textContent = error.message;
  } finally {
    $('rename-category-save').disabled = false;
  }
}
$('rename-category-save').onclick = () => { void submitCategoryName(); };
$('rename-category-cancel').onclick = () => $('rename-category-dialog').close();
$('rename-category-name').onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); void submitCategoryName(); }
  if (event.key === 'Escape') { event.preventDefault(); $('rename-category-dialog').close(); }
};
// 给某张图选分类：勾选哪些分类，或当场新建一个
function openCategoryDialog(id) {
  const item = catalog.find(item => item.id === id);
  if (!item) return;
  categoryMode = 'single'; categoryBatchIds = [];
  categoryTarget = id;
  categoryDraft = new Set(Array.isArray(item.categories) ? item.categories : []);
  $('category-dialog-title').textContent = '放进分类';
  $('category-status').textContent = '';
  $('category-new-name').value = '';
  renderCategoryList();
  $('category-dialog').showModal();
}
// 批量：把选中的那几张一起放进某些分类
function openBatchCategoryDialog() {
  const ids = [...selectedManage];
  if (!ids.length) return;
  categoryMode = 'batch'; categoryBatchIds = ids; categoryTarget = '';
  categoryDraft = new Set();
  $('category-dialog-title').textContent = `把 ${ids.length} 张放进分类`;
  $('category-status').textContent = '';
  $('category-new-name').value = '';
  renderCategoryList();
  $('category-dialog').showModal();
}
function renderCategoryList() {
  const list = $('category-list');
  const nodes = [];
  if (!categories.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '还没有分类。先在下面起一个名字。';
    nodes.push(empty);
  }
  for (const category of categories) {
    const row = document.createElement('div'); row.className = 'category-row';
    const label = document.createElement('label');
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = categoryDraft.has(category.id);
    box.addEventListener('change', () => { if (box.checked) categoryDraft.add(category.id); else categoryDraft.delete(category.id); });
    const name = document.createElement('span'); name.className = 'name'; name.textContent = category.name;
    const num = document.createElement('span'); num.className = 'n'; num.textContent = String(category.count);
    label.append(box, name, num);
    row.append(label);
    nodes.push(row);
  }
  list.replaceChildren(...nodes);
  const hint = $('category-hint');
  if (categoryMode === 'batch') {
    hint.textContent = categoryDraft.size
      ? `选中的 ${categoryBatchIds.length} 张会一起加进：${categories.filter(category => categoryDraft.has(category.id)).map(category => category.name).join('、')}`
      : `选中的 ${categoryBatchIds.length} 张还没选分类`;
    return;
  }
  const item = catalog.find(item => item.id === categoryTarget);
  const names = categories.filter(category => categoryDraft.has(category.id)).map(category => category.name);
  hint.textContent = item
    ? (names.length ? `现在在：${names.join('、')}` : '这张图还没进任何分类')
    : '';
}
$('category-new-add').onclick = async () => {
  const name = $('category-new-name').value.trim();
  if (!name) { $('category-new-name').focus(); $('category-status').textContent = '先给分类起个名字'; return; }
  $('category-new-add').disabled = true;
  try {
    const created = await api('category-create', { name });
    categories = [...categories, { ...created.category, count: 0 }];
    categoryDraft.add(created.category.id);
    $('category-new-name').value = '';
    renderCategoryList();  } catch (error) { $('category-status').textContent = error.message; }
  finally { $('category-new-add').disabled = false; }
};
$('category-new-name').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('category-new-add').click(); } };
$('category-save').onclick = async () => {
  if (categorySaving) return;
  categorySaving = true;
  $('category-save').disabled = true;
  try {
    if (categoryMode === 'batch') {
      await api('category-set-batch', { stickerIds: categoryBatchIds, categoryIds: [...categoryDraft] });
    } else {
      await api('category-set', { stickerId: categoryTarget, categoryIds: [...categoryDraft] });
    }
    await reload(true);
    $('category-dialog').close();
    note(categoryMode === 'batch' ? '都放进分类了' : '分类存好了');
  } catch (error) { $('category-status').textContent = error.message; }
  finally { categorySaving = false; $('category-save').disabled = false; }
};
$('category-cancel').onclick = () => $('category-dialog').close();
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
$('context-category').onclick = () => { const id = contextId; closeContextMenu(); if (id) openCategoryDialog(id); };
$('context-delete').onclick = () => { const id = contextId; closeContextMenu(); if (id) removeOriginal(id); };
window.addEventListener('pointerdown', event => { if (!$('context-menu').contains(event.target)) closeContextMenu(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape') closeContextMenu(); });
window.addEventListener('resize', closeContextMenu);
$('pinned').onclick = () => { mode = 'pinned'; managing = false; selectedManage = new Set(); $('gallery').scrollTop = 0; render(); };
$('library').onclick = () => { mode = 'library'; managing = false; selectedManage = new Set(); $('gallery').scrollTop = 0; render(); reload(true); };
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
// 仅可见时读共享数据，纸飞机改收藏后无需关闭重开面板。
const refresh = setInterval(() => { if (!document.hidden && !busy && !draggedId) reload(true); }, 8000);
// 面板被宿主收起或销毁时报一声：输入栅按钮下次被点才有依据判断该开还是该关。
function reportPanelHidden() {
  if (!ticket) return;
  try { navigator.sendBeacon('/api/sticker-compose/panel-hidden?ticket=' + encodeURIComponent(ticket)); } catch {}
}
try {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') reportPanelHidden(); });
} catch { /* 老宿主/砂箱里没有 addEventListener，不报活就算了 */ }
window.addEventListener('pagehide', () => { stickerPreview.dispose(); imageObserver?.disconnect(); clearInterval(refresh); reportPanelHidden(); for (const image of images.values()) image.then(url => { if (url) URL.revokeObjectURL(url); }); });
hana.ready();
