// QQ Bridge 配图附件：details.media 仍由宿主 BridgeManager 转为 QQ 媒体消息；details.card 留在本地回复里。
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

function makeSdk({ stageResult, stageError, includeBridgeInList = true } = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      bus: {
        request: async (type, payload) => {
          calls.push({ type, payload });
          if (type === 'session:list') {
            return includeBridgeInList
              ? [{ path: bridgePath, sessionId: 'sess_bridge_test' }, { path: nativePath, sessionId: 'sess_native_test' }]
              : [{ path: nativePath, sessionId: 'sess_native_test' }];
          }
          if (type === 'session:get') return { session: null };
          if (type === 'session:send-custom') return { ok: true, entryId: 'entry_test' };
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

test('QQ Bridge 保留 SessionFile 附件，同时准备本地回复图卡并使用当前工具 callToken', async () => {
  const { sdk, calls } = makeSdk();
  const result = await createStickerToolCard({
    sdk, dataDir, sessionPath: bridgePath, callToken: 'call_token_current_tool', sticker: sticker(), text: '测试图',
  });

  assert.equal(result.ok, true, result.error);
  assert.ok(result.preparedRecord, '本地图片消息记录已准备');
  assert.equal(result.card.pluginId, 'biaoqingbao-app');
  assert.equal(result.card.sessionId, 'sess_bridge_test');
  assert.match(result.card.route, /recordId=a_/);
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
  assert.ok(result.preparedRecord);
  assert.equal(result.card.pluginId, 'biaoqingbao-app');
  assert.equal(result.card.sessionId, 'sess_native_test');
  assert.match(result.card.route, /recordId=a_/);
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
  assert.ok(result.preparedRecord);
  assert.equal(result.card.pluginId, 'biaoqingbao-app');
  assert.match(result.card.route, /recordId=a_/);
  assert.equal(result.media, undefined);
  assert.match(result.sessionFileError, /未授权/);
  assert.equal(calls.some((call) => call.type === 'session:stage-file'), true);
});

// issue #1：桥接会话拿不到 sess_ 编号（session:list 过滤 domain !== desktop，session:get 也解析不出）。
// 编号只服务本地图卡，不该拦会话附件登记——拿不到编号时也要把图交给桥接通道。
test('拿不到会话编号时，仍靠 callToken 登记会话附件（图卡让位，不整条失败）', async () => {
  const { sdk, calls } = makeSdk({ includeBridgeInList: false });
  const result = await createStickerToolCard({
    sdk, dataDir, sessionPath: bridgePath, callToken: 'call_token_current_tool', sticker: sticker(), text: '桥接图',
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.card, undefined, '拿不到编号就建不了本地图卡');
  assert.equal(result.noSessionId, true);
  assert.deepEqual(result.media, { items: [STAGED_MEDIA_ITEM] }, '桥接通道要的 SessionFile 必须照旧送出');
  const stage = calls.find((call) => call.type === 'session:stage-file');
  assert.equal(stage?.payload.callToken, 'call_token_current_tool');
  assert.ok(stage?.payload.path.startsWith(dataDir), '登记路径必须落在 App dataDir 内');
});

// 编号拿不到 + 附件也登记不上：这时才该真失败。
test('编号与附件都没有时才算失败', async () => {
  const { sdk } = makeSdk({ includeBridgeInList: false, stageError: new Error('app/session.stage-file 未授权') });
  const result = await createStickerToolCard({
    sdk, dataDir, sessionPath: bridgePath, callToken: 'call_token_current_tool', sticker: sticker(), text: '桥接图',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /未授权|没能建立/);
});
