// 卡片报到时序 — 2026-11-06 issue #4 回归
//
// 事故经过：宿主打开 panel.html 这张卡片先转圈，收不到页面报的 `hana.ready`
// 就一直等到超时，于是每次开卡片都要空转约 10 秒才出页面（接口实测 3~14ms，
// 不是加载慢，是在等一个永远不到的信号）。根因是这个页面从头到尾没发过 ready。
//
// 修法是把报到排到引导脚本最前面：后面取 /api/boot、动态加载 340KB 主脚本
// 都要时间，但那与「页面已经起来了」无关。这里用静态断言把这个顺序钉住，
// 免得以后有人再往前面塞东西时把报到挤到后面去。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'ui', 'panel.html'), 'utf-8');

test('panel.html 报到排在 /api/boot 与主脚本之前', () => {
  const readyAt = html.indexOf("type: 'hana.ready'");
  const bootAt = html.indexOf("'/api/boot'");
  assert.ok(readyAt > -1, 'panel.html 里找不到 hana.ready 报到：宿主会等到超时才收转圈');
  assert.ok(bootAt > -1, 'panel.html 里找不到 /api/boot 引导请求');
  assert.ok(readyAt < bootAt, '报到必须排在引导请求前面，否则又要空等一轮');
});

test('panel.html 两种报到形态都在（宿主协议 + 旧协议兜底）', () => {
  assert.match(html, /protocol: 'hana\.plugin\.ui'/);
  assert.match(html, /\{ type: 'ready' \}/);
});

test('报到只发一次就够，不随数据回来重复发', () => {
  const readyAt = html.indexOf("type: 'hana.ready'");
  const tail = html.indexOf("fetch(BASE + '/api/boot'");
  assert.ok(tail > readyAt);
  const afterFetch = html.slice(tail);
  assert.equal(afterFetch.includes("type: 'hana.ready'"), false, '补发报到只会让宿主重复走一遍握手');
});
