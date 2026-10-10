// scripts/build-release.mjs — 打一个「干净」的发布包
//
// 做四件事：
//   1. 把项目复制到临时目录，排除运行时数据、备份、日志、缓存这些不该外传的东西；
//   2. 剥掉带 #release-strip-start / #release-strip-end 标记的开发期入口（本地正式目录保留，只动副本）；
//   3. 剥完再 grep 一遍确认没有残留（剥了但没剥干净，比不剥更糟）；
//   4. 打成 zip、算 SHA-256、打印体积。
//
// 用法：node scripts/build-release.mjs [--out <输出目录>]
// 默认输出到 <工作台>/_releases/biaoqingbao-app/，产物名 biaoqingbao-app-v<版本>.zip

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// 不进发布包的东西：运行时数据、备份、依赖、日志、缓存、打包产物
const EXCLUDE_DIRS = new Set(['.git', '.github', '_backups', 'node_modules', '__pycache__', '.pytest_cache', '.cache', 'dist']);
const EXCLUDE_FILES = new Set(['x.json', 'package-lock.json', 'PROJECT_LOG.md', 'data.json', 'preferences.json']);
const EXCLUDE_EXT = new Set(['.log', '.zip', '.bak', '.pyc']);
// 开发期留下的现场文件（名字里带这些词的一律不进包）
const EXCLUDE_NAME_HINT = [/debug/i, /^probe\./i];

// 必须从发布包里消失的字眼：剥完拿它们复查
const FORBIDDEN_AFTER_STRIP = ['_dev/deliver-test', 'dev-deliver'];

// sdk/ 里只带运行时真用到的这几个文件（相对 sdk/ 的路径）。
// 其余是宿主发的完整 SDK 副本：UI 组件库、版式与预览模块、类型声明（.ts）、sourcemap（.map）。
// 页面走的是 ui/assets/ 里那套打好的，服务端只通过入口静态 import 用到下面这六个；
// 完整副本在本地和仓库里都留着。改了 sdk 的引用，记得同步这张表。
const SDK_KEEP = new Set([
  'app-bus-contract.js',
  'app-contract/bus-requests.js',
  'app-contract/model-stream.js',
  'app-contract/rpc-error.js',
  'app-contract/sdk-error.js',
  'app-contract/server-client.js',
]);

// 剥离和复查都只扫这些地方：代码与页面。
// scripts/ 里是构建脚本自己（文字里天然带着这些标记词），tests/ 是开发期测试，sdk/ 是宿主发的 SDK 副本，
// 它们不参与剥离，也不参与残留复查。
const SCAN_SKIP_DIRS = new Set(['scripts', 'tests', 'sdk', 'node_modules', '.git']);

function parseArgs(argv) {
  // 默认输出到项目内的 dist/（不写死任何本机路径）；要放别处用 --out 指定，
  // 比如：--out <工作台>/_releases/biaoqingbao-app
  const out = { out: path.resolve(ROOT, 'dist') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) { out.out = argv[i + 1]; i += 1; }
  }
  return out;
}

function readVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  if (!manifest?.version) throw new Error('manifest.json 里没有 version');
  return { version: manifest.version, id: manifest.id || 'app' };
}

function shouldSkip(name, isDir) {
  if (isDir) return EXCLUDE_DIRS.has(name);
  if (EXCLUDE_FILES.has(name)) return true;
  if (EXCLUDE_EXT.has(path.extname(name).toLowerCase())) return true;
  return EXCLUDE_NAME_HINT.some((re) => re.test(name));
}

function copyTree(from, to, rel = '') {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (shouldSkip(entry.name, entry.isDirectory())) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    // sdk/ 只带白名单里的文件，目录本身继续走进筛
    if (entry.isFile() && relPath.startsWith('sdk/') && !SDK_KEEP.has(relPath.slice(4))) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst, relPath);
    else fs.copyFileSync(src, dst);
  }
}

