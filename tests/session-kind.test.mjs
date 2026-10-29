// 会话分区判断（聊天页 / Code 页）——解析器与频率取值的单元测试
//
// 依据：只有 session:get 返回 namespace（home / code / app），session:list 看不到 Code 会话。
// 这几个用例守的就是那几条容易退化的行为：缓存、路径兜底、判不出来按聊天页。

import test from 'node:test';
import assert from 'node:assert/strict';

const { createSessionMetaResolver, isCodeSession, isSubagentSession, pickWindowFreq, resolveEffectiveNamespace, shouldSkipForCodeWindow, windowLabel } =
  await import('../lib/session-kind.js');

function fakeBus(handler) {
  const calls = [];
  return {
    calls,
    async request(name, payload, options) {
      calls.push({ name, payload, options });
      return handler(name, payload, calls.length);
    },
  };
}

test('session:get 返回 code，就判成 Code 页', async () => {
  const bus = fakeBus(() => ({ session: { namespace: 'code', title: '改个东西', sessionId: 'sess_abc' } }));
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionId: 'sess_abc' });
  assert.equal(meta.namespace, 'code');
  assert.equal(meta.title, '改个东西');
  assert.equal(meta.sessionId, 'sess_abc', '稳定会话 id 要一并带出来');
  assert.equal(bus.calls[0].name, 'session:get');
  assert.equal(bus.calls[0].payload.sessionId, 'sess_abc');
  assert.equal(isCodeSession(meta.namespace), true);
});

test('home 会话判成聊天页', async () => {
  const bus = fakeBus(() => ({ session: { namespace: 'home' } }));
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionId: 'sess_home' });
  assert.equal(isCodeSession(meta.namespace), false);
});

test('同一个会话只问一次宿主（有缓存）', async () => {
  const bus = fakeBus(() => ({ session: { namespace: 'home', title: '随便聊聊' } }));
  const resolve = createSessionMetaResolver({ bus });
  await resolve({ sessionId: 'sess_cache' });
  await resolve({ sessionId: 'sess_cache' });
  assert.equal(bus.calls.length, 1);
});

test('sessionId 问不通时退回会话路径', async () => {
  const bus = fakeBus((name, payload) => {
    if (payload.legacySessionPath) return { session: { namespace: 'code', title: 'Code 里的活' } };
    throw new Error('unknown session');
  });
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionId: 'sess_unknown', sessionPath: 'C:/x/sessions/a.jsonl' });
  assert.equal(meta.namespace, 'code');
  assert.equal(bus.calls.length, 2);
  assert.equal(bus.calls[1].payload.legacySessionPath, 'C:/x/sessions/a.jsonl');
});

test('时间戳形状的 sessionId 不再先撞一次必失败的查询', async () => {
  const bus = fakeBus((name, payload) => {
    if (payload.legacySessionPath) return { session: { namespace: 'code', title: 'Code 里的活' } };
    throw new Error('unknown session');
  });
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionId: '2026-10-25T01-36-23-921Z_abc', sessionPath: 'C:/x/sessions/a.jsonl' });
  assert.equal(meta.namespace, 'code');
  assert.equal(bus.calls.length, 1);
  assert.equal(bus.calls[0].payload.legacySessionPath, 'C:/x/sessions/a.jsonl');
});

test('没有总线时判不出来，按聊天页算', async () => {
  const resolve = createSessionMetaResolver({});
  const meta = await resolve({ sessionId: 'sess_x' });
  assert.deepEqual(meta, { namespace: '', title: '', sessionId: '' });
  assert.equal(isCodeSession(meta.namespace), false);
});

test('宿主报错也不抛，返回空分区', async () => {
  const bus = fakeBus(() => { throw new Error('busy'); });
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionId: 'sess_err', sessionPath: 'C:/x.jsonl' });
  assert.equal(meta.namespace, '');
});

test('查不到的分区会记一分钟负缓存，不再每轮重打两遍', async () => {
  const bus = fakeBus(() => { throw new Error('Session manifest not found'); });
  const resolve = createSessionMetaResolver({ bus });
  const first = await resolve({ sessionId: 'sess_neg', sessionPath: 'C:/y.jsonl' });
  assert.equal(first.namespace, '');
  const afterFirst = bus.calls.length;
  assert.equal(afterFirst, 2);
  // 第二、三次都直接吃负缓存，一次也不打宿主
  await resolve({ sessionId: 'sess_neg', sessionPath: 'C:/y.jsonl' });
  await resolve({ sessionId: 'sess_neg', sessionPath: 'C:/y.jsonl' });
  assert.equal(bus.calls.length, afterFirst);
});

test('负缓存过期后会重新问一次，不会把过期的东西当永久结论', async () => {
  const bus = fakeBus(() => { throw new Error('Session manifest not found'); });
  const resolve = createSessionMetaResolver({ bus, negativeTtlMs: 0 });
  await resolve({ sessionId: 'sess_neg2' });
  const afterFirst = bus.calls.length;
  await resolve({ sessionId: 'sess_neg2' });
  assert.ok(bus.calls.length > afterFirst);
});

test('频率按窗口取：聊天页 daily，Code 页 task', () => {
  const settings = { daily: 50, task: 20 };
  assert.equal(pickWindowFreq(settings, false), 50);
  assert.equal(pickWindowFreq(settings, true), 20);
});

test('没有 task 字段时跟 daily 一致，不当成 0', () => {
  assert.equal(pickWindowFreq({ daily: 60 }, true), 60);
  assert.equal(pickWindowFreq({}, false), 0);
});

test('窗口名只给两种', () => {
  assert.equal(windowLabel(true), 'Code');
  assert.equal(windowLabel(false), '聊天');
});

