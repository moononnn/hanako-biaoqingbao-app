// scripts/backfill-occasions.mjs - 给老图补 occasion（场合锁）
//
// 为什么要有这一步：v0.8.0 之前图库没有 occasion 字段，门禁对全部老图都不生效。
// 场上真实情况是「早安图只在早上的对话里能用」，这个信息以前只散落在 scene / keywords 里，
// 没有任何地方把它当硬约束用。
//
// 这个脚本只做机械筛选，不下结论：
//   默认干跑，列出「画面描述/语义描述里出现场合词」的图，人工看过再决定标哪几张。
//   加 --apply 才写进 stickers.json，且只写脚本判定的那批。
//
// 判定为什么保守：标错的代价是这张图再也出不来，比漏标严重得多。
// 所以只认「描述里出现场合词」这一条硬证据，不靠 scene 里随手的「早安」标签去推。
//
// 用法：
//   node scripts/backfill-occasions.mjs            # 干跑，打印候选
//   node scripts/backfill-occasions.mjs --apply    # 写入
//   node scripts/backfill-occasions.mjs --apply --only stk_494,stk_331
import fs from 'node:fs';
import { META_FILE } from '../lib/shared.js';
import { normalizeOccasion, occasionSet, occasionsInText, OCCASION_NAMES } from '../lib/occasion-gate.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlyArg = args.find((a) => a.startsWith('--only'));
const only = onlyArg
  ? new Set(String(onlyArg.split('=')[1] ?? args[args.indexOf(onlyArg) + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  : null;

const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
if (!Array.isArray(meta)) throw new Error('图库索引不是数组，先检查文件');

const rows = [];
for (const sticker of meta) {
  const text = [sticker?.description, sticker?.semantic_description].filter(Boolean).join(' ');
  if (!text) continue;
  const hits = [...occasionsInText(text)];
  if (!hits.length) continue;
  rows.push({
    id: sticker.id,
    hits,
    current: Array.isArray(sticker.occasion) ? sticker.occasion : [],
    description: String(sticker.description || '').slice(0, 40),
    scene: (sticker.tags?.scene || []).join('/'),
  });
}

const wordCount = new Map();
for (const row of rows) for (const hit of row.hits) wordCount.set(hit, (wordCount.get(hit) || 0) + 1);
console.log(`图库 ${meta.length} 张，描述里出现场合词的 ${rows.length} 张`);
console.log(`按场合分布：${[...wordCount].map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`可用场合组：${OCCASION_NAMES.join('、')}\n`);

const targets = rows.filter((row) => !only || only.has(row.id));
for (const row of targets) {
  const mark = row.current.length ? `已标[${row.current.join('/')}]` : '未标';
  console.log(`${row.id}  ${mark}  判定=${row.hits.join('/')}  scene=${row.scene}\n    ${row.description}`);
}

if (!apply) {
  console.log(`\n干跑结束，没有写入。确认后加 --apply${only ? `（本次 --only 限定 ${only.size} 张）` : ''}。`);
  process.exit(0);
}

let written = 0;
for (const row of targets) {
  const sticker = meta.find((s) => s?.id === row.id);
  if (!sticker) continue;
  // 只写词表内的组名，和识图入库那条链保持同一套口径
  const locked = [...occasionSet(row.hits)];
  if (!locked.length) continue;
  sticker.occasion = locked;
  written += 1;
}
const backup = `${META_FILE}.bak-occasions-${Date.now()}`;
fs.copyFileSync(META_FILE, backup);
fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
console.log(`\n已写入 ${written} 张，原文件备份在 ${backup}`);
console.log('注意：本次只动了 stickers.json。图库里这些图的向量不需要重建（向量按语义描述算，场合锁是另一套判定）。');