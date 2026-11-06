// 权限沙箱下的数据目录初始化 — 2026-11-06 issue #3 回归
//
// 事故经过：App 子进程由宿主用 Node `--permission` 拉起，只放行 apps/biaoqingbao-app
// 和 app-data/biaoqingbao-app 两个根。`migrateDataDir()` 里探测
// `<HANA_HOME>/plugin-backups/biaoqingbao` 时越界，Node 权限模型下 `fs.existsSync()`
// 对白名单外的路径**抛 ERR_ACCESS_DENIED**，不返回 false。异常被最外层 catch 吞掉，
// 整个迁移/初始化就此中断，于是所有走 `atomicWriteJson()` 的写接口全挂
// （设置页四个模型配置、图库索引、偏好、频率），前端只看到一句固定的「初始化失败」。
//
// 背光：看不见要当没有，不能当出错。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-sandbox-'));
const dataDir = path.join(root, 'app-data', 'biaoqingbao-app');
const backupRoot = path.join(root, 'plugin-backups', 'biaoqingbao');
process.env.BQB_DATA_DIR = dataDir;
process.env.HANA_HOME = root;

const shared = await import('../lib/shared.js');
const realExistsSync = fs.existsSync;

function denyAccessTo(prefixes) {
  fs.existsSync = function patched(target) {
    const text = String(target);
    if (prefixes.some((p) => text === p || text.startsWith(p + path.sep))) {
      const error = new Error('Access to this API has been restricted. Use --allow-fs-read to manage permissions.');
      error.code = 'ERR_ACCESS_DENIED';
      throw error;
    }
    return realExistsSync.call(fs, target);
  };
}

function restoreExistsSync() {
  fs.existsSync = realExistsSync;
}

after(() => {
  restoreExistsSync();
  fs.rmSync(root, { recursive: true, force: true });
});

const noLegacy = {
  legacyDataDir: path.join(root, 'no-legacy-data'),
  legacyStickersDir: path.join(root, 'no-legacy-stickers'),
};

test('备份目录在沙箱外：看得见当没有，初始化照旧成功', () => {
  denyAccessTo([path.join(root, 'plugin-backups')]);
  try {
    const result = shared.migrateDataDir(noLegacy);
    assert.deepEqual(
      { ok: result.ok, source: result.source },
      { ok: true, source: 'fresh' },
      `越界探测不该打断初始化，实际：${JSON.stringify(result)}`,
    );
  } finally {
    restoreExistsSync();
  }
});

test('备份目录在沙箱外：写配置不再报「初始化或旧数据恢复失败」', () => {
  denyAccessTo([path.join(root, 'plugin-backups')]);
  const target = path.join(dataDir, 'vision-config.json');
  try {
    shared.atomicWriteJson(target, { source: 'hana', providerId: 'x' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { source: 'hana', providerId: 'x' });
  } finally {
    restoreExistsSync();
  }
});

test('沙箱外探测不再被吞成静默失败：其它异常仍然照实报错', () => {
  fs.existsSync = function patched(target) {
    if (String(target).startsWith(noLegacy.legacyDataDir)) {
      const error = new Error('EPERM: operation not permitted');
      error.code = 'EPERM';
      throw error;
    }
    return realExistsSync.call(fs, target);
  };
  try {
    const fresh = path.join(root, 'fresh-check');
    const result = shared.migrateDataDir({
      dataDir: fresh,
      stickersDir: path.join(fresh, 'stickers'),
      ...noLegacy,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EPERM');
    assert.match(result.error, /EPERM/);
  } finally {
    restoreExistsSync();
  }
});

test('旧位置数据在沙箱内：迁移照旧走通（新增分支没把正常路径挡掉）', () => {
  // 真实布局是兄弟目录（plugin/data 与 plugin/stickers），不是嵌套。
  const legacyData = path.join(root, 'legacy-src', 'data');
  const legacyStickers = path.join(root, 'legacy-src', 'stickers');
  const dest = path.join(root, 'legacy-dest');
  fs.mkdirSync(legacyData, { recursive: true });
  fs.mkdirSync(legacyStickers, { recursive: true });
  fs.mkdirSync(path.join(dest, 'stickers'), { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(legacyStickers, 'stk_001.png'), png);
  fs.writeFileSync(path.join(legacyData, 'stickers.json'), JSON.stringify([{ id: 'stk_001', file: 'stk_001.png' }]));

  denyAccessTo([path.join(root, 'plugin-backups')]);
  try {
    const result = shared.migrateDataDir({
      dataDir: dest,
      stickersDir: path.join(dest, 'stickers'),
      legacyDataDir: legacyData,
      legacyStickersDir: legacyStickers,
    });
    assert.deepEqual({ ok: result.ok, source: result.source }, { ok: true, source: 'legacy-plugin-dir' });
    assert.ok(fs.existsSync(path.join(dest, 'stickers.json')));
    assert.ok(fs.existsSync(path.join(dest, 'stickers', 'stk_001.png')));
  } finally {
    restoreExistsSync();
  }
});