test('子代理会话认路径：正斜杠、反斜杠都算', () => {
  assert.equal(isSubagentSession({ sessionPath: 'C:/x/agents/hanako/subagent-sessions/direct/a.jsonl' }), true);
  assert.equal(isSubagentSession({ sessionPath: 'D:\\HanaHome\\.hanako\\agents\\hanako\\subagent-sessions\\direct\\a.jsonl' }), true);
  assert.equal(isSubagentSession({ sessionPath: 'C:/x/agents/hanako/sessions/a.jsonl' }), false);
  assert.equal(isSubagentSession({}), false);
  assert.equal(isSubagentSession({ sessionPath: '', sessionKind: 'subagent' }), true);
});

test('宿主回的不是同一个会话时，按没查到处理（2026-10-29 实测踩过）', async () => {
  // 按 id 查 Code 页的会话，宿主可能回一个别的 home 会话（scope=all 时不报错）。
  // 那会把「这个会话在 Code 页」错判成「在聊天页」，于是 Code 配图总闸在注入层失效：
  // 总闸都关了，模型还是被塞了「配一张表情包」的提示，然后又被工具层拒掉。
  const bus = fakeBus((name, payload) => {
    if (payload.legacySessionPath) return { session: { namespace: 'code', title: 'Code 里的活', sessionId: 'sess_code' } };
    return { session: { namespace: 'home', title: '聊天页的另一个会话', sessionId: 'sess_other' } };
  });
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionId: 'sess_code', sessionPath: 'C:/x/sessions/a.jsonl' });
  assert.equal(meta.namespace, 'code', '身份对不上的结果要丢掉，继续试下一条路');
  assert.equal(meta.sessionId, 'sess_code');
  assert.equal(bus.calls.length, 2, 'id 查的那次被丢掉后，要接着试路径');
});

test('身份对不上的结果不进缓存（不能把错答案记 8 小时）', async () => {
  const bus = fakeBus((name, payload) => {
    if (payload.legacySessionPath) return { session: { namespace: 'code', sessionId: 'sess_code' } };
    return { session: { namespace: 'home', sessionId: 'sess_other' } };
  });
  const resolve = createSessionMetaResolver({ bus });
  await resolve({ sessionId: 'sess_code', sessionPath: 'C:/x/sessions/a.jsonl' });
  const after = bus.calls.length;
  await resolve({ sessionId: 'sess_code', sessionPath: 'C:/x/sessions/a.jsonl' });
  assert.equal(bus.calls.length, after, '第二次直接吃缓存，不该再打宿主');
});

test('Code 总闸关着：明确是 Code 就收手，判不出分区也收手（从严）', () => {
  assert.equal(shouldSkipForCodeWindow({ namespace: 'code', codeEnabled: false }), true);
  assert.equal(shouldSkipForCodeWindow({ namespace: '', codeEnabled: false }), true, '判不出就按 Code 处理');
  assert.equal(shouldSkipForCodeWindow({ namespace: 'home', codeEnabled: false }), false, '明确是聊天页照常');
  assert.equal(shouldSkipForCodeWindow({ namespace: 'app', codeEnabled: false }), false);
});

test('Code 总闸开着：谁都不收手', () => {
  assert.equal(shouldSkipForCodeWindow({ namespace: 'code', codeEnabled: true }), false);
  assert.equal(shouldSkipForCodeWindow({ namespace: '', codeEnabled: true }), false);
});

test('自记 Code 名单能兜住「解析把 Code 会话说成 home」', () => {
  // 聊天页会话不在名单里 → 照旧是聊天页（这道防线对聊天页零影响）。
  assert.equal(resolveEffectiveNamespace({ namespace: 'home', sessionId: 'sess_chat', knownCodeSessionIds: ['sess_code'] }), 'home');
  // 名单里的会话一定是 Code 页出现过 → 即使解析说 home 也按 Code 处理。
  assert.equal(resolveEffectiveNamespace({ namespace: 'home', sessionId: 'sess_code', knownCodeSessionIds: ['sess_code'] }), 'code');
  // 名单为空 / 没有 id 时不乱动。
  assert.equal(resolveEffectiveNamespace({ namespace: 'home', sessionId: 'sess_chat', knownCodeSessionIds: [] }), 'home');
  assert.equal(resolveEffectiveNamespace({ namespace: 'home', sessionId: '', knownCodeSessionIds: ['sess_code'] }), 'home');
  // 明确是 code 的照旧。
  assert.equal(resolveEffectiveNamespace({ namespace: 'code', sessionId: 'sess_x', knownCodeSessionIds: [] }), 'code');
});

test('身份校验只在请求 id 是宿主稳定 id 时严格比对（聊天页不能被误伤）', async () => {
  // 请求是 sess_xxx、返回的也是 sess_xxx 但不是同一个 → 查到了别的会话，丢弃。
  const bus = fakeBus((name, payload) => {
    if (payload.legacySessionPath) return { session: { namespace: 'code', sessionId: 'sess_target' } };
    return { session: { namespace: 'home', sessionId: 'sess_other' } };
  });
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionId: 'sess_target', sessionPath: 'C:/x/sessions/a.jsonl' });
  assert.equal(meta.namespace, 'code');
  assert.equal(bus.calls.length, 2);
});

test('请求 id 是文件名形状时，返回 UUID 形状也算同一个会话（不能误丢）', async () => {
  const bus = fakeBus(() => ({ session: { namespace: 'home', sessionId: '01a189e1-c6c9-711c-9a3a-e1727240d660' } }));
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionId: '2026-10-29T14-45-22-352Z_01a1881f-6930-71e7-bcd9-07ec961f86b7' });
  assert.equal(meta.namespace, 'home', '形状不同的 id 仍按查到了处理，不误伤');
});
