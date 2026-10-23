// 收藏分类：我的收藏里自己分的类。
// 跟图库分组（sticker-groups.json）是两回事：图库分组管的是整个图库，
// 收藏分类只管「我的收藏」这一份，收藏里的图可以同时进好几个分类。
// 独立存一个文件，不动 ball-config.json —— 那边是纸飞机、悬浮球和收藏顺序共用的。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, atomicWriteJson } from './shared.js';

export const CATEGORIES_FILE_NAME = 'favorite-categories.json';
export const CATEGORY_STORE_VERSION = 1;
export const MAX_CATEGORIES = 60;
export const MAX_CATEGORY_NAME_LENGTH = 40;
export const MAX_STICKERS_PER_CATEGORY = 500;

const CATEGORY_STORE_STATUS = Symbol('category-store-status');

export function categoryStorePath(dataDir = DATA_DIR) {
  return path.join(dataDir, CATEGORIES_FILE_NAME);
}

export function emptyCategoryStore() {
  return { version: CATEGORY_STORE_VERSION, categories: [] };
}

export function isCategoryStoreReadable(store) {
  return store?.[CATEGORY_STORE_STATUS]?.ok !== false;
}

export function getCategoryStoreError(store) {
  return isCategoryStoreReadable(store) ? '' : String(store?.[CATEGORY_STORE_STATUS]?.error || '收藏分类文件读取失败');
}

function markCategoryStoreStatus(store, status) {
  Object.defineProperty(store, CATEGORY_STORE_STATUS, {
    value: status, enumerable: false, configurable: false, writable: false,
  });
  return store;
}

function corruptCategoryStore(error) {
  return markCategoryStoreStatus(emptyCategoryStore(), {
    ok: false,
    error: error?.message || String(error || '收藏分类文件格式无效'),
  });
}

function safeId(value) {
  const id = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : '';
}

function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CATEGORY_NAME_LENGTH);
}

