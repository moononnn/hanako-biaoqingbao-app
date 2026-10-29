import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-input-button-'));
process.env.BQB_DATA_DIR = root;
const { readInputButtonSwitches, resolveInputButtonSwitches, legacyInputButtonValue, syncInputButton, syncInputButtonSession, installInputButtonWatcher, isInputButtonSyncPending, INPUT_STATUS_ID,
  readCodeSessions, rememberCodeSession, noteInputButtonSession } =
  await import('../lib/input-button.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ledgerFile = () => path.join(root, 'input-button-code-sessions.json');
function clearLedger() { fs.rmSync(ledgerFile(), { force: true }); }

function writeConfig(value) {
  fs.writeFileSync(path.join(root, 'display-config.json'), JSON.stringify(value));
}
function fakeSdk({ sessions = ['s1', 's2'], failOn = '' } = {}) {
  const calls = []; const warnings = []; const infos = []; const listeners = [];
  return {
    calls, warnings, infos, listeners,
    bus: {
      request: async (verb) => {
        if (verb !== 'session:list') throw new Error('unexpected ' + verb);
        return { sessions: sessions.map(sessionId => ({ sessionId })) };
      },
      subscribe: async (fn, options) => { listeners.push({ fn, options }); return { ok: true }; },
    },
    inputStatus: {
      set: async (payload) => { if (payload.sessionId === failOn) throw new Error('not enabled here'); calls.push(payload); },
    },
    logger: {
      warn: async (text) => { warnings.push(String(text)); },
      info: async (text) => { infos.push(String(text)); },
    },
  };
}

test('默认显示；配置里明确关掉才算隐藏', () => {
  fs.rmSync(path.join(root, 'display-config.json'), { force: true });
  assert.deepEqual(readInputButtonSwitches(), { chat: true, code: true });
  writeConfig({ inputButton: false });
  assert.deepEqual(readInputButtonSwitches(), { chat: false, code: false }, '旧配置只有一个总闸，两页都按它算');
  writeConfig({ inputButton: true });
  assert.deepEqual(readInputButtonSwitches(), { chat: true, code: true });
  writeConfig({ smallImageFit: true });
  assert.deepEqual(readInputButtonSwitches(), { chat: true, code: true }, '没写这个字段按显示算');
  writeConfig({});
});

test('开关按页读：分页键写定后，旧的总闸不再牵着另一边', () => {
  writeConfig({ inputButton: false, inputButtonChat: true });
  assert.deepEqual(readInputButtonSwitches(), { chat: true, code: false }, '聊天页自己开就是开，Code 页没分页键就跟着旧总闸');
  writeConfig({ inputButton: true, inputButtonCode: false });
  assert.deepEqual(readInputButtonSwitches(), { chat: true, code: false }, 'Code 页自己关就是关');
  writeConfig({ inputButtonChat: false, inputButtonCode: true });
  assert.deepEqual(readInputButtonSwitches(), { chat: false, code: true });
});

test('旧键只当镜像：两边都开才算开', () => {
  assert.equal(legacyInputButtonValue({ chat: true, code: true }), true);
  assert.equal(legacyInputButtonValue({ chat: true, code: false }), false, '只有一边开着时降级宁可两边都藏');
  assert.equal(legacyInputButtonValue({ chat: false, code: true }), false);
  assert.equal(resolveInputButtonSwitches({}).chat, true, '空配置按默认显示');
  assert.equal(resolveInputButtonSwitches({ inputButtonChat: 'false' }).chat, true, '脏值按默认算');
});

test('两页分开盖：聊天页会话用聊天页那档，Code 会话用 Code 页那档', async () => {
  clearLedger();
  rememberCodeSession('sess_code1');
  const sdk = fakeSdk({ sessions: ['s1', 's2'] });
  const result = await syncInputButton(sdk, { chat: true, code: false });
  assert.equal(result.ok, true);
  const byId = Object.fromEntries(sdk.calls.map(call => [call.sessionId, call.visible]));
  assert.equal(byId.s1, true, '聊天页的会话按聊天页的开关显示');
  assert.equal(byId.s2, true);
  assert.equal(byId.sess_code1, false, 'Code 会话按 Code 页的开关藏住');
  assert.equal(result.chatSynced, 2);
  assert.equal(result.codeSynced, 1);
  assert.deepEqual(result.applied, { chat: true, code: false });
  clearLedger();
});

test('反过来也一样：聊天页关、Code 页开，两边各按各的来', async () => {
  clearLedger();
  rememberCodeSession('sess_code1');
  const sdk = fakeSdk({ sessions: ['s1'] });
  await syncInputButton(sdk, { chat: false, code: true });
  const byId = Object.fromEntries(sdk.calls.map(call => [call.sessionId, call.visible]));
  assert.equal(byId.s1, false, '聊天页的会话按聊天页的开关藏住');
  assert.equal(byId.sess_code1, true, 'Code 会话按 Code 页的开关显示');
  clearLedger();
});

test('新会话事件带 namespace=code 时按 Code 页那档盖', async () => {
  clearLedger();
  writeConfig({ inputButtonChat: true, inputButtonCode: false });
  const sdk = fakeSdk({ sessions: ['s1'] });
  await installInputButtonWatcher(sdk);
  await new Promise(resolve => setTimeout(resolve, 1200));
  await sdk.listeners[0].fn({ type: 'session_created', session: { sessionId: 'sess_codeX', namespace: 'code' } });
  await new Promise(resolve => setTimeout(resolve, 50));
  const call = sdk.calls.find(item => item.sessionId === 'sess_codeX');
  assert.ok(call, '新 Code 会话要盖一次');
  assert.equal(call.visible, false, 'Code 页那档是关的，新 Code 会话就该是藏着的');
  clearLedger();
});

test('单会话同步按分区取对应那档开关', async () => {
  const sdk = fakeSdk();
  const chat = await syncInputButtonSession(sdk, 's7', { chat: false, code: true }, 'chat');
  assert.equal(chat.ok, true);
  assert.deepEqual(sdk.calls[0], { sessionId: 's7', id: INPUT_STATUS_ID, visible: false });

  const codeSdk = fakeSdk();
  await syncInputButtonSession(codeSdk, 's8', { chat: false, code: true }, 'code');
  assert.deepEqual(codeSdk.calls[0], { sessionId: 's8', id: INPUT_STATUS_ID, visible: true });
});

test('同步：每个会话都盖一遍，id 用清单里那个，单个会话失败不影响其他', async () => {
  const sdk = fakeSdk({ failOn: 's2' });
  const result = await syncInputButton(sdk, false);
  assert.equal(result.ok, true);
  assert.deepEqual(sdk.calls.map(call => [call.sessionId, call.id, call.visible]), [
    ['s1', INPUT_STATUS_ID, false],
  ]);
  assert.ok(sdk.warnings.some(text => text.includes('显隐同步失败')));

  const onSdk = fakeSdk();
  await syncInputButton(onSdk, true);
  assert.deepEqual(onSdk.calls.map(call => call.visible), [true, true]);
});

test('列会话失败时报出来，不假装同步成功', async () => {
  clearLedger();
  const sdk = fakeSdk();
  sdk.bus.request = async () => { throw new Error('denied'); };
  const result = await syncInputButton(sdk, false);
  assert.equal(result.ok, false);
  assert.equal(result.synced, 0);
  assert.ok(sdk.warnings.some(text => text.includes('列会话失败')));
});

test('装载时先同步一次，新会话事件到了再补，订阅带第二个参数', async () => {
  writeConfig({ inputButton: false });
  const sdk = fakeSdk({ sessions: ['s1'] });
  await installInputButtonWatcher(sdk);
  assert.equal(sdk.calls.length, 0, '首次同步延后一拍，等宿主发布完 UI 贡献');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.listeners.length, 1);
  assert.deepEqual(sdk.listeners[0].options, {}, '订阅必须显式给第二参数，省略会让宿主装载报错');
  await sdk.listeners[0].fn('session_created');
  assert.equal(sdk.calls.length, 2, '新会话要再盖一次');
  sdk.bus.request = async () => ({ sessions: [{ sessionId: 's3' }] });
  await sdk.listeners[0].fn('session_created');
  assert.equal(sdk.calls.at(-1).sessionId, 's3');
});

