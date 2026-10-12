// QQ Bridge 配图附件：工具结果的 details.media 由宿主 BridgeManager 转为 QQ 媒体消息。
// 测试只模拟 App Bus，不注册真实 SessionFile、不向 QQ 发消息。

import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const root = path.join(os.tmpdir(), `bqb-bridge-media-${process.pid}`);
const dataDir = path.join(root, 'app-data');
mkdirSync(dataDir, { recursive: true });
process.env.BQB_DATA_DIR = dataDir;

after(() => rmSync(root, { recursive: true, force: true }));

const { createStickerToolCard, __resetSessionIdCacheForTests } = await import('../lib/sticker-delivery.js');

beforeEach(() => __resetSessionIdCacheForTests());

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const imagePath = path.join(root, 'sticker.png');
writeFileSync(imagePath, PNG);
const bridgePath = 'C:/x/agents/hanako/sessions/bridge/owner/qq.jsonl';
const nativePath = 'C:/x/agents/hanako/sessions/native.jsonl';
const STAGED_MEDIA_ITEM = {
  type: 'session_file', fileId: 'sf_bridge_test', sessionId: 'sess_bridge_test', mime: 'image/png',
};

function makeSdk({ stageResult, stageError } = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      bus: {
        request: async (type, payload) => {
          calls.push({ type, payload });
          if (type === 'session:list') return [
            { path: bridgePath, sessionId: 'sess_bridge_test' },
            { path: nativePath, sessionId: 'sess_native_test' },
          ];
          if (type === 'session:stage-file') {
            if (stageError) throw stageError;
            return stageResult ?? { mediaItem: STAGED_MEDIA_ITEM };
          }
          return { ok: false, error: `unexpected request: ${type}` };
        },
      },
    },
  };
}

function sticker() {
  return { id: 'stk_bridge_test', filePath: imagePath, description: '桥接测试图' };
}

test('QQ Bridge 工具卡同时准备 SessionFile mediaItem，使用当前工具 callToken', async () => {
  const { sdk, calls } = makeSdk();
  const result = await createStickerToolCard({
    sdk, dataDir, sessionPath: bridgePath, callToken: 'call_token_current_tool', sticker: sticker(), text: '测试图',
  });

  assert.equal(result.ok, true, result.error);
  assert.ok(result.card, '桌面 Hana 的本地卡片仍保留');
  assert.deepEqual(result.media, { items: [STAGED_MEDIA_ITEM] });
  const stage = calls.find((call) => call.type === 'session:stage-file');
  assert.equal(stage?.payload.callToken, 'call_token_current_tool');
  assert.equal(stage?.payload.origin, 'plugin_output');
  assert.equal(stage?.payload.mime, 'image/png');
  assert.ok(stage?.payload.path.startsWith(dataDir), '只把 App 自己数据目录里的图片交给宿主登记');
});

test('普通 Hana 会话也登记 SessionFile，同时保留本地图卡', async () => {
  const { sdk, calls } = makeSdk();
  const result = await createStickerToolCard({
    sdk, dataDir, sessionPath: nativePath, callToken: 'call_token_current_tool', sticker: sticker(), text: '测试图',
  });

  assert.equal(result.ok, true, result.error);
  assert.ok(result.card);
  assert.deepEqual(result.media, { items: [STAGED_MEDIA_ITEM] });
  const stage = calls.find((call) => call.type === 'session:stage-file');
  assert.equal(stage?.payload.callToken, 'call_token_current_tool');
  assert.equal(stage?.payload.origin, 'plugin_output');
});

test('会话文件登记失败时仍保留本地图卡并暴露失败，不伪称远端已送达', async () => {
  const { sdk, calls } = makeSdk({ stageError: new Error('app/session.stage-file 未授权') });
  const result = await createStickerToolCard({
    sdk, dataDir, sessionPath: bridgePath, callToken: 'call_token_current_tool', sticker: sticker(), text: '测试图',
  });

  assert.equal(result.ok, true, result.error);
  assert.ok(result.card);
  assert.equal(result.media, undefined);
  assert.match(result.sessionFileError, /未授权/);
  assert.equal(calls.some((call) => call.type === 'session:stage-file'), true);
});
