// tests/dialect-bridge.test.mjs — 从「说方言」拿方言气质的桥
// 跑法：node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';

const { setServiceBus, hasServiceBus, getAgentDialectBias, clearDialectBiasCache } = await import('../lib/dialect-bridge.js');

const BIAS = {
  label: '巴适得很',
  emotion: { 搞笑: 1.2, 开心: 1.1 },
  intensity: { light: 1, medium: 0, strong: 2 },
};

function fakeBus(handler) {
  const calls = [];
  return {
    calls,
    request: async (type, payload, options) => {
      calls.push({ type, payload, options });
      return handler(type, payload, options);
    },
  };
}

test('没有 bus 时直接返回 null，不抛也不等', async () => {
  setServiceBus(null);
  assert.equal(hasServiceBus(), false);
  assert.equal(await getAgentDialectBias('hanako'), null);
});

test('拿到权重就返回，并带上正确的服务名和伙伴 id', async () => {
  const bus = fakeBus(() => ({ ok: true, data: { agentId: 'hanako', dialect: 'sichuan', bias: BIAS } }));
  setServiceBus(bus);
  clearDialectBiasCache();
  const bias = await getAgentDialectBias('hanako');
  assert.deepEqual(bias, BIAS);
  assert.equal(bus.calls.length, 1);
  assert.equal(bus.calls[0].type, 'app:shuo-fangyan/dialect-bias');
  assert.deepEqual(bus.calls[0].payload, { agentId: 'hanako' });
  assert.ok(bus.calls[0].options?.timeout > 0, '要带超时，不能无限等');
});

test('没开方言（bias 为 null）也照原样返回 null', async () => {
  setServiceBus(fakeBus(() => ({ ok: true, data: { agentId: 'hanako', dialect: null, bias: null } })));
  clearDialectBiasCache();
  assert.equal(await getAgentDialectBias('hanako'), null);
});

test('对方没装或报错时静默降级，不把异常抛给发图链路', async () => {
  setServiceBus(fakeBus(() => { throw new Error('no handler'); }));
  clearDialectBiasCache();
  assert.equal(await getAgentDialectBias('yunying'), null);
});

test('缓存命中时不再打扰对方', async () => {
  const bus = fakeBus(() => ({ ok: true, data: { bias: BIAS } }));
  setServiceBus(bus);
  clearDialectBiasCache();
  await getAgentDialectBias('yumi');
  await getAgentDialectBias('yumi');
  assert.equal(bus.calls.length, 1, '一分钟内同一伙伴只问一次');
});

test('不同伙伴各算各的，不串味', async () => {
  const bus = fakeBus((_, payload) => ({
    ok: true,
    data: { bias: payload.agentId === 'a' ? BIAS : null },
  }));
  setServiceBus(bus);
  clearDialectBiasCache();
  assert.deepEqual(await getAgentDialectBias('a'), BIAS);
  assert.equal(await getAgentDialectBias('b'), null);
  assert.equal(bus.calls.length, 2);
});

test('空 agentId 不发起请求', async () => {
  const bus = fakeBus(() => ({ ok: true, data: { bias: BIAS } }));
  setServiceBus(bus);
  clearDialectBiasCache();
  assert.equal(await getAgentDialectBias(''), null);
  assert.equal(await getAgentDialectBias(undefined), null);
  assert.equal(bus.calls.length, 0);
});