function safeTimestamp(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function normalizeCategories(rawCategories) {
  const categories = [];
  const seen = new Set();
  const source = Array.isArray(rawCategories) ? rawCategories.slice(0, MAX_CATEGORIES * 2) : [];
  for (const raw of source) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = safeId(raw.id);
    const name = cleanName(raw.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const stickerIds = [];
    const used = new Set();
    const rawIds = Array.isArray(raw.stickerIds) ? raw.stickerIds : [];
    for (const value of rawIds) {
      if (stickerIds.length >= MAX_STICKERS_PER_CATEGORY) break;
      const stickerId = String(value ?? '').trim();
      if (!stickerId || used.has(stickerId)) continue;
      used.add(stickerId);
      stickerIds.push(stickerId);
    }
    categories.push({
      id,
      name,
      stickerIds,
      created_at: safeTimestamp(raw.created_at),
      updated_at: safeTimestamp(raw.updated_at),
    });
  }
  return categories;
}

export function normalizeCategoryStore(store) {
  return {
    version: CATEGORY_STORE_VERSION,
    categories: normalizeCategories(store?.categories),
  };
}

// 缺失文件 = 还没建过分类，属于正常空库；读不出来或格式不对必须显式标出来，
// 不能当成「没有分类」把她的分类悄悄抹掉。
export function readCategoryStore(dataDir = DATA_DIR) {
  try {
    const raw = JSON.parse(fs.readFileSync(categoryStorePath(dataDir), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return corruptCategoryStore(new Error('收藏分类文件格式无效'));
    }
    return normalizeCategoryStore(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyCategoryStore();
    return corruptCategoryStore(error);
  }
}

export function writeCategoryStore(store, dataDir = DATA_DIR) {
  const normalized = normalizeCategoryStore(store);
  atomicWriteJson(categoryStorePath(dataDir), normalized);
  return normalized;
}

export function createCategory(store, name, { id = '', now = new Date().toISOString() } = {}) {
  const current = normalizeCategoryStore(store);
  const label = cleanName(name);
  if (!label) return { ok: false, error: '分类得有个名字' };
  if (current.categories.length >= MAX_CATEGORIES) {
    return { ok: false, error: `最多只能建 ${MAX_CATEGORIES} 个分类` };
  }
  if (current.categories.some(category => category.name === label)) {
    return { ok: false, error: `已经有叫「${label}」的分类了` };
  }
  const categoryId = safeId(id) || `cat_${crypto.randomUUID()}`;
  if (current.categories.some(category => category.id === categoryId)) {
    return { ok: false, error: '这个分类编号已经用过了' };
  }
  const category = { id: categoryId, name: label, stickerIds: [], created_at: now, updated_at: now };
  return { ok: true, store: { ...current, categories: [...current.categories, category] }, category };
}

export function renameCategory(store, id, name) {
  const current = normalizeCategoryStore(store);
  const categoryId = safeId(id);
  if (!categoryId) return { ok: false, error: '分类编号不对' };
  const label = cleanName(name);
  if (!label) return { ok: false, error: '分类得有个名字' };
  const target = current.categories.find(category => category.id === categoryId);
  if (!target) return { ok: false, error: '这个分类不在了' };
  if (label === target.name) return { ok: true, store: current, category: target, unchanged: true };
  if (current.categories.some(category => category.id !== categoryId && category.name === label)) {
    return { ok: false, error: `已经有叫「${label}」的分类了` };
  }
  const categories = current.categories.map(category => (
    category.id === categoryId
      ? { ...category, name: label, updated_at: new Date().toISOString() }
      : category
  ));
  return { ok: true, store: { ...current, categories }, category: categories.find(category => category.id === categoryId) };
}

// 删分类不删图：分类里的图还在收藏里，只是不再属于任何分类。
export function deleteCategory(store, id) {
  const current = normalizeCategoryStore(store);
  const categoryId = safeId(id);
  if (!categoryId) return { ok: false, error: '分类编号不对' };
  if (!current.categories.some(category => category.id === categoryId)) {
    return { ok: false, error: '这个分类不在了' };
  }
  return {
    ok: true,
    store: { ...current, categories: current.categories.filter(category => category.id !== categoryId) },
  };
}

// 把一张图放进哪几个分类。分类里没有的图会顺手从分类里清掉，
// 免得收藏里早就没有的图还留着占位置。
export function setStickerCategories(store, stickerId, categoryIds) {
  const current = normalizeCategoryStore(store);
  const id = String(stickerId ?? '').trim();
  if (!id) return { ok: false, error: '表情包编号不对' };
  const wanted = new Set();
  for (const value of Array.isArray(categoryIds) ? categoryIds : []) {
    const categoryId = safeId(value);
    if (categoryId && current.categories.some(category => category.id === categoryId)) wanted.add(categoryId);
  }
  const categories = current.categories.map(category => {
    const has = wanted.has(category.id);
    const list = has
      ? (category.stickerIds.includes(id) ? category.stickerIds : [...category.stickerIds, id])
      : category.stickerIds.filter(value => value !== id);
    if (list.length === category.stickerIds.length && list.every((value, index) => value === category.stickerIds[index])) {
      return category;
    }
    return { ...category, stickerIds: list, updated_at: new Date().toISOString() };
  });
  return { ok: true, store: { ...current, categories } };
}

// 批量：给这几张图「加上」这些分类（保留它们原有的其它分类）。
export function mergeStickerCategories(store, stickerIds, categoryIds) {
  const current = normalizeCategoryStore(store);
  const ids = [...new Set((Array.isArray(stickerIds) ? stickerIds : [])
    .map(value => String(value ?? '').trim())
    .filter(Boolean))];
  if (!ids.length) return { ok: false, error: '没选中图' };
  const wanted = new Set();
  for (const value of Array.isArray(categoryIds) ? categoryIds : []) {
    const categoryId = safeId(value);
    if (categoryId && current.categories.some(category => category.id === categoryId)) wanted.add(categoryId);
  }
  if (!wanted.size) return { ok: false, error: '没选分类' };
  const categories = current.categories.map(category => {
    if (!wanted.has(category.id)) return category;
    let list = category.stickerIds;
    let changed = false;
    for (const id of ids) {
      if (list.includes(id)) continue;
      if (list.length >= MAX_STICKERS_PER_CATEGORY) break;
      list = [...list, id];
      changed = true;
    }
    return changed ? { ...category, stickerIds: list, updated_at: new Date().toISOString() } : category;
  });
  return { ok: true, store: { ...current, categories } };
}

// 批量：从某个分类里把这几张图移出去（只动这个分类，图还在收藏里）。
export function removeStickerFromCategory(store, stickerIds, categoryId) {
  const current = normalizeCategoryStore(store);
  const id = safeId(categoryId);
  if (!id) return { ok: false, error: '分类编号不对' };
  const drop = new Set((Array.isArray(stickerIds) ? stickerIds : [])
    .map(value => String(value ?? '').trim())
    .filter(Boolean));
  if (!drop.size) return { ok: false, error: '没选中图' };
  const categories = current.categories.map(category => {
    if (category.id !== id) return category;
    const list = category.stickerIds.filter(value => !drop.has(value));
    if (list.length === category.stickerIds.length) return category;
    return { ...category, stickerIds: list, updated_at: new Date().toISOString() };
  });
  return { ok: true, store: { ...current, categories } };
}

// 收藏里移除某张图时，分类里也要跟着去掉——分类是收藏的子集，不能留着幽灵。
export function removeStickerFromCategories(store, stickerId) {
  const current = normalizeCategoryStore(store);
  const id = String(stickerId ?? '').trim();
  if (!id) return { ok: true, store: current };
  const categories = current.categories.map(category => (
    category.stickerIds.includes(id)
      ? { ...category, stickerIds: category.stickerIds.filter(value => value !== id), updated_at: new Date().toISOString() }
      : category
  ));
  return { ok: true, store: { ...current, categories } };
}

// 读出来的时候按收藏过滤一遍：分类里存了不在收藏里的图（老数据、手工改过文件），
// 不该出现在界面上。
export function categoryRows(store, pinnedIds) {
  const current = normalizeCategoryStore(store);
  const pinned = new Set(Array.isArray(pinnedIds) ? pinnedIds : []);
  return current.categories.map(category => ({
    id: category.id,
    name: category.name,
    stickerIds: category.stickerIds.filter(id => pinned.has(id)),
  }));
}

// 某张图在哪些分类里。
export function categoriesOfSticker(rows, stickerId) {
  const id = String(stickerId ?? '').trim();
  if (!id) return [];
  return (Array.isArray(rows) ? rows : []).filter(row => row.stickerIds.includes(id)).map(row => row.id);
}
