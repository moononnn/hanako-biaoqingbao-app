# 自动测试

## v0.2.11 批量撞上宿主 RPC 并发上限（2026-10-12）

```powershell
node --test tests/rpc-busy-retry.test.mjs tests/vision-model-host.test.mjs tests/batch-maintenance.test.mjs
node --check lib/rpc-retry.js
node --check server/_batch-tasks.js
node --check tests/rpc-busy-retry.test.mjs
```

结果：定向测试 **15 项全部通过**（新增6 项 + 识图路由 4 项 + 批量维护 5 项），三处语法检查通过。覆盖：busy 错误的四种形态识别、抛错型退避重试与线性退避时长（400/800）、重试用尽后原样抛回、`{ ok:false }` 型重试后保持原形状、非 busy 错误零重试，以及 `emitBus` 接住了 Promise 拒绝且不对进度事件重试。不调用真实模型/API，未运行全量测试与应用静态校验。

未解决：`APP_RPC_BUSY` 的真实调用源仍无本机证据（10-10 至 10-12 全部日志零命中），并发数字未改（保持默认 3、上限 8）；本次只保证撞上时不静默、能自愈一轮。

## v0.2.10 思考型视觉模型输出预算修复（2026-10-12）

```powershell
node --test tests/vision-model-host.test.mjs
node --check lib/shared.js
node --check tests/vision-model-host.test.mjs
```

结果：定向测试 **4 项通过**（原 3 项 + 新增 1 项预算断言），两处语法检查通过。覆盖：思考型视觉模型经宿主通道调用时 maxTokens 为 12000。不调用真实模型/API，未运行全量测试与应用静态校验。

未解决（本次未改，另记）：宿主通道只回 `content`，拿不到 reasoning 内容，`shared.js` 末尾那道「正文空则从 reasoning_content 捞 JSON」的退路在宿主路径上用不了；`finishReason` 在该路径上也恒为空，错误信息不带真实原因。

## v0.2.9 识图模型通道路由修复（2026-10-12）

```powershell
node --test tests/vision-model-host.test.mjs
node --check lib/shared.js
node --check tests/vision-model-host.test.mjs
```

结果：定向测试 **3 项通过**，两份语法检查通过。覆盖 Hana 模型在宿主通道可用但读不到 Provider 凭据时仍能识图、无宿主通道且缺凭据时继续明确报未配置、自定义 API 不被宿主通道截走（含残留 Hana 模型选择）。模型流与自定义 API 请求均由桩拦截，没有调用真实模型/API。未运行全量测试、应用静态校验或实机验收。

## v0.2.8 发布前全量验证（2026-10-11）

```powershell
node --test tests/*.test.mjs
py -3 tests/test_ball_target.py
py -3 tests/test_ball_wait_state.py
node <Hana 安装目录>/artifacts/server/<版本>/scripts/validate-app.mjs --dir <Hana 主目录>/apps/biaoqingbao-app --json
```

结果：`node --test` 共 **239 项全部通过**（v0.2.5 是 234 项；本版新增 2 项回填回归）；Python 离屏测试 `test_ball_target.py`（约 8.1 秒）、`test_ball_wait_state.py`（约 3.6 秒）各 1 项通过；`validate-app.mjs` 静态校验 0 error、1 warn（常驻的动态依赖未证明警告）。

本版两处改动与覆盖：

- **入口改名**：`AI识图未标记` → `一键补齐识图`（`ui/panel.html` 按钮文案与 tooltip、`ui/assets/sticker-manager.js` 加载态恢复文案、README、更新日志同步）。`tests/batch-maintenance.test.mjs` 里那条静态断言已跟着改名，漏改会直接红。
- **接上 `backfillTaggedAt`**（`index.js` 启动流程）：新增两项回归——一项验回填行为本身（有标签数据没时间的补上、已有时间的不动、再跑一次不写盘、补过的条目不再被判为未识图），一项静态断言盯 `index.js` 必须调用它，防止接线再次断开。
- 实机验收：使用者在 v0.2.7 包上点过一键补齐识图，按钮与识图链路正常（作者实机反馈）；本版只改了按钮名字与启动回填，未再跑一遍真实识图。

## v0.2.6 未识图一键入口与索引失败保护（2026-10-11）

```powershell
node --test tests/batch-maintenance.test.mjs
node --check server/api.js
node --check server/_batch-tasks.js
node --check ui/assets/sticker-manager.js
```

