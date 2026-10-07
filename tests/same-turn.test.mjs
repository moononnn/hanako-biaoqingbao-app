// v0.1.2 回合限流回归：同一条用户消息驱动的长回复里，第二次发图必须被拒。
//
// 直接加载 lib/same-turn.js 源码（data: URL），避免给 App 根目录塞 package.json
// 影响宿主加载方式；测的就是真正跑起来的那份源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../lib/same-turn.js', import.meta.url), 'utf-8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf-8').toString('base64'));
const {
  isWithinSameTurn,
  markStickerSent,
  toTurnKey,
  resetSameTurnWindow,
  TEXT_SWITCH_GRACE_MS,
  FALLBACK_WINDOW_MS,
} = mod;

const AGENT = 'hanako';
const SESSION = 'C:\\sessions\\a.jsonl';

test.beforeEach(() => resetSameTurnWindow());

test('同一回合：隔五分钟再调也拒（今天翻车的就是这条）', () => {
  const t0 = 1_000_000;
  markStickerSent(AGENT, SESSION, { turnKey: '把茶话会做完', now: t0 });
  assert.equal(isWithinSameTurn(AGENT, SESSION, { turnKey: '把茶话会做完', now: t0 + 5 * 60_000 }), true);
  assert.equal(isWithinSameTurn(AGENT, SESSION, { turnKey: '把茶话会做完', now: t0 + 60 * 60_000 }), true);
});

test('同一回合：同一条消息文本（空白差异不算换回合）连发十几次只放一张', () => {
  const t0 = 5_000_000;
  const key = toTurnKey('我都在犹豫要不要删掉静默时段');
  markStickerSent(AGENT, SESSION, { turnKey: key, now: t0 });
  let allowed = 0;
  for (let i = 0; i < 15; i++) {
    if (!isWithinSameTurn(AGENT, SESSION, { turnKey: key, now: t0 + i * 30_000 })) allowed++;
  }
  assert.equal(allowed, 0);
});

test('新回合：用户换了消息内容，隔够时间就放行', () => {
  const t0 = 9_000_000;
  markStickerSent(AGENT, SESSION, { turnKey: '第一条', now: t0 });
  assert.equal(isWithinSameTurn(AGENT, SESSION, { turnKey: '第二条', now: t0 + TEXT_SWITCH_GRACE_MS + 1000 }), false);
});

test('锚点变了但离上一张很近：仍按同一串工具链挡掉', () => {
  const t0 = 11_000_000;
  markStickerSent(AGENT, SESSION, { turnKey: '第一条', now: t0 });
  assert.equal(isWithinSameTurn(AGENT, SESSION, { turnKey: '第二条', now: t0 + 10_000 }), true);
});

test('拿不到消息文本时退回旧时间窗，不放行也不误伤', () => {
  const t0 = 13_000_000;
  markStickerSent(AGENT, SESSION, { turnKey: null, now: t0 });
  assert.equal(isWithinSameTurn(AGENT, SESSION, { turnKey: null, now: t0 + 1000 }), true);
  assert.equal(isWithinSameTurn(AGENT, SESSION, { turnKey: null, now: t0 + FALLBACK_WINDOW_MS - 1 }), true);
  assert.equal(isWithinSameTurn(AGENT, SESSION, { turnKey: null, now: t0 + FALLBACK_WINDOW_MS + 1 }), false);
});

test('不同会话互不影响：别的窗口发图不挡这个窗口', () => {
  const t0 = 17_000_000;
  markStickerSent(AGENT, 'C:\\sessions\\other.jsonl', { turnKey: '别的窗口', now: t0 });
  assert.equal(isWithinSameTurn(AGENT, SESSION, { turnKey: '本窗口', now: t0 + 1000 }), false);
});

test('时钟回拨时保守挡住，不放行', () => {
  const t0 = 19_000_000;
  markStickerSent(AGENT, SESSION, { turnKey: 'x', now: t0 });
  assert.equal(isWithinSameTurn(AGENT, SESSION, { turnKey: 'x', now: t0 - 5000 }), true);
});

test('回合锚点归一：换行与多空格视为同一条，空白视为没有', () => {
  assert.equal(toTurnKey('  早安\n\n  睡得好吗  '), toTurnKey('早安 睡得好吗'));
  assert.equal(toTurnKey('   '), null);
  assert.equal(toTurnKey(null), null);
  assert.equal(toTurnKey(undefined), null);
  assert.equal(toTurnKey('a'.repeat(500)).length, 300);
});

test('长期运行不无限增长：写入超过上限的键后仍能正常工作', () => {
  const t0 = 21_000_000;
  for (let i = 0; i < 260; i++) {
    markStickerSent(AGENT, `C:\\sessions\\s${i}.jsonl`, { turnKey: `k${i}`, now: t0 });
  }
  markStickerSent(AGENT, SESSION, { turnKey: '最后一轮', now: t0 });
  assert.equal(isWithinSameTurn(AGENT, SESSION, { turnKey: '最后一轮', now: t0 + 1000 }), true);
});
