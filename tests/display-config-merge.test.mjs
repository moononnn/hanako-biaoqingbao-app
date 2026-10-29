import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDisplayConfig, displayConfigSwitchesDiffer } from '../lib/display-config-merge.js';
import { resolveInputButtonSwitches } from '../lib/input-button.js';

test('本机关掉的输入栏按钮，导入搬家包后不会被重新打开', () => {
  const current = { inputButton: false, agentSelfNote: false, sizeMode: 'small' };
  const incoming = { inputButton: true, agentSelfNote: true, sizeMode: 'auto' };
  const merged = mergeDisplayConfig(current, incoming);
  assert.equal(merged.inputButton, false, '输入栏按钮要留本机的');
  assert.equal(merged.agentSelfNote, false, '伙伴配图自评总闸也要留本机的');
  assert.equal(merged.sizeMode, 'auto', '其余显示偏好照旧按迁移包覆盖');
});

test('包里没带的字段不会把本机的值抹掉', () => {
  const current = { inputButton: false, smallImageThreshold: 320, customThing: 'keep' };
  const incoming = { sizeMode: 'large' };
  const merged = mergeDisplayConfig(current, incoming);
  assert.equal(merged.inputButton, false);
  assert.equal(merged.smallImageThreshold, 320);
  assert.equal(merged.customThing, 'keep');
  assert.equal(merged.sizeMode, 'large');
});

test('本机还没动过开关时（缺键），包里带 false 也不能静默关掉按钮', () => {
  // 读取侧把缺键当 true（生效值 true），所以保留时必须用同一套默认值，
  // 否则「从没动过 + 旧包带 false」会变成静默关掉。
  const merged = mergeDisplayConfig({ sizeMode: 'auto' }, { sizeMode: 'small', inputButton: false, agentSelfNote: false });
  assert.equal(merged.inputButton, true, '本机生效值是开，就不能被包里的 false 带回去');
  assert.equal(merged.agentSelfNote, true);
  assert.equal(merged.sizeMode, 'small');
});

test('包里带的是不能当开关用的脏值时，也不能把本机关着的开关顶开', () => {
  // 读取侧认的是 `!== false`：一个字符串 "false" 在那边会被当成 true。
  // 放着不管就等于本机关着的开关被静默打开。
  const merged = mergeDisplayConfig({ inputButton: false, agentSelfNote: false }, { inputButton: 'false', agentSelfNote: null });
  assert.equal(merged.inputButton, false, '字符串 "false" 不能把本机的 false 顶成 true');
  assert.equal(merged.agentSelfNote, false, 'null 同理');
  assert.equal(displayConfigSwitchesDiffer({ inputButton: false }, { inputButton: 'false' }), true, '这种差异要说得出来');
});

test('包里没带这两个键时，不往配置文件里造键', () => {
  const merged = mergeDisplayConfig({ sizeMode: 'auto' }, { sizeMode: 'small' });
  assert.equal('inputButton' in merged, false);
  assert.equal('agentSelfNote' in merged, false);
  assert.equal(merged.sizeMode, 'small');
});

test('本机缺键而包里带 false 时，回执要能说出这个差异', () => {
  assert.equal(displayConfigSwitchesDiffer({ sizeMode: 'auto' }, { inputButton: false }), true);
  assert.equal(displayConfigSwitchesDiffer({ sizeMode: 'auto' }, { inputButton: true }), false);
});

test('两边都没有或类型不对时都不乱动', () => {
  const merged = mergeDisplayConfig(null, null);
  assert.deepEqual(merged, {});
  const weird = mergeDisplayConfig({ inputButton: 'yes' }, { inputButton: false });
  assert.equal(weird.inputButton, true, '本机值是脏数据时按生效默认（开）算，与读取侧一致');
  const notObject = mergeDisplayConfig([], { sizeMode: 'auto' });
  assert.equal(notObject.sizeMode, 'auto');
});

test('包里带的总闸和本机不一样时，要能说出来', () => {
  assert.equal(displayConfigSwitchesDiffer({ inputButton: false }, { inputButton: true }), true);
  assert.equal(displayConfigSwitchesDiffer({ inputButton: false }, { inputButton: false }), false);
  assert.equal(displayConfigSwitchesDiffer({ inputButton: false }, {}), false, '包里没带就不算差异');
  assert.equal(displayConfigSwitchesDiffer(null, { agentSelfNote: true }), false, '本机缺键时生效值就是 true');
});