定向测试 3 项通过：未识图集合过滤、运行中任务/未应用结果保护、图库页按钮与 API 接线，以及向量服务全失败时返回真实错误且不改写原索引。网络响应使用模拟 HTTP 503，没有调用真实模型/API。`validate-app.mjs` 静态校验 0 error、1 项动态依赖提示；未运行全应用回归。App Manager 已重载，按钮真实点击与模型连通待验收。

## v0.2.5 发布前全量验证（2026-10-11）

```powershell
node --test tests/*.test.mjs
py -3 tests/test_ball_target.py
py -3 tests/test_ball_wait_state.py
node <Hana 安装目录>/artifacts/server/<版本>/scripts/validate-app.mjs --dir <Hana 主目录>/apps/biaoqingbao-app --json
```

结果：`node --test` 共 **234 项全部通过**（v0.2.0 时是 199 项）；Python 离屏测试 `test_ball_target.py`、`test_ball_wait_state.py` 各 1 项通过（Qt offscreen）；`validate-app.mjs` 静态校验 0 error、1 warn（常驻的动态依赖未证明警告）。

说明两点，避免下次误读：

- 静态校验对着**正式目录**跑，不是发布克隆。校验器要求目录名等于 manifest id（`biaoqingbao-app`），克隆目录名是 `hanako-biaoqingbao-app`，对着它跑会报 `INVALID_MANIFEST: id does not match its directory name`，那是校验器给生产装载器的规矩，不是应用有问题。
- Python 离屏测试在 `tests/`，不在 `python/`。

本轮新增/改动的测试：`tests/sticker-tool-card.test.mjs`（工具结果图卡全链路）、`tests/render-claim-diagnostics.test.mjs`（认领诊断）、`tests/log-trim.test.mjs`（日志封顶）、`tests/ball-message-card-ui.test.mjs`（+221 行，共用视图认领、租约、编号耐心、输入框高度）、`tests/ball-message-card-chat.test.mjs`、`tests/text-model-host.test.mjs`（assistant 块数组兜底）。

实机验收状态（如实记录，不当已解决写）：使用者在**两个新窗口**测试，两个窗口回复内插图正常、未出现末尾独立图；旧调试窗口不重启直接切回仍异常。单元测试覆盖的是认领、租约与通道逻辑本身，不等于所有切窗场景端到端通过。

## v0.2.5 工具结果图卡定向验证（2026-10-11）

`node --test tests/sticker-tool-card.test.mjs tests/sticker-delivery.test.mjs tests/sticker-after-turn.test.mjs tests/ball-message-card-ui.test.mjs tests/ball-message-card-chat.test.mjs tests/ball-message-card.test.mjs tests/message-card-attribution.test.mjs tests/render-claim-diagnostics.test.mjs`

结果：106 项直接相关测试通过；index.js、lib/sticker-delivery.js、lib/ball-message-card.js、ui/assets/message-card-view.js 及新增/修改诊断测试语法检查通过。TMP/TEMP 指定工作台。覆盖独立工具业务记录、details.card 保留、不另发 custom、不伪造 native 身份/来源、投递失败、不选图路径、全尺寸 data URL 剥离、显式 recordId、宿主上下文迟到和既有认领/反馈/聊天边界。首次运行扩大范围后 104 中 1 失败，原因仅旧 UI 诊断断言仍期望 0.2.4，更新后通过；真实首张新通道卡出现空上下文空指针，新增失败基线（归属到达前不应请求记录）后修复，此时 105 通过。交叉审查后再补常驻 query 的明确跨会话失败基线，修前旧图被 binding 短路保留；修后先收图/不认领旧记录，原归属返回时恢复，最终 106 通过。

实机：使用指定图库 ID，绕过向量/模型匹配；正式 App 管理工具重载后，第二张新通道测试卡有图片/反馈/聊天 DOM，业务记录成功载图 HIT=1、页面标记 render-diag-0.2.5。未写入反馈偏好、未发送聊天、未调用付费模型/API。桌面工具没有可识别会话控件，未完成切走切回或像素/标题视觉验收；不把 mounted/DOM/HIT 当作完整验收。旧窗口重复记录不迁移，纸飞机和 after-turn 保留旧通道。未运行全量测试。

使用者后续实机反馈：旧调试窗口重启 Hana 可恢复，不重启仅切回仍异常；之后两个新窗口均在回复内插图、未出现末尾独立图，暂时接受。提供样本 sess_0mv3fvfek_ca93c394139d3e58d1ef。仅记录反馈，未独立读取/重复测试；不把初步出图通过扩写为长期切窗与全部旧场景通过。