test('会话事件带 sessionId 时只盖那一个会话，不把全部会话重刷一遍', async () => {
  writeConfig({ inputButton: false });
  const sdk = fakeSdk({ sessions: ['s1', 's2'] });
  await installInputButtonWatcher(sdk);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(sdk.calls.length, 2, '装载时先把已知会话盖一遍');
  await sdk.listeners[0].fn({ type: 'session_created', sessionId: 's9', sessionPath: 'p', agentId: 'a' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sdk.calls.length, 3, '只该多盖一次，不是把全部会话重刷');
  assert.equal(sdk.calls.at(-1).sessionId, 's9');
  assert.equal(sdk.calls.at(-1).visible, false);
});

test('单会话同步：盖成了就算数，盖不成就报出来', async () => {
  const sdk = fakeSdk();
  const ok = await syncInputButtonSession(sdk, 's7', false);
  assert.equal(ok.ok, true);
  assert.equal(ok.synced, 1);
  assert.equal(ok.failed, 0);
  assert.deepEqual(sdk.calls[0], { sessionId: 's7', id: INPUT_STATUS_ID, visible: false });

  const bad = fakeSdk({ failOn: 's7' });
  const failed = await syncInputButtonSession(bad, 's7', true);
  assert.equal(failed.ok, false);
  assert.equal(failed.failed, 1);
  assert.equal(failed.reason, 'set-failed');

  const empty = await syncInputButtonSession(sdk, '', true);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no-session');
});

test('会话数超过上限时把被截断的数量报出来，不拿一半成功冒充全部', async () => {
  const many = Array.from({ length: 2100 }, (_, i) => 's' + i);
  const sdk = fakeSdk({ sessions: many });
  const result = await syncInputButton(sdk, false);
  assert.equal(result.total, 2000);
  assert.equal(result.truncated, 100, '截断了多少要报出来');
  assert.equal(result.synced, 2000);
});

test('事件负载不是平铺的也能拿到 sessionId', async () => {
  writeConfig({ inputButton: false });
  const sdk = fakeSdk({ sessions: ['s1'] });
  await installInputButtonWatcher(sdk);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const before = sdk.calls.length;
  await sdk.listeners[0].fn({ type: 'session_created', payload: { sessionId: 's8' } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sdk.calls.length, before + 1, '还是只盖那一个');
  assert.equal(sdk.calls.at(-1).sessionId, 's8');
});

test('退路全量同步与单会话补盖的结果都留一笔日志，不悄悄丢掉', async () => {
  writeConfig({ inputButton: false });
  const sdk = fakeSdk({ sessions: ['s1'] });
  await installInputButtonWatcher(sdk);
  await new Promise(resolve => setTimeout(resolve, 1200));
  await sdk.listeners[0].fn({ type: 'session_created' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(sdk.infos.some(text => text.includes('退路全量同步')), '退路结果不能悄悄丢掉');
  await sdk.listeners[0].fn({ type: 'session_created', sessionId: 's5' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(sdk.infos.some(text => text.includes('补盖新会话')));
});

test('「还在跑」两种标记都认，不会把在跑当成最终结果', () => {
  assert.equal(isInputButtonSyncPending({ reason: 'pending' }), true, '服务端在跑状态用 reason');
  assert.equal(isInputButtonSyncPending({ pending: true }), true, 'POST 即时回包用 pending');
  assert.equal(isInputButtonSyncPending({ ok: true, synced: 3, total: 3 }), false);
  assert.equal(isInputButtonSyncPending({ ok: false, reason: 'not-declared-yet' }), false);
  assert.equal(isInputButtonSyncPending(null), false);
});

test('被更新的请求取代时立刻收手，不再往会话里写旧值', async () => {
  const sdk = fakeSdk({ sessions: ['s1', 's2', 's3'] });
  let checks = 0;
  const result = await syncInputButton(sdk, false, () => { checks += 1; return checks > 1; });
  assert.equal(result.reason, 'superseded');
  assert.ok(sdk.calls.length < 3, '不该把全部会话都写一遍：' + sdk.calls.length);

  const sdk2 = fakeSdk({ sessions: ['s1', 's2', 's3'] });
  const ok = await syncInputButton(sdk2, false, () => false);
  assert.equal(ok.ok, true);
  assert.equal(ok.synced, 3);
  assert.equal(ok.reason, undefined);
});

test('同步结果带失败数：盖成了但也有失败的，要说部分而不是全好', async () => {
  const sdk = fakeSdk({ sessions: ['s1', 's2'], failOn: 's2' });
  const result = await syncInputButton(sdk, false);
  assert.equal(result.ok, true);
  assert.equal(result.synced, 1);
  assert.equal(result.failed, 1, '失败数要报出来，不能只报盖成了几个');
  assert.equal(result.total, 2);
  assert.equal(result.reason, 'partial');
});

test('声明还没被宿主投影时退回重试，直到盖上为止', async () => {
  writeConfig({ inputButton: false });
  const sdk = fakeSdk({ sessions: ['s1'] });
  let attempts = 0;
  sdk.inputStatus.set = async (payload) => {
    attempts += 1;
    if (attempts === 1) throw new Error(`App ${'biaoqingbao-app'} has no declared input status item ${payload.id}`);
    sdk.calls.push(payload);
  };
  await installInputButtonWatcher(sdk);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(sdk.calls.length, 0, '第一次撞上「还没声明」不该算盖成功');
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(attempts, 2, '第二次尝试要真的发生');
  assert.deepEqual(sdk.calls.map(call => call.visible), [false]);
});

test('权限或名单类失败不纠缠重试，只报一次', async () => {
  writeConfig({ inputButton: false });
  const sdk = fakeSdk({ sessions: ['s1', 's2'] });
  let attempts = 0;
  sdk.inputStatus.set = async () => { attempts += 1; throw new Error('App needs app/input.status and activation'); };
  await installInputButtonWatcher(sdk);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(attempts, 2, '两个会话各试一次');
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(attempts, 2, '非「还没声明」的错不重试');
});
test('返回结果带上失败原因，不把没盖成当成盖好', async () => {
  const sdk = fakeSdk({ sessions: ['s1'] });
  sdk.inputStatus.set = async () => { throw new Error('App x has no declared input status item sticker-compose'); };
  const result = await syncInputButton(sdk, false);
  assert.equal(result.ok, false);
  assert.equal(result.synced, 0);
  assert.equal(result.reason, 'not-declared-yet');
  assert.equal(result.total, 1);
});

// ── Code 页的会话：宿主名单里没有，得自己认下来 ──
// 依据：宿主给 App 的 session:list 只开 home / app 两个分区，
// Code 页的会话既不在名单里，也没有别的枚举入口（session:search 只回本应用自己的会话）。

test('事件里带 namespace=code 的会话要记进名单，下次同步一并盖上', async () => {
  clearLedger();
  writeConfig({ inputButton: false });
  const sdk = fakeSdk({ sessions: ['s1'] });
  await installInputButtonWatcher(sdk);
  await new Promise(resolve => setTimeout(resolve, 1200));
  await sdk.listeners[0].fn({ type: 'session_created', session: { sessionId: 'sess_code9', namespace: 'code' } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(readCodeSessions().includes('sess_code9'), 'Code 会话要进名单，不然关开关时盖不到它');

  const sdk2 = fakeSdk({ sessions: ['s1'] });
  const result = await syncInputButton(sdk2, false);
  assert.equal(result.codeSessions, 1, '同步结果要报出盖了几个 Code 会话');
  assert.ok(sdk2.calls.some(call => call.sessionId === 'sess_code9' && call.visible === false),
    '名单里的 Code 会话要跟宿主名单里的会话一起盖');
});

test('事件负载塞在 session 里时也认得出 sessionId，不用退化成全量重刷', async () => {
  clearLedger();
  writeConfig({ inputButton: false });
  const sdk = fakeSdk({ sessions: ['s1'] });
  await installInputButtonWatcher(sdk);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const before = sdk.calls.length;
  await sdk.listeners[0].fn({ type: 'session_created', session: { sessionId: 's8', namespace: 'code' } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sdk.calls.length, before + 1, '只该多盖一次，不是把全部会话重刷');
  assert.equal(sdk.calls.at(-1).sessionId, 's8');
});

test('钩子认出 Code 页的会话：记进名单，并按当前开关盖一次', async () => {
  clearLedger();
  writeConfig({ inputButton: false });
  const sdk = fakeSdk({ sessions: ['s1'] });
  sdk.bus.request = async (verb) => {
    if (verb === 'session:get') return { session: { namespace: 'code', sessionId: 'sess_code1', title: 'Code' } };
    if (verb === 'session:list') return { sessions: [{ sessionId: 's1' }] };
    throw new Error('unexpected ' + verb);
  };
  const noted = await noteInputButtonSession(sdk, {
    sessionId: '2026-10-27T13-22-40-743Z_abc',
    sessionPath: 'C:/x/sessions/abc.jsonl',
  });
  assert.equal(noted.noted, true);
  assert.equal(noted.sessionId, 'sess_code1');
  assert.equal(sdk.calls.at(-1).sessionId, 'sess_code1', '新认到的 Code 会话要立刻盖一次');
  assert.equal(sdk.calls.at(-1).visible, false);

  const sdk2 = fakeSdk({ sessions: ['s1'] });
  const result = await syncInputButton(sdk2, false);
  assert.equal(result.codeSessions, 1);
  assert.ok(sdk2.calls.some(call => call.sessionId === 'sess_code1' && call.visible === false));
});

test('聊天页的会话不进名单（宿主名单里本来就有）', async () => {
  clearLedger();
  const sdk = fakeSdk({ sessions: ['s1'] });
  sdk.bus.request = async (verb) => {
    if (verb === 'session:get') return { session: { namespace: 'home', sessionId: 'sess_home1' } };
    if (verb === 'session:list') return { sessions: [{ sessionId: 's1' }] };
    throw new Error('unexpected ' + verb);
  };
  const noted = await noteInputButtonSession(sdk, { sessionId: 'sess_home1' });
  assert.equal(noted.noted, false);
  assert.deepEqual(readCodeSessions(), []);
});

test('会话没了不算失败，而且从名单里清掉', async () => {
  clearLedger();
  writeConfig({ inputButton: false });
  rememberCodeSession('sess_dead');
  const sdk = fakeSdk({ sessions: [] });
  sdk.inputStatus.set = async () => { throw new Error('Input status target session is unavailable'); };
  const result = await syncInputButton(sdk, false);
  assert.equal(result.failed, 0, '会话没了不是失败');
  assert.equal(result.gone, 1);
  assert.equal(result.ok, true, '没有按钮可藏，本来就没东西要藏');
  assert.equal(readCodeSessions().includes('sess_dead'), false, '死会话要从名单里清掉');
});

test('那个伙伴里没启用本应用：那里本来就没这个按钮，不算没盖上', async () => {
  clearLedger();
  const sdk = fakeSdk({ sessions: ['s1'] });
  sdk.inputStatus.set = async () => { throw new Error('App biaoqingbao-app needs app/input.status and activation in the target Agent'); };
  const result = await syncInputButton(sdk, false);
  assert.equal(result.failed, 0, '不是失败');
  assert.equal(result.skipped, 1);
  assert.equal(result.ok, true);
});

test('名单写坏了也不能把同步搞崩：读不到就当空名单', async () => {
  clearLedger();
  fs.writeFileSync(ledgerFile(), '{ 这不是 json');
  assert.deepEqual(readCodeSessions(), []);
  const sdk = fakeSdk({ sessions: ['s1'] });
  const result = await syncInputButton(sdk, false);
  assert.equal(result.ok, true);
  assert.equal(result.codeSessions, 0);
});