test('分页开关也算本机总闸：包里带来的分页值不能改本机的', () => {
  const current = { inputButtonChat: false, inputButtonCode: true, inputButton: false, agentSelfNote: true };
  const incoming = { inputButtonChat: true, inputButtonCode: false, inputButton: true, agentSelfNote: true };
  const merged = mergeDisplayConfig(current, incoming);
  assert.equal(merged.inputButtonChat, false, '聊天页的开关要留本机的');
  assert.equal(merged.inputButtonCode, true, 'Code 页的开关也要留本机的');
  assert.equal(merged.inputButton, false, '旧的总闸同样留本机的');
  assert.equal(displayConfigSwitchesDiffer(current, incoming), true, '差异要说出来');
});

test('本机缺分页键时，包里带 false 不能静默把按钮关掉', () => {
  const merged = mergeDisplayConfig({ sizeMode: 'auto' }, { inputButtonChat: false, inputButtonCode: false });
  assert.equal(merged.inputButtonChat, true, '本机生效值是开，就不能被包里的 false 带回去');
  assert.equal(merged.inputButtonCode, true);
});

test('本机还是老形状（只有总闸）且用户按过关时，包里的分页键不能把按钮打开', () => {
  // 用户在 0.6.2 时代把输入栏按钮关掉了：配置里只有 inputButton:false。
  // 这时候导入一个来自 0.6.3 机器的搬家包（带 inputButtonChat/Code:true），
  // 合并侧若不按读取侧那条链回落，就会把用户按过的「关」静默打开，
  // 而且回执还会说「没差异」，用户完全不知情。
  const current = { inputButton: false, sizeMode: 'small' };
  const incoming = { inputButtonChat: true, inputButtonCode: true, sizeMode: 'auto' };
  const merged = mergeDisplayConfig(current, incoming);
  assert.equal(merged.inputButtonChat, false, '聊天页的老总闸是关的，不能被包里的分页键打开');
  assert.equal(merged.inputButtonCode, false, 'Code 页同理');
  assert.equal(merged.inputButton, false, '旧的总闸也要留着');
  assert.equal(displayConfigSwitchesDiffer(current, incoming), true, '这种差异必须在回执里说出来');
});

test('本机老形状且开关是开着的时，包里的分页键同样带不回来', () => {
  const current = { inputButton: true };
  const incoming = { inputButtonChat: false, inputButtonCode: false };
  const merged = mergeDisplayConfig(current, incoming);
  assert.equal(merged.inputButtonChat, true);
  assert.equal(merged.inputButtonCode, true);
});

test('本机自己写过分页键时，以本机的分页键为准（老键不再插手）', () => {
  const current = { inputButton: false, inputButtonChat: true, inputButtonCode: false };
  const incoming = { inputButtonChat: false, inputButtonCode: true };
  const merged = mergeDisplayConfig(current, incoming);
  assert.equal(merged.inputButtonChat, true, '本机自己写过聊天页的键，就按本机的');
  assert.equal(merged.inputButtonCode, false);
});

test('合并后的生效值必须跟读取侧算出来的一模一样', () => {
  // 这是本条规则真正要守的不变量：合并侧与读取侧的回落链不许分叉。
  // 分叉了就会出现「合并时以为保留住了、读出来却是开的」。
  const cases = [
    [{ inputButton: false }, { inputButtonChat: true, inputButtonCode: true }],
    [{ inputButton: true }, { inputButtonChat: false }],
    [{ inputButton: false }, { inputButtonChat: false }],
    [{ inputButtonChat: false }, { inputButtonCode: true }],
    [{ inputButtonChat: true, inputButtonCode: false }, { inputButtonChat: false, inputButtonCode: true }],
    [{}, { inputButtonChat: false, inputButtonCode: false }],
    [{ sizeMode: 'small' }, { inputButton: false }],
  ];
  for (const [current, incoming] of cases) {
    const merged = mergeDisplayConfig(current, incoming);
    const read = resolveInputButtonSwitches(merged);
    const expect = resolveInputButtonSwitches(current);
    assert.equal(read.chat, expect.chat, `聊天页开关应与本机一致：${JSON.stringify(current)} ← ${JSON.stringify(incoming)}`);
    assert.equal(read.code, expect.code, `Code 页开关应与本机一致：${JSON.stringify(current)} ← ${JSON.stringify(incoming)}`);
  }
});