## v0.2.4 重复配图修复定向验证（2026-10-11）

`node --test tests/ball-message-card-ui.test.mjs tests/ball-message-card.test.mjs tests/render-claim-diagnostics.test.mjs tests/ball-message-card-chat.test.mjs`

结果：75 项相关测试通过；`node --check lib/ball-message-card.js`、`node --check ui/assets/message-card-view.js` 通过。先用真实形态 `/_surface/<身份>/paper-plane-message.html` 留下失败基线，原代码两个实例均报页面文件名，两条身份测试失败；修改后通过。新增覆盖：文件名不可作身份、持续续期超过六秒仍挡住第二实例、零宽停止续期后让位者可接管、旧实例恢复先认领、隐藏不续期、旧轮询回包不收起新记录、pagehide 释放/pageshow 重认领、其他实例及过期退出凭证不可释放新租约。兼顾共用视图的内联聊天与反馈回归。交叉审查指出恢复时身份迟到可能空白，已补失败基线并修复：宿主暂缺编号时复用已核对归属的上下文重新认领，明确切换会话时禁止回退旧图；新增同会话/跨会话边界验证，相关测试重新通过。

未运行应用全量测试，未调用付费模型/API；尚未重启后的真实界面验收。实机请检查：首次一张 → 切走切回仍一张 → 停留超过六秒/隔久切回仍一张 → 不喜欢/聊天入口正常。若再重复，按 v0.2.4 CLAIM 诊断继续定位，不宣称已实机解决。


## v0.2.3 认领诊断定向验证（2026-10-11）

`node --test --test-name-pattern="claim diagnostics|instance|surfaces that share|exact stamped|渲染认领" tests/render-claim-diagnostics.test.mjs tests/ball-message-card.test.mjs tests/ball-message-card-ui.test.mjs`

结果：11 项相关测试通过；后端图片卡、前端共用视图和新增诊断测试语法检查通过。覆盖身份摘要与长度、进程/模块标记、前一持有者/年龄、允许与拒绝结果、空身份与缺失页面版本、日志不可写仍保持原决策、页面版本参数及原认领行为。测试临时目录指定工作台，不读写真实运行时账本。未运行全量测试，未调用模型，未实机复现；不代表重复配图已修复。


## 0.2.0 本轮汇总

```powershell
node --test tests/*.test.mjs
python -B tests/test_ball_target.py
python -B tests/test_ball_wait_state.py
node <Hana 安装目录>/artifacts/server/<版本>/scripts/validate-app.mjs --dir <本项目路径> --json
```

零依赖。本轮四条主线：

- **人格文件读写层**（`tests/persona-io.test.mjs`）：优先走宿主 `ctx.resources`，拿不到才退回 `fs` 且如实报错；写入用乐观并发，冲突时宁可不写；agentId 白名单拦住 `__proto__` / `prototype` / `constructor`；区分「没权限」与「文件不存在」。
- **伙伴名单回归钉子**（`tests/agent-list.test.mjs`）：盯名单缓存本身（空结果不清缓存、脏行跳过、没显示名用 id 顶上），外加一条静态回归钉子——`/api/agents` 必须先走宿主名单、扫目录只留在兜底分支里，防止有人哪天把裸扫目录改回去。
- **版本对比**（`tests/style-diff.test.mjs`）：句级 diff 边界（引号内的感叹号不得把句子劈成半句、右引号不得计进开引号、孤立引号不得把整篇粘成一坨）、两版相同返回 null、找不到历史版返回 null 不编。
- 宿主模型通道、回合限流、图片卡渲染认领等既有测试全部保持通过。

最近结果：2026-10-10，`node --test tests/*.test.mjs` 共 **199 项**全部通过（v0.1.44 时是 162 项）；
Python 离屏测试 `tests/test_ball_target.py`、`tests/test_ball_wait_state.py` 各 1 项通过；
`validate-app.mjs` 静态校验 0 error 1 warn（常驻的动态依赖警告）。

未覆盖：方言人格块写入与「学我说话」总结的真实链路依赖宿主通道与真实模型，只能实机验；
单元测试盯的是路由分支、并发保护与 diff 逻辑本身。

## v0.1.44 本轮汇总

```powershell
node --test tests/*.test.mjs
```

零依赖。本轮五处修复，各自的来龙去脉见下面各节：

- 同一条图片消息只画一次（`claimRenderSlot` 渲染认领，见下节）
- 伙伴配的图不再把像素写进会话记录（只留 `[attached_image: 路径]`）
- 配图投递时机：空闲探测认对字段名、回复定稿后再投
- 配图卡两行控件宽度不再被宿主框反向带动
- 入口文件补回丢失的 `try`，新增 `tests/entry-syntax.test.mjs` 做回归