// 删掉成对的标记块（含标记本身）。两块之间没有嵌套，直接按行处理。
function stripDevEntries(dir) {
  const stripped = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (!text.includes('#release-strip-start')) continue;
      const lines = text.split(/\r?\n/);
      const kept = [];
      let inside = false;
      for (const line of lines) {
        const hasStart = line.includes('#release-strip-start');
        const hasEnd = line.includes('#release-strip-end');
        if (hasStart && hasEnd) continue;   // 同一行同时出现（写在注释里）：只删这一行，不开关状态
        if (hasStart) { inside = true; continue; }
        if (hasEnd) { inside = false; continue; }
        if (!inside) kept.push(line);
      }
      fs.writeFileSync(full, kept.join('\n'));
      stripped.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return stripped;
}

function findForbidden(dir) {
  const hits = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      // 只查代码和页面；文档里提到这些名字是正常的（发布契约里就写着要剥掉它）
      if (!/\.(js|mjs|cjs|html)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const word of FORBIDDEN_AFTER_STRIP) {
        if (text.includes(word)) hits.push(`${path.relative(dir, full)} → ${word}`);
      }
    }
  };
  walk(dir);
  return hits;
}

function zipDir(sourceDir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  // 优先用 7z（失败会清掉产物）；没有就退回 PowerShell 的 Compress-Archive，
  // 但压缩完必须核对体积，历史上它失败时留下过巨大的空壳文件。
  const sevenZip = ['7z', 'C:/Program Files/7z/7z.exe', 'C:/Program Files/7-Zip/7z.exe']
    .find((candidate) => {
      try { execFileSync(candidate, ['i'], { stdio: 'ignore' }); return true; } catch { return false; }
    });
  if (sevenZip) {
    execFileSync(sevenZip, ['a', '-tzip', '-mx=9', zipPath, '.'], { cwd: sourceDir, stdio: 'inherit' });
  } else {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${zipPath}' -Force`], { stdio: 'inherit' });
  }
  const size = fs.statSync(zipPath).size;
  if (size < 200 * 1024) throw new Error(`压缩产物只有 ${Math.round(size / 1024)}KB，看着不对，先别发：${zipPath}`);
  return size;
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const { version } = readVersion();
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-release-'));
  const stageDir = path.join(stageRoot, 'biaoqingbao-app');

  console.log(`[1/5] 复制项目（排除运行时数据、备份、日志、缓存）→ ${stageDir}`);
  copyTree(ROOT, stageDir);

  console.log('[2/5] 剥掉开发期入口');
  const stripped = stripDevEntries(stageDir);
  console.log(stripped.length ? `      已剥：${stripped.join(', ')}` : '      没有找到标记块（确认本地 index.js 里还有 #release-strip-start）');

  console.log('[3/5] 复查残留');
  const hits = findForbidden(stageDir);
  if (hits.length) {
    console.error('❌ 剥离后仍有开发入口残留，先别打包：');
    for (const hit of hits) console.error('   ' + hit);
    process.exitCode = 1;
    return;
  }
  console.log('      OK，没有残留');

  console.log('[4/5] 打 zip');
  const zipPath = path.join(out, `biaoqingbao-app-v${version}.zip`);
  const size = zipDir(stageDir, zipPath);
  console.log(`      ${zipPath}（${(size / 1024 / 1024).toFixed(2)} MB）`);

  console.log('[5/5] 算 SHA-256');
  const hash = createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  console.log(`      ${hash}`);

  console.log('\n接下来：');
  console.log(`  1) 对着这个 zip 走一遍发布前交叉审查（plugin-dev-guide skill 的 references/17-release-cross-review.md）`);
  console.log(`  2) push → 等 CI 全绿 → 建 Release，附上这个 zip 和上面的 SHA-256`);
  console.log(`  3) 核对仓库地址：server/api.js 里的 REPO、NOTICE、README 的反馈链接`);
  fs.rmSync(stageRoot, { recursive: true, force: true });
}

main();
