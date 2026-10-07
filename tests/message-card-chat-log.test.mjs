import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v0.1.30 - 两件新事：
//   ① 「默认跟随当前模型」靠读 agents/<id>/config.yaml 的 models.chat；
//   ② 聊天记录存在卡片记录里，确认修改完就销案。
// 都是纯读写逻辑，这里不碰宿主、不碰模型。
import { readAgentChatModel } from '../lib/agent-model.js';
import { readMessageCard, readMessageCardChat, saveMessageCardChat } from '../lib/ball-message-card.js';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-home-'));
}

function writeAgent(home, id, yaml) {
  fs.mkdirSync(path.join(home, 'agents', id), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents', id, 'config.yaml'), yaml, 'utf8');
}

test('跟随当前模型：从伙伴配置里读出他平时说话那台', () => {
  const home = tempHome();
  writeAgent(home, 'hanako', [
    'agent:',
    '  name: 小花',
    'api:',
    '  provider: deepseek',
    'models:',
    '  chat:',
    '    id: MiniMax-M3.1-Flash-Preview',
    '    provider: minimax',
    '  utility: ""',
    'memory:',
    '  enabled: true',
  ].join('\n'));
  assert.deepEqual(readAgentChatModel('hanako', home), {
    providerId: 'minimax',
    modelId: 'MiniMax-M3.1-Flash-Preview',
  });
});

test('跟随当前模型：换一种缩进与引号也认', () => {
  const home = tempHome();
  writeAgent(home, 'a', [
    'models:',
    '    chat:',
    '        provider: "deepseek"',
    '        id: "deepseek-v4-flash"   # 便宜那台',
  ].join('\n'));
  assert.deepEqual(readAgentChatModel('a', home), { providerId: 'deepseek', modelId: 'deepseek-v4-flash' });
});

test('跟随当前模型：没配具体模型时老实返回空，交给调用方回退', () => {
  const home = tempHome();
  writeAgent(home, 'empty', ['models:', '  chat: ""', '  utility: ""'].join('\n'));
  assert.equal(readAgentChatModel('empty', home), null);

  writeAgent(home, 'half', ['models:', '  chat:', '    id: something'].join('\n'));
  assert.equal(readAgentChatModel('half', home), null, '只有 id 没有 provider 不算数');

  assert.equal(readAgentChatModel('missing-agent', home), null);
  assert.equal(readAgentChatModel('', home), null);
});

test('跟随当前模型：别处的 provider / id 不误抓', () => {
  const home = tempHome();
  writeAgent(home, 'b', [
    'api:',
    '  provider: deepseek',
    '  id: 不该被当成聊天模型',
    'models:',
    '  chat:',
    '    provider: minimax',
    '    id: 该抓这个',
    'memory:',
    '  provider: 也不该抓',
    '  id: 更不该抓',
  ].join('\n'));
  assert.deepEqual(readAgentChatModel('b', home), { providerId: 'minimax', modelId: '该抓这个' });
});

test('聊天记录：没记录就是空，不当成错误', () => {
  assert.equal(readMessageCardChat({ id: 'x' }), null);
  assert.equal(readMessageCardChat({ id: 'x', chat: null }), null);
  assert.equal(readMessageCardChat(null), null);
});

test('聊天记录：读的时候不信任盘上的形状，脏东西一律丢', () => {
  const chat = readMessageCardChat({
    id: 'x',
    chat: {
      messages: [
        { role: 'user', text: '这图不对' },
        { role: 'bot', text: '那改哪' },
        { role: 'system', text: '不该出现' },
        { role: 'bot', text: '' },
        { role: 'bot' },
        'garbage',
        null,
      ],
      suggestion: { description: '新描述' },
      oldTags: { description: '旧描述' },
      dropped: ['emotion', 42, null],
      updatedAt: '2026-10-07T02:00:00.000Z',
    },
  });
  assert.deepEqual(chat.messages, [{ role: 'user', text: '这图不对' }, { role: 'bot', text: '那改哪' }]);
  assert.deepEqual(chat.dropped, ['emotion']);
  assert.equal(chat.suggestion.description, '新描述');
  assert.equal(chat.updatedAt, '2026-10-07T02:00:00.000Z');
});

test('聊天记录：写得进、读得回，销案传 null 就清干净', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-card-'));
  const record = {
    id: 'a_' + 'd'.repeat(20),
    sessionId: 's1',
    imageHash: 'e'.repeat(64),
    mimeType: 'image/png',
    text: '',
    sender: 'partner',
    stickerId: 'stk-one',
    agentId: 'hanako',
  };
  saveMessageCardChat(dataDir, record, {
    messages: [{ role: 'user', text: '喂' }, { role: 'bot', text: '在' }],
    suggestion: { emotion: ['委屈'] },
    oldTags: { emotion: ['开心'] },
    dropped: [],
  });
  const afterSave = readMessageCard(dataDir, record.id);
  assert.equal(readMessageCardChat(afterSave).messages.length, 2);
  assert.ok(readMessageCardChat(afterSave).updatedAt, '写的时候自己带上时间戳');
  // 卡片别的字段不能被聊天记录挤掉
  assert.equal(afterSave.stickerId, 'stk-one');
  assert.equal(afterSave.imageHash, 'e'.repeat(64));

  saveMessageCardChat(dataDir, readMessageCard(dataDir, record.id), null);
  assert.equal(readMessageCardChat(readMessageCard(dataDir, record.id)), null, '销案后读出来就是空');
});

// 「默认跟随」是拍板定下的默认行为：跟随必须排在「设置里选过的模型」前面。
// 早就给学我说话/标签配过内容分析模型的人不少，若那个排在前面，「跟随」永远看不到效果。
test('跟随当前模型排在设置项前面（默认是跟随，不是「设置选过优先」）', () => {
  const src = fs.readFileSync(new URL('../server/api.js', import.meta.url), 'utf8');
  const start = src.indexOf('function resolveChatModelConfig');
  assert.ok(start > 0, '应该还有这个函数');
  const body = src.slice(start, start + 1600);
  const own = body.indexOf('readAgentChatModel(agentId)');
  const custom = body.indexOf("cfg.source === 'custom'");
  const picked = body.indexOf('cfg.enabled && cfg.providerId');
  assert.ok(own > 0 && custom > 0 && picked > 0, '四个分支都要在');
  assert.ok(own < custom && own < picked, '跟随当前伙伴要排在自定义 API 与设置项之前');
});