本轮抓到并修掉的一个问题：`tests/sticker-delivery.test.mjs` 里有一条断言还在要求
「伙伴配的图必须带图片内容块」，而实现在 10-09 那次修复里已经改成不内联了——改了实现
没同步断言，全量测试一跑就露出来。断言已按新行为重写（不带 image 块、改留路径引用）。

最近结果：2026-10-10，`node --test tests/*.test.mjs` 共 **162 项**全部通过；
Python 离屏测试 `tests/test_ball_target.py`、`tests/test_ball_wait_state.py` 各 1 项通过；
`validate-app.mjs` 静态校验 0 error。

## 同一条图只画一次（v0.1.42）

```powershell
node --test tests/ball-message-card.test.mjs tests/ball-message-card-ui.test.mjs tests/ball-message-card-chat.test.mjs tests/message-card-attribution.test.mjs tests/message-card-chat-log.test.mjs tests/sticker-delivery.test.mjs
```

零依赖。2026-10-09 实机发现：宿主把同一条图片消息挂了两个卡片实例（两个不同 surface，间隔 44ms 先后查同一条记录），同一张图在聊天流里被画了两遍。现在由后端认领、后端返回 `duplicate` 决定谁画。`tests/ball-message-card.test.mjs` 盯认领本身（先到者拿到绘制权 / 持有者续期不算重复 / 租约过期后来者能接管 / 空身份一律放行 / 不同记录互不干扰）；`tests/ball-message-card-ui.test.mjs` 盯前端（取数据那次必须带 surface 实例身份、撞上 `duplicate` 就不再拉图片也不出图、记录编号必须留在查询串第一位）。

未覆盖：真机上「先到的实例被中途清掉、后来者接管」这一段只有租约逻辑的单元覆盖，没有实机样本；根治要宿主不重复挂，我们这边只是兜底。

最近结果：2026-10-09，改动相关 6 个测试文件 **81 项**通过。

## 配图改成「本轮说完再投」＋卡片标题与伙伴名（v0.1.36 ~ v0.1.38）

```powershell
node --test tests/*.test.mjs
```

零依赖。这一轮修了三件事：① 流内卡卡头标题被宿主拒掉时退避重试（聊天流里的卡有时是「先挂上、后绑身份」）；② 伙伴名改从宿主名单取，应用沙箱读不到 `<hana 主目录>/agents/...`，自己拼路径会一路失败、退化成英文 id；③ 配图不再在这一轮的半路上投（那时会话正在生成中，宿主必然再叫一轮），改成回复定稿后再投，投前等会话静下来。新增 `tests/sticker-after-turn.test.mjs` 4 项盯队列纪律；撤回 v0.1.37 那句被实机复述的提示，连带撤掉它的 3 条断言。

最近结果：2026-10-07，全量 **152 项**通过，`validate-app.mjs` 静态 0 错 1 警（常驻的动态依赖警告）。

## 工具说明补厚（v0.1.35）

```powershell
node --test tests/*.test.mjs
```

零依赖。本版只改 `tools/` 下 5 个文件的描述文案，没有逻辑改动，测试项数不变。补的是管理类工具「什么时候用 / 什么时候别用 / 跟旁边的工具怎么分」：新图入库与改老图标签分开、浏览图库与按话题精准搜图分开、指定发某一张要先搜 id 再调 express、卡片上点过的三键反馈不要再用嘴记一遍。

最近结果：2026-10-07，全量 148 项通过，`validate-app.mjs` 静态 0 错 1 警（常驻的动态依赖警告）。

## 一个应用只占一个卡片（v0.1.34，未发布即撤回）

> 这一版合卡实测体验不可接受，已回滚到 0.1.33 的两卡结构（见 `PENDING_CHANGES.md` 同日那条），代码里已经没有这一版的东西。下面记的是当时的判定思路，不是当前实现；现在跑的是「面板 + 对话内图片卡」两张卡，两个 customType 共用后者。

```powershell
node --test tests/ball-message-card-ui.test.mjs
```

