// tests/host-sticker-writer.test.mjs
// 宿主闲聊表情包写入层（lib/host-sticker-writer.js）。
// 只测纯逻辑：multipart 组包、上传文件形状、token 读取的几种形状。
// 真机链路（loopback 真调宿主）已单独验过，不在这里假装能测。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  readServerInfo,
  buildMultipartBody,
  toUploadFile,
  createHostStickerClient,
  HOST_PACK_MAX,
  HOST_INJECT_LIMIT,
} from '../lib/host-sticker-writer.js';

const DATA_DIR = path.join('/tmp', 'app-data', 'biaoqingbao-app');
const HOME = path.join('/tmp', 'app-data');   // dataDir 的上两级

function fakeResources(content) {
  return {
    read: async () => ({ content }),
  };
}

test('读 server-info：字符串内容', async () => {
  const json = JSON.stringify({ port: 14500, token: 'abc123' });
  const info = await readServerInfo({ resources: fakeResources(json), dataDir: DATA_DIR });
  assert.equal(info.port, 14500);
  assert.equal(info.token, 'abc123');
});

test('读 server-info：Buffer 内容', async () => {
  const json = JSON.stringify({ port: 14500, token: 'abc123' });
  const info = await readServerInfo({
    resources: fakeResources(Buffer.from(json, 'utf8')),
    dataDir: DATA_DIR,
  });
  assert.equal(info.port, 14500);
  assert.equal(info.token, 'abc123');
});

test('读 server-info：字节数组内容', async () => {
  const json = JSON.stringify({ port: 14500, token: 'abc123' });
  const info = await readServerInfo({
    resources: fakeResources({ data: [...Buffer.from(json, 'utf8')] }),
    dataDir: DATA_DIR,
  });
  assert.equal(info.port, 14500);
});

test('读 server-info：token 会去掉首尾空白', async () => {
  const json = JSON.stringify({ port: 14500, token: '  abc123  ' });
  const info = await readServerInfo({ resources: fakeResources(json), dataDir: DATA_DIR });
  assert.equal(info.token, 'abc123');
});

test('读 server-info：缺端口就报错，不返回半截信息', async () => {
  const json = JSON.stringify({ token: 'abc123' });
  await assert.rejects(
    () => readServerInfo({ resources: fakeResources(json), dataDir: DATA_DIR }),
    /形状不对/,
  );
});

test('读 server-info：内容是空的就报错', async () => {
  await assert.rejects(
    () => readServerInfo({ resources: fakeResources(''), dataDir: DATA_DIR }),
    /空的/,
  );
});

test('读 server-info：没有资源通道就报错', async () => {
  await assert.rejects(
    () => readServerInfo({ resources: null, dataDir: DATA_DIR }),
    /资源通道/,
  );
});

test('multipart：字段名是 files，boundary 前后闭合', () => {
  const { boundary, body } = buildMultipartBody([
    { name: 'a.png', type: 'image/png', bytes: Buffer.from([1, 2, 3]) },
  ]);
  const text = body.toString('binary');
  assert.ok(text.includes(`--${boundary}\r\n`), '开头有 boundary');
  assert.ok(text.includes('name="files"'), '字段名是 files');
  assert.ok(text.includes('filename="a.png"'), '带文件名');
  assert.ok(text.includes('Content-Type: image/png'), '带类型');
  assert.ok(text.endsWith(`--${boundary}--\r\n`), '结尾闭合');
});

test('multipart：多个文件拼在一起', () => {
  const { body } = buildMultipartBody([
    { name: 'a.png', bytes: Buffer.from('A') },
    { name: 'b.png', bytes: Buffer.from('B') },
  ]);
  const text = body.toString('binary');
  assert.ok(text.includes('filename="a.png"'));
  assert.ok(text.includes('filename="b.png"'));
});

test('multipart：一个文件都不给就报错', () => {
  assert.throws(() => buildMultipartBody([]), /没有要上传/);
  assert.throws(() => buildMultipartBody(null), /没有要上传/);
});

test('上传文件：文件名里的怪字符换成下划线', () => {
  const file = toUploadFile({ file: 'a b/c?.png', description: '一张图' }, Buffer.from([1]));
  assert.equal(file.name, 'a_b_c_.png');
  assert.ok(!file.name.includes('/'), '不带路径分隔符');
  assert.ok(!file.name.includes('?'), '不带问号');
});