零依赖。清单只注册一张卡（面板，保留整页声明与左侧导航），`paper-plane-image` 与 `partner-sticker` 两个 customType 都指向它——宿主要求 `messageRenderers[].cardId` 必须指向一张带 `route` 的卡，而 `cards[]` 里每一条都会被卡片中心列成一张卡，所以「面板 + 对话内图片卡」必然显示成两张。聊天流里那张图片卡现在是面板页的第二张脸：`ui/assets/stream-mode.js` 按 `hana.surface.getContext()` 的 `embeddedSessionId` 判断这次落在聊天流还是别处（`slot` 不能当判据，聊天流与卡片中心打开的卡都是 `card`），判成聊天流就摘掉面板样式、清空 DOM、装上图片卡那一套，交给同一个 `message-card-view.js` 渲染。回归覆盖：清单只有一张卡、两个 customType 同卡、内联模板与独立页面逐字一致、引导门禁在判定前不开面板。

最近结果：2026-10-07，该文件 29 项全部通过；同轮全量 `node --test tests/*.test.mjs` 150 项通过，`validate-app.mjs` 静态 0 错 1 警（常驻的动态依赖警告）。

## 两张流内卡合成一张（v0.1.33）

```powershell
node --test tests/ball-message-card-ui.test.mjs
```

零依赖。清单只注册两张卡（面板 + 对话内图片卡），`paper-plane-image` 与 `partner-sticker` 两个 customType 共用后者——宿主要求 `messageRenderers[].cardId` 必须指向一张带 `route` 的卡，写成不存在的卡那条映射会被静默丢掉，流内卡就不画了。合成后配文按记录里的 `sender` 区分：伙伴配的图不配文（拆卡时那张 partner 页面压根没有 caption 节点），用户丢的图照旧显示自己写的那句。

最近结果：2026-10-07，该文件 27 项全部通过；同轮全量 `node --test tests/*.test.mjs` 148 项通过，`validate-app.mjs` 静态 0 错 1 警（常驻的动态依赖警告）。

## 卡片在重载 App 后的自愈（v0.1.32）

```powershell
node --test tests/ball-message-card-ui.test.mjs
```

零依赖。重载 App 会让已存在的卡片丢身份（宿主得重新挂），卡片不能干等：测试给一个「一开始无身份」的上下文，随后把身份补上并触发「页面重新可见」，断言卡片立刻重跑一次、把记录认回来（一次记录请求 + 一次图片请求），页面里不再留着「认不出来」的提示。

最近结果：2026-10-07，该文件 25 项全部通过；同轮全量 `node --test tests/*.test.mjs` 146 项通过。

## 入口行必须算进卡片高度（v0.1.31）

```powershell
node --test tests/ball-message-card-chat.test.mjs
```

零依赖。卡片的框是按我们上报的高度开的，漏算哪一行，那一行就落在可视区外面被裁掉（2026-10-07 实机：入口显示了，用户看不到）。测试给的沙箱里给入口行一个真实高度（26px），断言：入口隐藏时一个高度、点完「不喜欢」入口出现后要重报且正好高 26+8（一道 flex 间距）。

最近结果：2026-10-07，该文件 16 项全部通过；同轮全量 `node --test tests/*.test.mjs` 145 项通过。

## 聊天跟随伙伴模型 + 聊天记录生命周期（v0.1.30）

```powershell
node --test tests/message-card-chat-log.test.mjs
node --test tests/ball-message-card-chat.test.mjs
```

零依赖，两边都不碰宿主、不碰真实模型。

`message-card-chat-log.test.mjs` 管两件事：① 「跟随当前模型」的解析（正常配置、四空格缩进与引号、`chat: ""` / 只有 id 没 provider / 文件不存在都得老实地返回空、`models` 块外的 `provider`/`id` 不误抓；`readAgentChatModel` 留了 `homeDir` 口子给测试用临时目录）；② 聊天记录的读写与归一（没记录就是 null 不算错、盘上脏值一律丢、写得进读得回且不挤掉卡片别的字段、销案传 null 清干净）。

`ball-message-card-chat.test.mjs` 里与 v0.1.30 相关的三项：收起面板账还留着（入口改说「接着聊」，不再清服务端会话）、卡片重放后把记录接回来（两句话都在，旧建议与「哪几条不要了」一并还原，灰着的行按钮写「要改」）、确认改完就算销案（入口回到「和小花聊聊」，重开是新一轮、不堆旧气泡）。

最近结果：2026-10-07，全量 143 项通过，`validate-app.mjs` 静态 0 错 1 警（常驻的动态依赖警告）。

## 流内卡内联聊天与建议应用（v0.1.29）

```powershell
node --test tests/ball-message-card-chat.test.mjs
```

零依赖。挂的是真实共用视图（`ui/assets/message-card-view.js`）+ 一个最小 DOM（视图要 `createElement` / `appendChild` / `classList` / `querySelector`，图片卡那套 fakeElement 不够用），不是抄一份逻辑。`/api/display-config` 与 `/api/message-card-context` 仍不计入卡片数据请求的断言。

覆盖：入口只在点过「不喜欢」后出现（记录里已是不喜欢也直接给）、打开面板时图片与三键收起且尺寸按「面板 340 + 内边距 12」上报、发消息打到 `/api/sticker/chat` 并带上 `sticker_id` / `card_id` / `message`、回的正文落进消息流、建议卡只列真的变了的字段并给「现在 → 改完」、单行「这条不要」丢弃后确认时不提交该字段、确认成功变回执、确认失败把原因写进建议卡且按钮原地可重试、回包丢失时回查 `/api/list` 命中即判成功、模型没配给人话指路、收起清服务端会话并恢复原尺寸、两个卡片页面的聊天 DOM 与「面板高度不许用 vh」的静态约束。

最近结果：2026-10-07，13 项全部通过；同轮全量 `node --test tests/*.test.mjs` 134 项通过，`validate-app.mjs` 静态 0 错 1 警（常驻的动态依赖警告）。

## 流内卡片头标题（v0.1.27）

```powershell
node --test tests/ball-message-card-ui.test.mjs
```

零依赖。测两张卡共用的视图在记录到手后交给宿主的卡头标题：伙伴配图拼「{名字} 顺手配了张「{情绪}」的表情包」、自己发的图是「你丢了一张过来」；缺名字或缺情绪各退掉那一截，超长情绪（>8 字）整截退掉不切一半，换行与引号先清掉，空白名字当没有；标题策略显式 show、同一视图内 revision 严格递增；记录没到手时不抢着交标题。

最近结果：2026-10-06，24 项全部通过；同轮全量 `node --test tests/*.test.mjs` 119 项通过。

## 流内图片卡尺寸（v0.1.26）

```powershell
node --test tests/ball-message-card-ui.test.mjs
```

零依赖。测两张流内卡共用的视图（`ui/assets/message-card-view.js`）的尺寸上报，重点是「高度不许再量渲染结果」。

覆盖：宿主给的框只有 51px 高（切回对话框时的现场值）时，1254x1254 的图仍按上报宽度推算出至少 316 高；两倍高的竖图按宽缩放、不超图片高度上限；视口宽为 0 的不可见实例一次都不上报、变可见后恢复上报；页面隐藏时重新下发上下文不抢框；以及原有的宽度档位、切回重报、身份缺失不猜图、空上下文不抹图、跨会话拒收、迟到回包不串、反馈三键回写等 19 项。

最近结果：2026-10-06，19 项全部通过；同轮全量 `node --test tests/*.test.mjs` 114 项通过。

## 伪标记兜底（v0.1.25）

```powershell
node --test tests/pseudo-tag.test.mjs
```

零依赖。测模型把发图写成文字时的清洗与补发登记，不碰钩子分发与真实投递（那两条只能实机验）。

覆盖：现场那条真实样例（正文 + 独占三行的伪标记）、单行包裹块/自闭标签/收尾标签、夹在句子中间的不剪、普通含尖括号的正文原样返回、非字符串输入不炸、剪完不留长空行；注入登记的取回与清除、路径大小写、十分钟过期、标记已发图后的状态、同会话覆盖上一轮、空路径不崩。注入文案那一句在 `tests/observer.test.mjs` 里同时加了断言。

最近结果：2026-10-06，11 项全部通过，耗时约 0.01 秒；同轮全量 `node --test tests/*.test.mjs` 110 项通过。

## 分析内容构造（v0.1.12）

写在 `tests/observer.test.mjs` 的「分析内容」段里，跟其他观察器纯逻辑一起跑：

```powershell
node --test tests/observer.test.mjs
```

覆盖：尾巴全是工具往返时仍能捞到有正文的最近几轮、全是有正文的往返时仍是最近 6 条、完全没有正文时不硬凑、custom 角色不计入对话正文、剥掉 `<mood>` 内心草稿、单条过长截断、整段有长度上限。

最近结果：2026-10-05，含这 7 项在内共 74 项全部通过。

## 宿主上下文（v0.1.11）

```powershell
node --test tests/host-context.test.mjs
```

零依赖。盯的是两类“只在 App 环境才存在”的依赖：宿主的硬超时、宿主的网络出口。