test('上传文件：备注取 description，没有就退到语义描述', () => {
  const a = toUploadFile({ file: 'x.png', description: '捧着杯子喝茶' }, Buffer.from([1]));
  assert.equal(a.note, '捧着杯子喝茶');
  const b = toUploadFile({ file: 'x.png', semantic_description: '在听，不着急' }, Buffer.from([1]));
  assert.equal(b.note, '在听，不着急');
});

test('上传文件：两个描述都没有，备注留空（宿主允许空 note）', () => {
  const c = toUploadFile({ file: 'x.png' }, Buffer.from([1]));
  assert.equal(c.note, '');
});

test('上传文件：默认给个兜底文件名，别让宿主拿空名收', () => {
  const c = toUploadFile({}, Buffer.from([1]));
  assert.ok(c.name && c.name.length > 0);
});

test('宿主上限常量跟宿主实际一致（每包 300、注入 60）', () => {
  assert.equal(HOST_PACK_MAX, 300);
  assert.equal(HOST_INJECT_LIMIT, 60);
});

test('发送自查：逐个按宿主给的文件名去取，取得到才算数', async () => {
  const asked = [];
  const client = await createHostStickerClient({
    sdk: {
      network: {
        fetch: async (url, init = {}) => {
          asked.push(url);
          const ok = !url.includes('bad.webp');
          return { ok, status: ok ? 200 : 404, text: async () => '' };
        },
      },
      resources: fakeResources(JSON.stringify({ port: 14500, token: 'tok' })),
    },
    dataDir: DATA_DIR,
  });
  const result = await client.verifyStickerFiles('pack-1', ['a.webp', 'bad.webp', 'c.webp']);
  assert.equal(result.total, 3);
  assert.equal(result.ok, 2);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].file, 'bad.webp');
  assert.ok(asked.every((url) => url.includes('/api/casual/stickers/file/pack-1/')), '按包的取图接口逐个取');
});

test('发送自查：一个文件都没有时不报错，直接报空', async () => {
  const client = await createHostStickerClient({
    sdk: {
      network: { fetch: async () => ({ ok: true, status: 200, text: async () => '' }) },
      resources: fakeResources(JSON.stringify({ port: 14500, token: 'tok' })),
    },
    dataDir: DATA_DIR,
  });
  const result = await client.verifyStickerFiles('pack-1', []);
  assert.deepEqual(result, { total: 0, ok: 0, missing: [] });
});

test('刷新宿主面板：先读当前启用状态，再原样写回', async () => {
  const calls = [];
  const client = await createHostStickerClient({
    sdk: {
      network: {
        fetch: async (url, init = {}) => {
          calls.push({ url, method: init.method || 'GET', body: init.body });
          const json = url.endsWith('/enabled')
            ? { hostEnabled: false }
            : { hostEnabled: false };
          return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
        },
      },
      resources: fakeResources(JSON.stringify({ port: 14500, token: 'tok' })),
    },
    dataDir: DATA_DIR,
  });
  await client.refreshHostPanel('pack-1');
  const get = calls.find((c) => c.method === 'GET');
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(get, '先读一次当前状态');
  assert.ok(put, '再写回一次');
  assert.ok(put.url.includes('sticker-pack%3Apack-1'), 'ref 里带分类前缀并编码');
  // 读到的状态是 false，就得写回 false，不能顺手把停用的包打开。
  assert.equal(JSON.parse(put.body).enabled, false, '写回的是原状态');
});

test('刷新宿主面板：读不到状态时按启用写回，不报错', async () => {
  const calls = [];
  const client = await createHostStickerClient({
    sdk: {
      network: {
        fetch: async (url, init = {}) => {
          calls.push({ url, method: init.method || 'GET', body: init.body });
          if ((init.method || 'GET') === 'GET') {
            return { ok: false, status: 404, text: async () => '{"error":"没有这个分类"}' };
          }
          return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
        },
      },
      resources: fakeResources(JSON.stringify({ port: 14500, token: 'tok' })),
    },
    dataDir: DATA_DIR,
  });
  await client.refreshHostPanel('pack-1');
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put, '还是发出去了');
  assert.equal(JSON.parse(put.body).enabled, true, '读不到就按启用写');
});