覆盖：分析总预算吃完后不再重试、不传预算保持原有重试、预算充裕时照常重试、拿到正文一次收工、Jev 旁路走传入的宿主出口而不是全局 fetch、Jev 配置不全时直接跳过不发请求。

最近结果：2026-10-05，6 项全部通过；同轮全量 67 项通过。

## 宿主模型通道的 system 适配（v0.1.10）

```powershell
node --test tests/text-model-host.test.mjs
```

零依赖。用一个假的宿主 ctx（记下收到的 payload、回一段 NDJSON）验通道行为，不发真实请求。

覆盖：system 抽到 systemPrompt 且消息数组里不留 system、多条 system 合并、无 system 时不带该字段、非标准角色归一到 user、assistant 保留、空正文报 LLM_EMPTY_RESPONSE 不冒充成功、没选模型时拒绝且不发请求、自定义 API 不走宿主通道。

最近结果：2026-10-05，9 项全部通过；同轮全量 61 项通过。

## 配图注入接管（v0.1.9）

```powershell
node --test tests/observer.test.mjs
```

零依赖。测的是观察器与悬浮球路由里的纯逻辑，不碰模型调用与宿主钩子分发（那两条只能实机验）。

覆盖：频率抽样边界（0% / 100% / 恰好等于阈值 / 非法值与越界值钳位）、两阶段场景校准、关键词清洗（去重截长限个数、分隔符）、注入文案（点名 express、写死「一轮最多一张」、不再出现 tool_search 与 biaoqingbao_express），注入动作（追加到最后一条用户消息、数组型 content、无用户消息不注入、类型不认得时放弃）、分析文本构造（只取最后 6 条、tool_use 不混入、context 优先）、Jev 旁路状态、悬浮球路由前缀不再指回插件版。

最近结果：2026-10-05，28 项全部通过，耗时约 0.17 秒；同轮全量 `node --test tests/*.test.mjs` 50 项通过。

## 回合限流回归（v0.1.2）

```powershell
node --test tests/same-turn.test.mjs
```

零依赖（Node 内置 `node:test`）。测试直接加载 `lib/same-turn.js` 源码（data: URL），不给 App 根目录加 `package.json`，避免影响宿主加载方式。

覆盖：同一回合隔五分钟仍拒、连调 15 次只放一张、新消息内容且隔够时间放行、锚点变了但时间很近仍拦、拿不到消息文本时退回 60 秒兜底、不同会话互不影响、时钟回拨保守拦、锚点文本归一、长期运行不无限增长。

最近结果：2026-10-05，9 项全部通过，耗时约 0.16 秒。

## 纸飞机对话选择回归

```powershell
python -B tests/test_ball_target.py
```

依赖现有 PyQt6，无新增安装。测试在独立 Python 子进程中加载真正的 `python/ball_app.py`，使用 Qt offscreen 平台，不显示或操作桌面窗口；模拟代理回包与目标保存，状态路径指向临时目录，不接宿主、不写图库与正式配置。

覆盖：真实 Ball/TargetMenu 的后台完成信号、五条对话列表展示、固定目标、切回自动、请求结束标记。父进程核对退出码与非空 PASS 标志，原有 0xC0000409 崩溃也会判失败。

最近结果：2026-10-05，1 项测试通过，内部连续 60 轮列表/固定/自动切换，耗时约 8 秒。此前仅代表隔离环境通过；后续实机反馈已确认纸飞机崩溃问题修好。

## 纸飞机等待态卡片（v0.1.7）

```powershell
python -B tests/test_ball_wait_state.py
```

真实 Qt、offscreen 平台，不显示也不操作桌面窗口；`/send` 用 `threading.Event` 闸门卡住，让等待态在事件循环里真实停留一秒多，验收的是状态而不是瞬时快照。覆盖：投递后等待卡可见、按钮 `waiting` 属性为真且保持满色、等待文案带动画省略号、收到回包后卡片切 `sent` 回执且面板留在原地不再自动收、输入框恢复可编辑且重新选图能接着发、Esc 能关掉面板、失败回包后卡片与按钮状态全部回滚。父进程核对退出码与非空 PASS 标志。

最近结果：2026-10-05，1 项通过（约 2.6 秒，v0.1.8）。同轮 `test_ball_target.py`（60 轮）与 22 项 Node 测试一并通过，`validate-app.mjs` 静态零错误。

## 投递等待文案（v0.1.6）

仅调整 Python 页面按钮与提示，不修改等待/变色/重试/收窗流程。Python内存编译及三处文案校验通过；真实Qt60轮退出码0，Node22项测试全部通过。v0.1.5的卡片收窄已获实机明确确认。

## 流内纸飞机图片卡（v0.1.3）

```powershell
node --test tests/*.test.mjs
```

当前 22 项 Node 测试全部通过，其中图片卡相关 13 项（v0.1.5 新增紧凑宽度上报测试）：不可变图文快照、跨消息/跨会话绑定、重复发送防护、超时和空回包不假报成功、损坏记录阻止盲重发、路径穿越拒绝、同图字节复用、图片与语义单消息组合、前端逐条编号取数、向宿主同时上报316px宽度及内容高度、配文仅用 textContent、无编号不取最新图、跨会话拒绝、丢弃旧异步回包。

Qt 回归收尾曾偶发 `0xC0000005`；测试脚本已给延迟选择回调加停止闸门、给测试定时器挂父对象，并明确在 QApplication 仍活着时处理残留事件及销毁独立顶层窗口；最终连续 5 次共 300 轮均退出 0。这属于测试清理的补强，未修改正式 ball_app.py，不能据此宣称历史访问冲突根因已被完全解释。

另外对当前宿主 0.1059.0 做了真实模块验证：Pi `convertToLlm` 保留自定义消息中的 text + image 两个内容块并转换为一条 user 模型输入；宿主实际 `CN/pht` 投影函数确认 `a_` + 20 位小写十六进制编号原样保留（旧的自定义前缀会被宿主重新派生，不能用）。

应用静态校验零错误；仅有动态资源尚未实机证明的常规警告。已通过 App Manager 重载，实机已确认发图到达伙伴、图文图片卡可展示；连续两图不串、动态图和历史回看仍需验收。v0.1.4 仅同步发送者文案，21 项 Node 测试重新全部通过，标题及来源说明额外校验通过。内联图内容会随 custom entry 进入会话原始数据，保留现有 20MB 原图上限；快照另按内容哈希复用，避免同一图库图片重复复制。

## 卡片显示、三键反馈与尺寸档位（v0.1.17 / v0.1.18）

```powershell
node --test tests/ball-message-card.test.mjs tests/ball-message-card-ui.test.mjs
node --test tests/*.test.mjs   # 全量
```

卡片 UI 测试挂的是真实共用视图 `ui/assets/message-card-view.js`（在 `vm` 沙箱里去掉 `import`/`export` 后执行），不是抄一份逻辑再测，所以改视图时测试会一起动；`/api/display-config` 与 `/api/message-card-context` 这两个前置/诊断请求不计入卡片数据请求的断言；沙箱里必须给 `URLSearchParams`，否则「从窗口地址找记录编号」那条会静默失效。覆盖：卡片记录字段（stickerId / agentId / emotion / 反馈状态落盘，且不碰图片快照与投递状态）、三键状态机（同维度取消、跨维度 both、both 再点剩另一个、脏值归一）、同一张卡重新出现时必须重报尺寸、点应景要 POST 到 `/api/message-card/feedback` 且带上本条卡片编号、记录里的反馈状态要回显到按钮、卡片宽度跟图片自然尺寸与档位走、宿主没给身份时窗口地址里的编号能认回记录、已载入的图不被后来推来的空上下文抹掉、两个页面都不再有来源行。

反馈路由本身（按卡片记录落偏好、撤销与失败回滚）不在 Node 单测里造账本，实机点一次三键验收；渲染与交互的最终判断同样需要实机。

最近结果：2026-10-06，全量 93 项通过（约 2.4 秒），`validate-app.mjs` 静态 0 错 1 警（动态资源未实机证明）。


## 卡片尺寸不再依赖 vh（v0.1.23）

```powershell
node --test tests/ball-message-card-ui.test.mjs   # 含 2 项新增回归
```n
覆盖：卡片页面的 img 高度上限不得出现 vh（vh 与上报高度互相驱动会成循环）、尺寸上报必须有 1px 容差、现场日志要记图片自然宽高。

最近结果：2026-10-06，全量 95 项通过（约 2.4 秒），`validate-app.mjs` 静态 0 错 1 警（动态资源未实机证明）。


## 两张卡的归属文案不得共用（v0.1.24）

```powershell
node --test tests/message-card-attribution.test.mjs   # 3 项
```n
覆盖：伙伴配图注入文案必须写「你自己刚发出的」且不得出现「理解用户消息」、纸机卡保持原样、payload 按 sender 分支选文案。

最近结果：2026-10-06，全量 98 项通过（约 2.4 秒），`validate-app.mjs` 静态 0 错 1 警（动态资源未实机证明）。

