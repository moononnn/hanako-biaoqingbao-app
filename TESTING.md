# 自动测试

## 2026-10-22 输入栏表情按钮改成开关（再按一下收起）

需求：输入栏那个表情按钮按一下打开面板，希望再按一下能关掉。

改法：

- `lib/sticker-input-panel.js`：`stickers.open_compose` 工具里维护 `openPanels`（sessionId → ticket）。同一段对话、同一张票又点一下时，先 `sdk.userInteraction.dismiss({ sessionId, id })` 再清记录，回一句「表情面板已收起。」；否则照旧 show 并记一笔。
- 新增 `POST /api/sticker-compose/panel-hidden?ticket=`：面板自己被关或被隐藏时前端报一声，后端按 ticket 清掉开着标记，避免下次点按钮误判成「收起」。`/close` 路由顺手也清标记。
- `ui/assets/sticker-compose.js`：`visibilitychange`（hidden）与 `pagehide` 时用 `navigator.sendBeacon` 报 hidden；`document.addEventListener` 包了 try，老宿主/砂箱里没有也不会抛。

命令与结果：`node --test tests/sticker-input-panel.test.mjs tests/entry-syntax.test.mjs tests/sticker-compose-search.test.mjs` **38 项通过 / 0 失败**（其中 sticker-input-panel 27 项）。本轮改写了两个旧用例：原来的「重复打开保留票」现在按新语义分三下验证——第一下 show、第二下 dismiss（dismissed=1）、第三下再 show 且票不变；另加一步：先报 panel-hidden 再点，应该是打开而不是收起。100 次发送后重开那条也改成「一下收、一下开」。

实机验收（2026-10-22）：作者重载后确认第二下能收起，开关行为成立。诊断期的那两行成功日志已收掉，只留着 dismiss 失败时的一行痕迹（下次重载自然生效，不用为它专门重载）。仍未验证：收起后再打开时草稿与选中图是否原样还在（逻辑上票没变，但没实机看）。宿主把面板收成一条（collapsed）也算 hidden，那种状态下再点按钮会走「重新打开」而不是「收起」，这是有意选的行为。

## 2026-10-22 纸飞机分类管理补全（改动 / 删分类，＋分类收进管理态）

需求（作者实机反馈）：管理点了之后没法改或删分类；「＋分类」也要进了管理态才出现。

改法：

- 分类行末尾的「＋分类」改成 `setVisible(self._managing)`，平时不露。注意顺序：先 `addWidget` 再 `setVisible`，否则无父控件的按钮会被当成独立窗口去显，之后 `isHidden()` 一直为真。
- 管理态 + 选中某分类时，分类行下方出现 `categoryTools`：`正在管：XX` + 「改名」+「删分类」。不塞进分类行，是因为 320 宽加两个按钮会把「＋分类」顶出视野。
- 删分类两步：第一下只把文案变「再点一次」，第二下才 `POST /category-delete`；成功后提示「分类删掉了，里面的图还在收藏里」，若正看着该分类就回到全部。
- 改名走新增的 `TextPrompt`（跟分类弹层同一张脸：paintEvent 自绘底），预填旧名、回车即存，`POST /category-rename`。
- `CategoryPicker._create_category` 成功后会叫面板 `_render_category_bar()`：以前新建完分类行不长新 tab，得等下次拉数据。
- 分类按钮宽度用 `ensurePolished()` 后的 `fontMetrics` 量一遍（必须在 `addWidget` 之后，否则拿不到父级样式表字体）；分类行 host 用 `QLayout.SizeConstraint.SetMinimumSize` 自己撑宽，避免 QScrollArea 把按钮压窄、字被切。

命令与结果：`python -B tests/test_ball_categories.py` **1 项通过 / 0 失败**。本轮新增断言：平时 `add_category_btn.isHidden()`、管理态不 hidden；管理态选中分类后 `category_tools` 可见且说明文案含分类名；点「改名」弹出的卡预填旧名、提交带 `{id:'c1', name:'划水'}`；「删分类」第一下只变文案不真删，第二下才发 `/category-delete`。`test_ball_target.py`、`test_ball_wait_state.py` 各 1 项通过。

离屏抓图（`_tmp_preview_ball/render_panel.py`）：普通态确认分类行没有「＋分类」；管理态选中分类确认工具行与两个按钮的位置、颜色；另打印了四个分类按钮的 geometry，确认不重叠（0-67 / 72-148 / 153-220 / 225-292，间距 5）。

未覆盖（2026-10-22 已部分补）：分类删除经作者实机验收确认可用；改名仍未在真库上实际改过名字；分类多到需要横向滚动时的手感未验。

## 2026-10-22 「放进分类」弹层背景透明 + 跟面板风格统一（本地，版本未动）

现象（作者实机截图）：弹层几乎没有底，能透出后面的聊天内容；布局也跟纸飞机面板不像一家人。

根因（最小复现确认）：`QFrame` + `WA_TranslucentBackground` 时，QSS 里的 `background` / `border-radius` 根本不画。三类对照抓图像素：translucent + styled → 透底；translucent + 不 styled → 透底；不 translucent + styled → 正常白底。所以不是选择器或 `WA_StyledBackground` 的问题，是透明窗口把 QSS 背景吃掉了。纸飞里其他弹层（BallContextMenu / StickerContextMenu / TargetMenu）都有自绘 `paintEvent`，只有 CategoryPicker 漏了。

改法：`CategoryPicker` 加 `paintEvent` 自绘圆角白卡 + 淡阴影（跟右键菜单同一套），QSS 里把 `QFrame#categoryPicker` 的 background/border 改成 transparent；同时把弹层拉回面板语言：宽 `MENU_WIDTH`180 → `PICKER_WIDTH`248、内边距 14/13、间距 8、按钮 30→28px 圆角 9、说明 9→10px、复选框行加内边距；分类多了列表区内部滚动（`PICKER_MAX_LIST_HEIGHT`176）。

命令与结果：`python -B tests/test_ball_categories.py` **1 项通过 / 0 失败**（弹层里 `findChildren(QCheckBox)` 与 `_submit` 路径不变）；`test_ball_target.py` 1 项通过；`ball_app.py` 内存 compile 通过。离屏抓图（`_tmp_preview_ball/render_picker.py`）对比了 2 个分类与 8 个分类两种形态：白底、圆角、阴影、滚动都正常。

未覆盖：滚动条宽度与鼠标滚轮手感未在真机验；复选框指示器仍是系统绘制，只把尺寸定到 13px，没换自绘图。

## 2026-10-22 纸飞机拖动排序崩溃（exitCode 0xC0000005）

取证（`%USERPROFILE%\.hanako\app-data\biaoqingbao-app\probe.log`）：今天凌晨连续 5 次非正常退出，全部 `exitCode=3221225477`（0xC0000005 access violation），崩溃前最后一行分别是：

- `request_json 收到回包 /image?id=stk_266`（图片批量加载完 → 图集重建）
- `request_json 已写出 /pinned/reorder`（拖动排序松手 → 当时走 apply_items 全量重建）
- `request_json 收到回包 /pinned/reorder`（保存回包后下一轮轮询刷新 → 重建）
- `update_target_info 进入`

共同点都是「销毁旧图集按钮」那一刻，气泡里的 GIF 还在播。改法：

- `StickerButton.dispose()`：先 `frameChanged.disconnect`、再 `QMovie.stop()`、交掉 `_movie/_movie_buffer/_movie_data`，最后才让按钮走 `deleteLater`；`clear_grid` 统一先 dispose。
- 拖动排序松手改成 `_reslot_grid()`：只把现有按钮重新 `addWidget` 落格，不销毁不重建，避开整条销毁路径；找不到按钮才回退到全量重建。
- `_on_movie_frame` 对 `RuntimeError`（按钮已在销毁路上）直接返回；`BallPanel.shutdown` 多停一次所有动图。

命令与结果：`python -B tests/test_ball_categories.py` **1 项通过 / 0 失败**（新增断言：`_reslot_grid` 前后按钮对象 id 不变、落格顺序等于当前可见顺序、`dispose()` 后不再持有 QMovie）；`test_ball_target.py`、`test_ball_wait_state.py` 各 1 项通过；`ball_app.py` 内存 compile 通过。

另做离屏压测（`工作台 _tmp_preview_ball\stress_grid.py`）：24 张图（其中 3 张真实 GIF）反复跑「全量重建 + 只重排」40 轮，运行期无崩溃（结束时故意 `os._exit(0)` 跳过析构，以区分「运行期崩」和「退出时崩」）。

未覆盖：离屏平台走 raster 绘制，跟真实窗口的渲染路径不同，所以压测通过**不能**证明实机已好；本次修的是已知崩溃路径（销毁播放中的动图）与拖动重建，需作者重载后实测拖几次才算数。若仍崩，下一步是把 `apply_items` 的全量重建换成按 id 复用按钮。

## 2026-10-22 纸飞机面板圆角 + 「管理」挪右上角 + 配图手帐入口收起（本地，版本未动）

范围：`python/ball_app.py`（新增 `rounded_pixmap`，`StickerButton` 图标与 GIF 逐帧圆角，拖拽浮影与手帐/最近配图/聊天缩略图同走圆角；`HISTORY_ENTRY_VISIBLE = False` 收起配图手帐入口；顶部行新增「管理」按钮 `manageToggle`，管理态变「完成」并亮色；分类行去掉「管理」；底部批量条去掉重复的「完成」）、`tests/test_ball_categories.py`（分类行不再有「管理」、右上角按钮在、配图手帐入口隐藏、管理态文案与 `active` 属性、`rounded_pixmap` 四角透明）。

命令与结果：`python -B tests/test_ball_categories.py` **1 项通过 / 0 失败**；`python -B tests/test_ball_target.py`、`python -B tests/test_ball_wait_state.py` 各 1 项通过；`python/ball_app.py` 内存 compile 通过。改前同一用例在旧断言下失败 1 项（分类行应有「管理」），确认断言跟到了新契约而不是被改松。

另用 offscreen 渲染面板截图自查（
`工作台 _tmp_preview_ball\`）：图集方图四角已圆、右上角「管理」在岗、分类行末尾不再挤着管理、管理态底部条变松。

未覆盖：GIF 逐帧圆角只走了静态图路径，没拿真实动图测；真实宿主上的观感（面板圆角压在宿主背景上）待本人验收。

补充（同一轮，作者实机一眼看到分类 tab 还是直角）：根因是 `QPushButton#catBtn` 写的 `border-radius:999px`——网页里这套能让按钮变胶囊，Qt 样式表里半径超过控件半高就直接不画圆角，退化成方角。按钮实测高 28，半径改 14（半高）后正常；图标圆角比例同步从 0.18 提到 0.22（52px 图标上 ≈11px，对齐格子自己的 12px 边框），最小半径 5→8 让横图不发尖。另外发现「自动判断 ▾」在微软雅黑 UI 里没有 `▾`/`▴` 字形（`QFontMetrics.inFont` 实测 False）会渲染成方块，换成雅黑真有的 `▼`/`▲`。`python -B tests/test_ball_categories.py`、`test_ball_target.py`、`test_ball_wait_state.py` 均通过。

## 2026-10-21 复核轮的第二个阻断项修复（本地，版本定 0.5.1）

独立审查伙伴的增量复核又判 fail，两条都是真的：

1. **非布尔来源值能把本机的 false 顶成 true**：上一轮把判据改成「包里是布尔才处理」，于是包里带 `inputButton: "false"`（字符串）或 `null` 时，合并结果就是那个脏值；读取侧认的是 `!== false`，字符串 `"false"` 在那边会被当成 true——等于本机关着的开关被静默打开，而且差异判断因 next 非布尔直接返回 false，回执一个字不提。
   修法：`mergeDisplayConfig` 的循环改为「包里没带（`undefined`）就不动；带了（哪怕是脏值）一律按本机生效值处理」；`displayConfigSwitchesDiffer` 对非布尔来源值也判差异（本机有明确设置时）。
2. **回执在结果未知时就宣告同步完成**：`inputButtonNote` 那句「已按本机设置重新同步」是同步**刚发起**时就拼进去的，而同步是后台跑；后来全失败时回执照样说「已同步」。
   修法：改成进行态的「已开始按本机设置重新同步，结果见首页状态字」；并在该轮开跑前先把 `latestInputButtonSync` 置为 `pending`，免得这几秒里首页状态字显示的还是上一次那轮与本次无关的旧结论。

命令与结果：`node --test tests/display-config-merge.test.mjs` **8 项通过 / 0 失败**；全量 `node --test --test-concurrency=1 "tests/*.test.mjs"` **424 项通过 / 0 失败**。

## 2026-10-21 搬家包修复的边界补全（本地，版本定 0.5.1）

独立审查伙伴审过上一版后指出一个**反向**的边界漏洞：合并只在「本机这个键是布尔」时才保留本机值，而读取侧把缺键当 true（生效值 true）。于是「本机从没动过这个开关（生效 true）+ 旧包带 inputButton:false」→ 导入后按钮被**静默关掉**，而且回执一个字不提（差异判断也要求两边都是布尔）。

补法：

- `lib/display-config-merge.js`：新增 `EFFECTIVE_DEFAULTS`，保留总闸时用「本机生效值」（本机是布尔就用它，不是布尔就用默认值，与读取侧同一套算法）。包里没带这两个键时不往配置文件里造键；带了才落一个明确值。
- `displayConfigSwitchesDiffer` 改用同一套生效默认值比较，缺键的差异不再被漏报。
- 导入后的重同步接进序号仲裁（`isStale`）：用户在导入后几秒内又改了开关时，这一轮立刻收手，不会拿「导入时的旧值」盖回去。
- 导入后的重同步结果写回 `latestInputButtonSync`（首页状态字能看到），失败时落一条 warn 而不是只被 `.catch(() => {})` 吞掉；导入回执里补一句「输入栏按钮已按本机设置重新同步」。

命令与结果：`node --test tests/display-config-merge.test.mjs` **7 项通过 / 0 失败**；全量 `node --test --test-concurrency=1 "tests/*.test.mjs"` **423 项通过 / 0 失败**。

审查伙伴另提的几条按「非阻断不扩改」记下：退避判据只认错误文案（宿主改文案就退化成一次性失败，仍如实报失败）、`total` 是「列到的会话数」而非宿主会话总数、发布截图 `assets/release-screenshots/sticker-home.png` 是旧版首页布局（与 CHANGELOG 描述不符，截图更新需实机操作，未改）。

## 2026-10-21 搬家包导入静默重置开关的修复（本地，版本定 0.5.1）

审查伙伴指出（并经实测确认，属既有行为、非本版引入）：`lib/sticker-transfer.js` 的 `sanitizeDisplayConfig` 导出白名单只有 5 个键，**不含** `inputButton` 与 `agentSelfNote`；而 `server/api.js` 的 `mergeMigrationData` 对 `displayConfig` 走 `return incoming` 整份覆盖。于是导入一个搬家包，本机关掉的输入栏表情按钮会重新出现、伙伴配图自评总闸会被悄悄打开，且导入路径不触发 `inputStatus` 同步，文件状态与宿主实际状态会对不上。

修法（抽成可测模块 `lib/display-config-merge.js`）：

- `mergeDisplayConfig(current, incoming)`：包的字段覆盖本机同名字段，本机独有字段保留；`inputButton` 与 `agentSelfNote` 两个本机总闸**始终保留本机值**（本机值不是布尔就不当总闸处理）。
- `displayConfigSwitchesDiffer(current, incoming)`：包里带的总闸与本机不一致时能识别出来，导入回执里写明「包里的……与本机不同，已保留本机的」。
- `server/api.js`：`mergeMigrationData` 增加 `displayConfig` 分支走 `mergeDisplayConfig`；导入事务提交后（**提交前**先读本机原值）后台触发一次 `syncInputButton`，让会话里的实际状态和文件对得上——不 await，避免把导入按住几十秒。

命令与结果：`node --test tests/display-config-merge.test.mjs` **5 项通过 / 0 失败**；`node --check lib/display-config-merge.js server/api.js tests/display-config-merge.test.mjs` 通过；全量 `node --test --test-concurrency=1 "tests/*.test.mjs"` **421 项通过 / 0 失败**。

未覆盖：未在真实宿主上做过一次搬家包导入（需本人验收：导入一个含旧配置的包，关掉的开关应保持关闭，导入结果里应出现「已保留本机的」字样）；导入后的重盖是后台触发，耗时与结果未实机观察。

## 2026-10-21 复核轮的阻断项修复（本地，版本定 0.5.1）

独立审查伙伴对上一候选包判 fail，阻断项是**在跑状态的前后端契约对不上**：服务端 GET 原样返回在跑状态（只有 `reason:'pending'`，没有 `pending:true`），而前端轮询靠 `sync.pending` 判断是否继续等，于是第一次轮询（T+1s）就把「还在跑」当成最终结果，界面立刻显示「已关闭（没盖上）」并弹出「没能同步显示：pending」，轮询也不再继续。会话多时同步必然超过 1 秒，所以这不是边角。

修法：

- `lib/input-button.js` 新增并导出 `isInputButtonSyncPending(sync)`：「在跑」两种标记（`pending:true` 与 `reason:'pending'`）都认，server 与页面各用各的那一份判法（页面是浏览器脚本，不能 import 共享模块）。
- `server/api.js` 的 GET `/api/display-config`：在跑的状态补上 `pending:true` 再回。
- `ui/assets/sticker-manager.js`：`waitInputButtonSync` 与状态字都同时认两个标记；新增 `reason:'superseded'` 的处理（被新请求取代不算「没盖上」）。
- `lib/input-button.js` 的 `syncInputButton` 新增可选 `isStale` 回调，每次 `inputStatus.set` 之前先问一句：被更新的请求取代了就立刻收手，不再把旧值晚写进会话（序号原先只护「结果回写」，护不住副作用）。

命令与结果：`node --test --test-concurrency=1 "tests/*.test.mjs"` **416 项通过 / 0 失败**（新增 2 项：「还在跑」两种标记都认、被取代时立刻收手）；`node --check lib/input-button.js server/api.js ui/assets/sticker-manager.js tests/input-button.test.mjs` 通过。

未覆盖：pending 契约的修复没有端到端测试覆盖（server 路由层没有现成测试架），靠代码路径与审包复核确认；未在真实宿主里实测「同步超过 1 秒时界面不停在没盖上」。

## 2026-10-21 审包后收尾（本地，版本定 0.5.1）

独立审查伙伴对 0.5.1 候选包提的收尾项，本轮一并改掉：

- **服务端同步结果带请求序号**：`server/api.js` 的 `latestInputButtonSync` 加 `seq`，两个保存请求交叠时旧的后台任务不再覆盖新结果。
- **前端先比序号再写状态**：上一版 `waitInputButtonSync` 在比较序号之前就写了 `window.__INPUT_BUTTON_SYNC__` 并重绘状态字，序号只护住了提示、护不住状态字；现在先比序号再写，并新增 `stale` 标记让调用方不再多嘴。
- **退路路径的结果留日志**：`lib/input-button.js` 里「拿不到会话 id 退路全量同步」与「单会话补盖」两条路径的结果原先直接丢掉，现在各写一条日志。
- **会话截断要披露**：`syncInputButton` 统计被 2000 上限截掉的会话数并回传 `truncated`，界面会说明有多少会话没盖到。
- **事件负载兼容**：`session_created` 的会话 id 除了 `event.sessionId`，也从 `event.payload` / `event.data` 里再找一次（宿主文档说负载是平铺的，这是防御性兼容）。
- **导入搬家包覆盖 `displayConfig` 的问题**：审查伙伴指出搬家包导入对 `displayConfig` 是整份覆盖，`inputButton` 可能被抹掉。这属既有行为、不在本轮改动范围，记下来待下版处理。

命令与结果：`node --test --test-concurrency=1 "tests/*.test.mjs"` **414 项通过 / 0 失败**；`node --check lib/input-button.js server/api.js ui/assets/sticker-manager.js tests/input-button.test.mjs` 通过。

## 2026-10-21 审包三条建议的优化（本地，版本定 0.5.1）

按独立审查伙伴对 0.6.0 候选包提的三条非阻断建议改：

1. **同步结果带失败数**：`lib/input-button.js` 的 `syncInputButton` 统计失败会话数，返回值新增 `failed`，盖成了但有失败的会带 `reason: 'partial'`；全部失败仍报 `not-declared-yet` / `all-sessions-failed`。新增 `syncInputButtonSession(sdk, sessionId, enabled)`，只盖一个会话。
2. **新会话只补盖那一个**：`installInputButtonWatcher` 的订阅回调改读宿主事件投影（宿主文档：回调恒为 `(event, sessionPath)`，`event.type` 是类型名，`session_created` 负载带 `{ sessionId, sessionPath, agentId }`），拿到 `sessionId` 就只盖那一个；拿不到 id 才退回全量。上一版把 `event` 当字符串比（`event !== 'session_created'`），回调实际一次都没生效过。
3. **保存不再干等**：`server/api.js` 的 `POST /api/display-config` 改为先回包（`inputButtonSync.pending = true`），同步在后台跑，最近一次结果存模块级 `latestInputButtonSync`，由 `GET /api/display-config` 带出；`ui/assets/sticker-manager.js` 轮询该接口取最终结果，状态字与 toast 区分「同步中 / 没盖上 / 部分会话没盖上 / 正常」四种，并用 `inputButtonSyncSeq` 防止旧轮询结果盖掉新操作。

- 命令与结果：`node --test --test-concurrency=1 "tests/*.test.mjs"` **411 项通过 / 0 失败**（34.0s，比上一版多 3 项：`tests/input-button.test.mjs` 里的「会话事件带 sessionId 时只盖那一个会话」「单会话同步：盖成了就算数，盖不成就报出来」「同步结果带失败数：盖成了但也有失败的，要说部分而不是全好」）；`node --check lib/input-button.js server/api.js ui/assets/sticker-manager.js tests/input-button.test.mjs` 通过。
- 未覆盖：未在真实宿主里点开关并肉眼确认按钮消失/出现（需本人验收）；后台同步与页面轮询的实机时序未验；`session_created` 事件投影的真实形状只按宿主文档写，未在运行中的宿主上抓到真实事件样本。

## 2026-10-21 输入栏按钮开关挑到首页（本地，版本保持 0.5.0）

- 范围：`ui/panel.html`（首页状态条新增 `input-button-toggle-top` 与 `input-button-status-top`，样式沿用 `ball-toggle-wrap`；偏好页的 `sticker-input-toggle` 整格移除）、`ui/assets/sticker-manager.js`（`syncInputButtonToggle`/`toggleInputButton` 换成 `inputButtonEnabled`/`renderInputButtonState`/`toggleInputButtonTop`，挂到首页点击、`showView('home')` 与 `DOMContentLoaded` 初始化；`showView('preferences')` 去掉了已不存在的 sync 调用）、`server/boot.js`（默认 `__DISPLAY_CONFIG__` 补 `inputButton: true`）。
- 命令与结果：`node --test --test-concurrency=1 "tests/*.test.mjs"` **408 项通过 / 0 失败**（34.0s）；`node --check ui/assets/sticker-manager.js server/boot.js` 与 `node --check server/api.js lib/input-button.js` 通过。
- 未覆盖：未在真实首页点过这个新开关（需本人验收：点一下 → 状态字变 → 输入栏 🪄 跟着变）；未验证窄窗口下状态条折行后第三个开关的排布；未跑竖屏/移动端样式。

## 2026-10-21 输入栏表情按钮开关「关了不生效」修复（本地，版本保持 0.5.0）

两根一并修：

- `server/api.js` 的 `POST /api/display-config` 里同步调用写的是 `syncInputButton(sdk, …)`，但 `registerRoutes(app, ctx)` 的作用域里没有 `sdk`，一行 ReferenceError 被外层 `try {} catch {}` 吞掉——配置存了、同步一次没跑、界面还提示「已隐藏」。改传 `ctx`，失败不再静默，回包里带 `inputButtonSync: { ok, synced, total, reason?, error? }`。
- `lib/input-button.js` 装载同步原来只等 1.5 秒就盖，撞上「宿主还没投影本应用的 inputStatus 声明」（本机日志 `has no declared input status item sticker-compose`，09:25:24）后一次失败即放弃。改成退避重试 800/1600/3200/6000/10000ms，只对这类「声明没认」的错重试；权限/名单类失败不纠缠。`syncInputButton` 不再把「一个都没盖成」报成成功，回 `reason: not-declared-yet | all-sessions-failed`。会话上限 200 → 2000，改 8 个一批并发（本机会话已 322 个，原上限会让最新窗口漏掉，用户正看着的那个按钮就还在）；顺带避开串行 RPC 的耗时与高并发撞宿主 RPC 上限。`ui/assets/sticker-manager.js` 在同步失败时如实提示，不再拿「已隐藏」盖住没生效。

验证：`node --test tests/input-button.test.mjs` **7 项通过 / 0 失败**（覆盖默认显示、逐会话覆盖与单点失败隔离、列会话失败不假装成功、装载同步与新会话补同步、声明未投影时退避重试直到盖上、非声明类失败只试一次、回包带失败原因）。`node --test --test-concurrency=1 "tests/*.test.mjs"` 全量 **408 项通过 / 0 失败**（32.4s，比上版多的 7 项就是这个文件）。`node --check lib/input-button.js server/api.js ui/assets/sticker-manager.js` 通过。宿主实机：重载后日志 `输入栏按钮启动同步：ok 322/322`（修前为 `has no declared input status item` 并带崩装载）。

未覆盖：未在真实聊天窗口内点击开关并肉眼确认按钮消失/出现（需本人确认）；`session_created` 后的补同步只做单测，未等真实新窗口验证。

## 2026-10-21 输入栏表情按钮显隐开关（本地，版本保持 0.5.0）

`node --test --test-concurrency=1 "tests/*.test.mjs"`：**405 项通过，0 失败**（26.7s）；新增 `tests/input-button.test.mjs` 4 项（默认显示、逐会话覆盖与单点失败隔离、列会话失败不假装成功、装载同步 + 新会话补同步且订阅带第二参数）。`py -B` 两组纸飞机用例 OK，无 pyc 残留。

实现：`lib/input-button.js` 读 `display-config.json` 的 `inputButton`（默认显示），`syncInputButton` 列会话后逐个 `inputStatus.set({ sessionId, id: 'sticker-compose', visible })`；`installInputButtonWatcher` 在应用装载时同步一次，并订阅 `session_created` 补盖新会话。`/api/display-config` 收 `inputButton` 并当场同步；面板偏好页新增对应拨动开关。

边界：宿主只支持按会话的动态覆盖，且覆盖只活在本次宿主运行；重启后由应用装载时重新盖。本机未做宿主内实机验收（开关点击后的即时显隐、刷新后保持）——需本人确认。

## 2026-10-21 文字流内卡：试过、实机否决、已回退（本地，版本保持 0.5.0）

试过把文字改成 `session:send-custom` + 自己的 `sticker-text` 流内卡（405 项测试当时全过）。实机看到的效果：宿主给流内卡套了一层卡头「对话内文字」加复制按钮和边框，一句话被画成一张卡片，与聊天流不协调，本人当场叫停。

回退：`lib/sticker-input-panel.js`、`manifest.json`、`tests/sticker-input-panel.test.mjs` 回到 `93abf4b` 的版本（文字重新走 `session:send`，进度仍落盘 `compose-text/`）；删除 `lib/sticker-text-card.js`、`ui/sticker-text.html`、`ui/assets/sticker-text-view.js`、`tests/sticker-text-card.test.mjs`；清单校验用例恢复为两张卡、两个 customType。保留本轮之前的标题带名字改动（`server/api.js`、`ui/assets/message-card-view.js`）。

回退后 `node --test --test-concurrency=1 "tests/*.test.mjs"`：**401 项通过，0 失败**（29.9s）。之前那轮的 405 项记录只证明那个方案写过、能过测试，不代表它合适；实机否决优先。

未做：未在真实宿主验收卡片外观、模型是否把这句当用户原话、图文一次发送时的回合顺序；以上需实机确认。

## 2026-10-21 审包跟进项（本地，版本保持 0.5.0）

`node --test --test-concurrency=1 "tests/*.test.mjs"`：**400 项通过，0 失败**（23.8s，比上版多 2 项）。`py -B tests/test_ball_target.py` 与 `py -B tests/test_ball_wait_state.py` 各 1 项 OK（offscreen，无 pyc 残留）。改动文件 4 个 JS/Python 语法与内存编译通过，`git diff --check` 无空白错误。

本轮对应 v0.5.0 审包的四条非阻断跟进：

- 新增「没有 crypto.randomUUID 时也能报价」用例：vm 上下文里给空 crypto 对象，点发送后请求编号仍过服务端格式校验，草稿清空、按钮回到「发送」而不卡在处理中；另加静态断言，禁止再出现裸调 `crypto.randomUUID()`。
- 新增「重启后文字进度仍生效」用例：已接纳（accepted）值同一编号重试不再调 bus；不确定（unknown）值重启后仍拦住重复发送。
- `server/api.js` 删除原图失败改为写 `sticker-delete.log` 并在回包带 warning；静态断言限制日志名必须存在。
- `python/ball_app.py` 去掉 `_bridge_serial` 全局串行锁与它的包装函数，保留写锁与按 id 分发；内存编译通过。

测试隔离顺手修了一处：`harness()` 以前和其他用例共用同一个临时根目录，落盘进度加入后旧用例会互相污染，现改为每个 harness 单独建目录。

未做：没装宿主、没跑真实面板与纸飞机交互、没调模型；宿主上的实际视觉与延迟改善待本人复验。

## 2026-10-20 发布前全量（v0.5.0 候选）

`node --test --test-concurrency=1 "tests/*.test.mjs"`：**398 项通过，0 失败**（24.2s）。`python -B tests/test_ball_target.py`（1 项，offscreen）与 `python -B tests/test_ball_wait_state.py`（1 项）均 OK，未写入宿主或真实数据，无 `.pyc` 残留。改动相关的 8 个 JS（`index.js`、`lib/ball.js`、`lib/sticker-input-panel.js`、`lib/sticker-order.js`、`lib/fusion-service.js`、`ui/assets/sticker-compose.js`、`sticker-preview.js`、`sticker-reorder.js`）语法检查通过；`python/ball_app.py` 内存 compile 通过；`git diff --check` 无空白错误。

本轮收尾范围为文档与版本：README 新增「🪄 输入栏里的表情包按钮」一节（含截图 `assets/release-screenshots/sticker-input-panel.jpg`）、安装权限清单补 `app/input.status` / `app/input.panels` 一行、第一次使用新增一步并顺延编号；`manifest.version` 定为 `0.5.0`（发布候选）。README 文字内容经本人确认后落地，简介未动。未调用真实模型、未代发消息、未改真实图库；宿主实机视觉与图文实收以本人先前验收的截图为准。

## 2026-10-20 输入栏小魔杖入口（本地）

仅修改 manifest inputStatus 的文字和悬停提示。JSON 解析及定向断言通过：text 为 🪄、title/tooltip 保留表情包、工具绑定不变、版本仍为 0.4.1；差异格式检查通过。不跑无关业务测试；宿主 emoji 实际显示待本人验收。

## 2026-10-20 移除多余管理模式（本地）

`node --test --test-name-pattern="UI contract|UI right click" tests/sticker-input-panel.test.mjs` 定向 2 项通过；相关 JS 语法及差异格式检查通过。断言无管理节点、事件绑定及状态变量，保留右键标题/删除入口；模拟初始化、右键删除确认及拖拽提交同测通过。未删除真实图片或数据，未跑全量，宿主视觉待重新打开面板验收。

## 2026-10-20 标题编辑开头显示（本地）

`node --test --test-name-pattern="right-click title editor" tests/sticker-input-panel.test.mjs` 定向 1 项通过。模拟长标题聚焦时光标在末尾且横向偏移 160px，验证打开后 selectionStart/End 均为 0、scrollLeft 为 0，标题保持完整；保存及失败保留断言同测通过。相关 JS 语法与差异格式检查通过；宿主视觉待重新打开弹框验收，未全量、未调用模型、未修改真实标题。

## 2026-10-20 右键修改标题与标题同步（本地，版本保持 0.4.1）

`node --test --test-concurrency=1 tests/sticker-input-panel.test.mjs tests/sticker-preview.test.mjs`：**30 项通过，0 失败**；两份相关 JS/MJS 语法、Python 内存 compile 与 `git diff --check` 通过。隔离提取 Python `_on_pinned_polled` 的 4 条回调检查通过：同 ID 同标题不刷新、同 ID 改标题刷新、过期结果忽略、忙碌时忽略，不导入/启动 PyQt，不产 pyc。

新增用例验证右键标题编辑器预填、空标题拦截、只发送主页同款 `{action:'update', id, description}`、失败保留弹窗/输入/重试按钮、确认成功才关闭、刷新显示新标题且不改其他标签。最初一次测试中模拟 JSON 响应错误共用同一对象引用，修正为真实响应一样的独立副本后通过；没有为通过测试改弱业务断言。独立只读复核无阻断。

保存复用 `server/api.js` 现有 update 写队列、元数据持久化及 `upsertTeachingSample` 异步链，没有新增后台写入通道。注意：现有教学需要 embedding 成功才保存教学样本；标题保存成功不等于教学已完成，UI 只提示“标题已保存”。未实际调用教学/识图模型，未改真实图库或发送消息，未跑全量；真实宿主的弹框视觉和新一轮识图命中效果尚未验收。纸飞机同步现在也比对标题，取代前一轮“ID 不变不检测描述”的限制。

## 2026-10-20 右键整理与双入口手动排序（本地，版本保持 0.4.1）

本轮按明确选择更新排序规则：我的图集/纸飞机改为共享手动顺序，新加入放最前；从图库添加继续按入库时间降序。此前本日时间排序验收保留为历史记录，不代表本轮图集仍锁定时间顺序。

```powershell
node --test --test-concurrency=1 tests/sticker-input-panel.test.mjs tests/sticker-order.test.mjs tests/sticker-preview.test.mjs
node --check lib/ball.js
node --check lib/sticker-input-panel.js
node --check ui/assets/sticker-compose.js
node --check ui/assets/sticker-reorder.js
git diff --check
```

定向 **34 项通过，0 失败**，4 份 JS 语法检查与差异格式检查通过。`python/ball_app.py` 内存 compile 通过，不生成 pyc；另有隔离纯 Python 回调验证通过（未启动 GUI）。涵盖右键菜单打开、删原图先确认且取消不删除、拖拽提交完整顺序、向前/向后移动和无效落点、新增置前与重复加入不移位、两入口读写共用顺序、缺成员/重复成员/无效票据拒绝，及发送、草稿、预览回归。

纸飞机可见时每 8 秒仅比对图集 ID 顺序，未变不拉图片；隐藏/拖拽/排序保存/发送期间不刷新，过期读取不覆盖新排序，仍存在的选中图保持选中。该同步不检测 ID 未变的描述更新。未触碰真实图库内容，未代发消息、未调用模型、未跑全量；真实宿主右键/拖动及两端可见联动仍待本人验收。

## 2026-10-20 图文分开发送、成功清理与紧凑底栏（本地，版本保持 0.4.1）

反馈基线：输入框文字显示在图卡内，已发送内容在后续重新打开时仍残留，底栏偏高且关闭入口重复。原发送处理用可见性 epoch 过滤成功回执，收起/重开后可能直接跳过清理；此旧版未另做宿主实机复现，不用修复后通过倒推原宿主现象。

```powershell
node --test --test-concurrency=1 tests/sticker-input-panel.test.mjs tests/ball-message-card.test.mjs tests/sticker-preview.test.mjs tests/sticker-order.test.mjs
node --check lib/sticker-input-panel.js
node --check ui/assets/sticker-compose.js
node --check tests/sticker-input-panel.test.mjs
git diff --check
```

本次定向 **49 项通过，0 失败**，3 份 JS/MJS 语法及差异格式检查通过。覆盖图卡无配文/独立普通文字消息、纯图只由最后一张触发、文字明确拒收只重试文字、文字超时不重投、成功期间可见性变化仍清空、迟到回执不清另一票据草稿、重挂核对完成态后清除已发图文、失败保持草稿，以及原图片投递、排序与悬停回归。独立只读审查未发现阻断。

视觉改动：输入框与发送按钮固定为 40px 高，文本仍可换行并在框内滚动；删除 HTML 的右上角收起节点和对应 JS 绑定，保留宿主关闭入口。仅做相关静态检查，尚未做本轮宿主实机视觉与图文实收验收；未代发消息、未调用真实模型、未跑全量。已发布的历史图卡不改写。

## 2026-10-20 图集统一新到旧（本地，版本保持 0.4.1）

`node --test --test-concurrency=1 tests/sticker-order.test.mjs tests/sticker-input-panel.test.mjs`：**22 项通过，0 失败**。4 份改动相关 JS/MJS 语法检查通过；`python/ball_app.py` 使用内存 `compile` 检查通过，不生成 pyc；`git diff --check` 通过。

覆盖入库时间降序而非识图时间、缺失/非法时间放后、同时间稳定排序、数值时间、源数组/图库不被排序写回、面板图库和快捷图集不随原 pinnedIds 顺序，以及纸飞机两条列表路由共用排序器/界面不再绑定拖拽改序的静态契约。纸飞机真实 PyQt 交互与打开后的显示尚待本人验收；未跑全量、未调用真实模型、未迁移或改写真实图库。现有手动排序数据保留，只不再作为这些发送入口的展示顺序。

## 2026-10-20 缩略图裁切修复与悬停预览（本地，版本保持 0.4.1）

基线：连续滚动版本未设置固有行高，100 张图的隔离浏览器页面中，图片约 139px 高而格子仅约 4.8px，整库被压入容器。按同场景将自动行改为 max-content、格子保留内容高度后，格子约 169.5px，图库产生正常滚动。该复现使用测试图片与当前 CSS，不读取真实图库。

```powershell
node --test --test-concurrency=1 tests/sticker-preview.test.mjs tests/sticker-input-panel.test.mjs
node --check ui/assets/sticker-preview.js
node --check ui/assets/sticker-compose.js
node --check tests/sticker-preview.test.mjs
git diff --check
```

定向 **22 项通过，0 失败**，3 份 JS/MJS 语法检查及差异格式检查通过。新增 5 项预览回归覆盖宽窄/上下左右边界、延迟前移开不加载、迟到旧图片不覆盖新图片、收起/触屏/零尺寸视图，以及固有行高与完整缩放契约。既有 17 项面板用例一并通过。

另外在真实浏览器引擎的独立测试 iframe 测量：636×476 时格子约 99.9px、图片约 69.4px，图库可滚动且发送区位置不随滚动变化；316×476 时格子约 88.5px、图片约 58px，280×320 的预览完整位于视口内，图片加载完成。该验证不等于 Hana 宿主端到端验收；没有代发消息、真实模型调用或全量测试。正式重新加载后，实际面板仍需本人反馈。

## 2026-10-20 图库连续滚动（本地优化，版本保持 0.4.1）

`node --test tests/sticker-input-panel.test.mjs`：**17 项通过，0 失败**；页面 JS 语法与 `git diff --check` 通过。扩充现有 DOM 执行回归，覆盖 60 张不分页、未进入可视区不请求图片、进入可视区才读取像素、输入文字保留滚动位置及既有失败草稿保护；图片可见性使用模拟 IntersectionObserver，不替代真实宿主滚动与布局验收。仅改 UI/定向测试/技术文档，未跑全量、未代发消息、未调用真实模型。原生 inputStatus 的宿主校验仍仅接受 check/pin/sync，不支持自画图片，按钮保持原样。

## 2026-10-20 输入栏表情发送面板（本地开发，版本保持 0.4.1）

```powershell
node --test --test-concurrency=1 tests/sticker-input-panel.test.mjs tests/ball-message-card.test.mjs
node --check index.js
node --check lib/ball.js
node --check lib/sticker-input-panel.js
node --check ui/assets/sticker-compose.js
node --check tests/sticker-input-panel.test.mjs
git diff --check
```

定向 **34 项通过，0 失败**（新面板 17 项、既有图卡 17 项）；5 份 JS/MJS 语法检查及差异格式检查通过。新用例覆盖参数边界、仅最后一图触发回复、缺图预检、部分失败重试不重复前图、未知投递不盲重放、固定会话/sessionRef 编号、重复打开复用绑定、超过 100 条仍能发送并保留旧请求防重、纯文字 accepted 回执、共享 pinned 图集、失败保留正文、临时解绑/重挂恢复草稿。DOM 执行测试使用轻量模拟元素和模拟 SDK，不能代替真实 WebView 验收。

独立只读审查指出的重复打开丢草稿、会话编号形状及请求容量问题已修；迟到回执增加绑定代数隔离。未跑全量、未调用真实模型/API、未修改真实图库或代发消息。正式重新加载入口返回新增权限需本人审批：`app/input.status` / `app/input.panels`；因此新面板尚未确认加载生效，真实宿主显示、窄屏及纸飞机跨端刷新/图文实收待验收。现有 host=on、agent=on 仅说明原应用启用，不能当新功能加载证据。未修改版本、README、简介，未 commit/push/发布。

## 2026-10-18 Hana 1.1.24-beta 回复内图卡恢复（本地，验证时版本 0.4.0，发布定版 0.4.1）

```powershell
node --test --test-concurrency=1 tests/sticker-tool-card.test.mjs tests/sticker-after-turn.test.mjs tests/sticker-delivery.test.mjs tests/sticker-bridge-media.test.mjs
node --check index.js
node --check lib/sticker-delivery.js
node --check tests/sticker-tool-card.test.mjs
node --check tests/sticker-bridge-media.test.mjs
git diff --check
```

结果：四组定向测试 37 项通过，0 失败；4 份语法检查通过；`git diff --check` 无错误（Git 对现有工作树 CRLF 提示不影响检查）。覆盖 express 回复内卡片、回合末不再补投、Bridge `details.media.items` 保留、无会话编号与附件登记失败等边界。未跑全应用回归、未调用真实模型/API、未由助手代发 QQ 测试消息。之后经正式 App 管理入口重载，inspect 为 host=on、agent=on；应用列表仍显示 0.4.0。随后使用者实机确认电脑端与 QQ 均能正常收到图；该反馈仅覆盖本次电脑与 QQ 验收范围。

## 2026-10-16 使用者实机反馈：重启后旧会话恢复单卡与动态标题

标题优化重新加载后，使用者再次进入先前异常会话，仍见双卡和默认标题；随后自行重启 Hana，再进入同一会话，确认变为单卡且标题正常。此结论来自使用者实机反馈，未自动重启或触发新配图。

这证明该旧会话在重启后的当前显示可恢复；与运行中临时投影/视图绑定或旧页面状态有关的解释相容。尚未区分重启重建状态与新标题代码进入新页面的作用，不能归因为标题补丁已根治，也不能宣称双卡已解决。重启后新配图、再次切窗和长期稳定性未验收。本次只追加验证记录，不继续修改源码或扩大测试。

## 2026-10-16 标题恢复：补宿主可见性通知（本地优化，版本保持 0.3.1）

现场基线：同一业务/实例指纹曾返回 `CHROME-OK`，后续又见从 revision 1 开始的提交，约 10 秒后为 `APP_CHROME_UNAVAILABLE`。这只能支持页面重建/绑定不可用的可能，不能单凭实例指纹证明 Chrome generation、标题持续显示或故障根因。当前 SDK 的 Chrome 没有公开绑定订阅；重复 ready 不能据当前宿主处理器证明会重新发 Chrome challenge。后台 Chrome 正式接口契约存在，但当前项目 SDK 未暴露 surfaces；未扩大升级 SDK 或把后台写入接入生产。

确定的 App 缺口：旧实现只听 document visibility/pageshow 与业务上下文；宿主将 iframe 暂停再激活而这些事件不变时，不会补交缓存标题。本轮使用公开 `hana.lifecycle.getSnapshot/subscribe` 补该触发，暂停时使票据/定时器失效但保留同业务标题；仅可用边沿补交一次，初始不可用不提交，pagehide 后仍须 pageshow 恢复。无 lifecycle 的环境保留原上下文恢复路径。不额外取图、不改反馈、不增加重试次数，不触碰 SDK/宿主/投递逻辑。

修改前已备份 4 份相关源码/文档并核对 SHA-256。首批 5 个用例在优化前 **4 失败、1 通过**；之后加强 pagehide 下新业务边界并新增旧环境兼容用例。最终新增 6 项，使用同一组相关命令定向 **83 项通过，0 失败**（页面 51 项）：

```powershell
node --test tests/ball-message-card-ui.test.mjs tests/ball-message-card-chat.test.mjs tests/message-card-attribution.test.mjs tests/render-claim-diagnostics.test.mjs tests/message-card-chat-log.test.mjs
node --check ui/assets/message-card-view.js
git diff --check
```

独立只读复核未发现新增实质阻断；审查方未运行测试。未运行全量测试、未调用真实模型/API，版本/README/简介不变，未发布。真实宿主绑定不可用时仍可能无法更新标题，不能把单元测试通过当作现场已修好。已经由正式 App 管理入口重新加载当前源码，随后 inspect 为 host=on、agent=on；既有页面是否重建及真实切窗标题恢复仍待现场验收。

## 2026-10-16 卡头标题恢复试修与双卡隔离试验（版本保持 0.3.1）

修改前对 9 份相关源码/文档完成本地备份及哈希核对，保留同日图库安全改动。标题首批 3 个新增用例在修改前全部失败；修复后增加边界覆盖，以下定向 **77 项通过，0 失败**（页面测试 45 项）：

```powershell
node --test tests/ball-message-card-ui.test.mjs tests/message-card-attribution.test.mjs tests/render-claim-diagnostics.test.mjs tests/ball-message-card-chat.test.mjs tests/message-card-chat-log.test.mjs
node --check ui/assets/message-card-view.js
git diff --check
```

覆盖同业务/短暂空上下文补标题且不重复取图、旧业务迟到拒绝不重试覆盖、新业务缺会话归属不补旧标题、visibility/pageshow 恢复、pagehide 后失效、不可用有限重试耗尽、未确认回执不记成功及日志不含原始 surface 凭据。标题日志带仅供关联的实例指纹，不能充当授权身份。独立静态审查发现的新业务归属保护及实例诊断缺口均已修复并获窄复核；审查方未重复执行测试。

双卡使用当前 1.1.7-beta renderer 的真实流缓冲类与 server 历史内容解析器作只读隔离试验，**8 个结果断言通过**：提前投卡时 1 行、0 个未绑定卡行；turn 结束后投卡时 2 行、1 个未绑定卡行；把 plugin_card 塞入 assistant 内容会被历史内容解析丢弃。消息集合、持久绑定和定稿是测试夹具；未验证完整历史合并、挂载 UI、真实签名或模型。该结果不能证明现场双卡已解决。提前投卡可能引入模型 followUp、额外正文及调用成本，尚未获得取舍决定，生产投递逻辑未改。

未运行全应用回归、未调用真实模型/API、未编辑宿主或会话数据；未改版本、README、简介，未发布。标题代码已通过正式 App 管理入口重新加载，随后 inspect 为 host=on、agent=on；这仅确认当前源码已重新加载，既有页面是否重建以及真实 UI 标题恢复仍待现场验收。

## 2026-10-16 图库索引异常与旧图保护（本地开发，版本保持 0.3.1）

基线：源码提交 `550f4da`，修改前已备份涉及的源码；在独立临时图库运行首批 10 个保护断言，**10 项按预期失败**，复现损坏索引被当空库、继续上传/重写索引，以及偏好清理误删有效引用。真实图库未用于故障注入。

```powershell
node --test tests/gallery-integrity.test.mjs tests/batch-maintenance.test.mjs tests/batch-concurrency.test.mjs tests/batch-pause.test.mjs tests/ball-message-card.test.mjs tests/sticker-tool-card.test.mjs tests/secret-mask-guard.test.mjs tests/vision-model-host.test.mjs
```

最终定向 **88 项通过，0 失败**，其中 `gallery-integrity.test.mjs` 新增 **26 项**。7 份本次修改/新增的 JS/MJS 逐份 `node --check` 通过：`lib/shared.js`、`lib/ball.js`、`server/api.js`、`server/_batch-tasks.js`、`tools/add-sticker.js`、`tools/update-sticker-tags.js`、新测试文件。

覆盖：损坏 JSON/非数组/权限异常拒绝；首装正常上传；缺索引但有图拒绝误建库；扫描磁盘避开孤儿图编号；单图及 ZIP 的排他创建与碰撞清理；图片部分写入、索引提交失败；偏好清理保留原账；工具标签更新共用队列；坏索引不影响批量路由注册；旧备份恢复的冲突预检、额外现存图片保护、失败回滚重试、索引最后提交与硬链接不支持时安全失败。首次测试扩展中，3 项用例曾因同图/未清理测试指纹缓存触发正常去重而失败；已使用不同内容图片并在临时图库重置时清缓存，最终用上述命令复验通过。

独立静态交叉审查指出的恢复覆盖、半迁移和旧索引遗漏现存图片问题均已补保护并复核。已通过正式 App 管理入口重新加载当前磁盘源码；这只证明重新加载完成，不代表真实损坏图库、全部 UI 或跨平台验收。恢复索引的硬链接提交在本机临时目录通过；其他文件系统若不支持会拒绝自动恢复，不会降级覆盖。未运行全应用回归、未调用真实模型/API、未制造真实数据故障；未变更曝光统计、版本、README 或简介，未发布。

## v0.3.1 发布前完整验证（2026-10-15）

发布小工坊 `release.ps1 -Project biaoqingbao-app -Phase verify` 在隔离副本运行：**Node 312 项通过，0 失败**；Python 离屏测试 `test_ball_target.py`、`test_ball_wait_state.py` 各 1 项通过；**118 份 JS/MJS 语法检查通过**。没有调用真实付费模型/API。源码完整验证已通过，最终包核验、准确提交 CI 与独立交叉审包仍以本次发布证据为准。

Hana 1.1.7-beta + Windows 11 的出图、三键反馈与切窗恢复已由使用者实机确认。macOS/Linux、全新安装和真实数据迁移未在本轮重新验证。README 与应用简介原文保持不变。

## QQ Bridge 实收复验（2026-10-15，v0.3.1，使用者确认通过）

运行版本 0.3.1、宿主 Hana 1.1.7-beta。使用者在 QQ Bridge 会话中触发新表情，手机 QQ 确认收到图片。这是换宿主后的重新确认：该渠道在 v0.2.14、v0.2.15 两轮失败，v0.2.16 才在 1.0.16-beta 上首次通过。

证据边界：结论来自使用者本人实机确认，本次桥接回合**没有**对应的 `probe.log` 桥接标记作旁证；不外推到 Linux/macOS、其他宿主版本或其他外部平台。助手未代发 QQ 测试消息、未调用模型/API。

## 2026-10-15 Hana 1.1.7-beta 配图兼容（出图、按钮与切窗实机通过）

命令：`node --test tests/sticker-tool-card.test.mjs tests/sticker-bridge-media.test.mjs tests/ball-message-card.test.mjs tests/ball-message-card-ui.test.mjs tests/sticker-after-turn.test.mjs tests/sticker-delivery.test.mjs`。

定向 **93 项通过，0 失败**；`index.js`、`lib/sticker-delivery.js`、`lib/sticker-after-turn.js` 语法检查通过。覆盖工具不返回 iframe 卡、附件保留、定稿队列透传独立业务记录、跨回合同图可再次显示、accepted/unknown 不重复投递、长回复仍忙时重新排队、三键反馈与渲染认领。模拟 Bus，不调用真实付费模型/API；未运行全应用回归。本地重载后调用 express 指定 stk_586，使用者确认图片显示恢复，并明确补充按钮与切窗均已验证、没有问题；出图、三键反馈与切窗恢复实机通过。使用者反馈喜欢、应景等点击响应很快，未做延迟测量，不归因于具体代码变化。QQ 实收及全部历史窗口未验证。

## v0.3.0 发布前全量回归（2026-10-13）

```powershell
node --test "tests/*.test.mjs"
node --check <全项目 118 个 js/mjs 逐个>
python tests/test_ball_target.py
python tests/test_ball_wait_state.py
node <宿主>/scripts/validate-app.mjs --dir <解压后按 id 命名的安装模拟目录> --json
```

结果：全量 **308 项全部通过，0 失败**（源码树、解压副本、每一笔提交的中间快照各跑一次，均 0 失败）；JS 语法检查 0 失败（源码树与解压副本各一次）；Python 离屏测试 `test_ball_target.py`、`test_ball_wait_state.py` 各 1 项通过；宿主静态校验 0 错 1 警（常驻的动态依赖未证明警告）。未调用真实付费模型/API。

本版新增四个测试文件：`tests/batch-timing.test.mjs`（12 项，耗时估算，含一条拿「15 张并发 5 实跑 152 秒」当基准的断言，以及「快模型高并发不被误杀」）、`tests/batch-pause.test.mjs`（5 项）、`tests/batch-concurrency.test.mjs`（7 项）、`tests/secret-mask-guard.test.mjs`（7 项）；`tests/rpc-busy-retry.test.mjs` 扩充 6 项。

本版实机走通：暂停/继续、并发滑块、耗时预估、API Key 占位符防护。**未实机验证**：识图超时重试与 90 秒阈值（需真撞上超时才验得到）。

发布前交叉审查由只读审查伙伴独立跑过一轮，提出并已修：Codex 系分支超时未同步到 90 秒（文档与代码不符）、耗时估算的合理区间错施加在含并发的摊薄值上（快模型高并发被误杀）、批量并发兜底写成硬编码字面量而非读用户设置、`lib/batch-apply.js` 文件头指向不存在的 `routes/` 路径、README 漏写本版三项新能力、TESTING.md 声明项数过期。

## v0.2.13~v0.2.16 发布前全量回归（2026-10-12）

```powershell
node --test "tests/*.test.mjs"
node --check <全项目 113 个 js/mjs 逐个>
node <宿主>/scripts/validate-app.mjs --dir <解压后按 id 命名的安装模拟目录> --json
```

结果：全量 **269 项全部通过，0 失败**（源码树与解压副本各跑一次，均 269 通过）；113 个 js/mjs 文件语法检查 0 失败；宿主静态校验 0 错 1 警（常驻的动态依赖未证明警告）。这与本文件各小节里「未运行全量」的历史表述不冲突——那些是当时的局部记录，发布前这一轮补跑。

glob 要加引号：`node --test "tests/*.test.mjs"`（PowerShell 不展开 `*.test.mjs`，不加引号会被 Node 当成路径参数报模块找不到）。

## v0.2.16 express 会话文件附件（2026-10-12）

```powershell
node --test tests/sticker-bridge-media.test.mjs tests/sticker-delivery.test.mjs tests/sticker-after-turn.test.mjs tests/sticker-tool-card.test.mjs
node --check index.js
node --check lib/sticker-delivery.js
node --check tests/sticker-bridge-media.test.mjs
node --check tests/sticker-delivery.test.mjs
```

结果：定向测试 **30 项通过**，四份语法检查通过。`express` 统一使用当前工具 `callToken` 登记 SessionFile；Bridge 与普通 Hana 路径都保留本地图卡并返回 `details.media.items`；登记失败仍保留本地图卡、明确记录失败。自动用例使用模拟 Bus，未替代真实权限与 QQ 验收。

### 真实 QQ Bridge 复测（2026-10-12，v0.2.16，通过）

用户批准新增能力并重新安装后，App Manager 列表显示 0.2.16。用户在原 QQ Bridge 对话触发新表情，确认手机 QQ 只收到一张，没有重复；App `probe.log` 记录 `session-file-staged`。此实测只覆盖当前 Windows Hana 1.0.16-beta + QQ Bridge 会话；不外推到 Linux 或其他宿主。未运行全量测试或 App 静态校验；未由助手代发 QQ 测试消息、未调用模型/API。

## v0.2.15 QQ Bridge 配图媒体附件（2026-10-12）

```powershell
node --test tests/sticker-bridge-media.test.mjs tests/sticker-delivery.test.mjs tests/sticker-after-turn.test.mjs tests/sticker-tool-card.test.mjs
node --check index.js
node --check lib/sticker-delivery.js
node --check tests/sticker-bridge-media.test.mjs
node --check tests/sticker-delivery.test.mjs
```

结果：相关定向测试 **30 项通过**，四份语法检查通过。新增用例覆盖 Bridge 路径识别后的 `session:stage-file` 参数、`callToken`、SessionFile → `details.media.items` 映射；普通 Hana 会话不登记 Bridge 附件；登记失败保留本地卡并明确暴露失败。模拟测试未验证真实 capability grant/SessionFile 注册，也未运行全量测试或 App 静态校验。

### 真实 QQ Bridge 复测（2026-10-12，v0.2.15，失败）

用户在 QQ Bridge 回合手动触发图片后，桌面仍能看到本地卡，手机 QQ 仍无图。App 日志只有 `sticker-tool-card prepared`，没有 `bridge-media-staged` 或 `bridge-media-stage-fail`，当前无法确认登记分支被触发。Host 1.0.16-beta 的 App tool context 不向 v2 App 暴露 `bridgeContext`；旧 probe 还记录 `app/session.stage-file` 未授权。重启不能替代授权，也不能修正路由判定；真实投递尚未解决，等待确认权限范围与后续改法。未由助手向 QQ 发消息、未调用模型/API。

## v0.2.14 桥接会话编号解析回退（2026-10-12）

```powershell
node --test tests/sticker-delivery.test.mjs tests/sticker-after-turn.test.mjs
node --check lib/sticker-delivery.js
node --check tests/sticker-delivery.test.mjs
```

结果：定向测试 **15 项通过**，两份语法检查通过。新增用例验证 `session:list` 没列出目标会话时，会请求 `session:get` 并传 `scope: all` 与 `legacySessionPath`，只接受 `sess_` 稳定编号，再继续投递。宿主调用使用模拟返回，未连接真实 Hana 桥接会话、未向 QQ 发图、未调用模型/API；桥接投递仍待实机验收，未运行全量测试或 App 静态校验。

## v0.2.13 情绪方向与向量兜底门槛（2026-10-12）

```powershell
node --test tests/express-emotion-direction.test.mjs
node --test tests/entry-syntax.test.mjs tests/sticker-after-turn.test.mjs tests/sticker-delivery.test.mjs tests/sticker-tool-card.test.mjs tests/same-turn.test.mjs
node --check tools/express.js
node --check lib/emotion-groups.js
```

结果：新增 `tests/express-emotion-direction.test.mjs` **7 项全部通过**；直接相关回归 **37 项通过**；三处（含测试文件）语法检查通过。

改动两点：

- `lib/emotion-groups.js` 新增「安慰」类（关切/关心/想抱抱你…，只收给予侧词，求安慰/卖惨故意不收）；`tools/express.js` 的 scene 通道也参与组匹配，于是「关切」能命中 scene=安慰 的图，而 scene=求安慰 的图不被命中。
- `tools/express.js` 的向量兜底分档：标签通道 0 命中（纯语义兜底）时门槛由 0.35 抬到 0.45，且情绪词有归类时只收落在同类情绪组的图；同类也没有时退回高阈值纯向量。有标签候选时的原通道门槛保持 0.35 不变。

**未完成/待验证**：`VECTOR_STRICT_MIN_SIM = 0.45` 是推测值。本地无法复现「关切」的词向量（要调真实 embedding API，未授权），所以「这个阈值能否真的把 stk_524 挡在外面」只能用实机发一次「关切」来验。未运行全量回归。

## v0.2.12 图库排序（2026-10-12）

```powershell
node --test tests/gallery-sort.test.mjs
node --check ui/assets/gallery-sort.js
node --check ui/assets/beautify-select.js
node --check ui/assets/sticker-manager.js
node --check server/api.js
node --check server/boot.js
node --check lib/sticker-transfer.js
```

结果：新增 `tests/gallery-sort.test.mjs` **9 项全部通过**，六处语法检查通过。排序逻辑是浏览器脚本，测试用 vm 沙箱加载真实源码（不另写一份假逻辑）；覆盖六个档位的顺序、未识图与空描述的沉底规则、未知档位回退默认、时间相同时按 id 兜底不跳序、不改原数组，以及服务端 `GALLERY_SORT_MODES` / `panel.html` 选项 / `gallery-sort.js` 三处档位清单一致。组件 CSS 变量映射在 `ui/assets/dd-vars.css`（只做映射，未改积木本体）。

未做实机验收：排序控件与 beautify-select 的真实观感、下拉在窄栏的表现、选择落盘后刷新是否保持，需使用者点一遍。未运行全量回归。

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

使用者后续实机反馈：旧调试窗口重启 Hana 可恢复，不重启仅切回仍异常；之后两个新窗口均在回复内插图、未出现末尾独立图，暂时接受。样本编号不外发。仅记录反馈，未独立读取/重复测试；不把初步出图通过扩写为长期切窗与全部旧场景通过。

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


## 2026-10-23 存档前验证（0.5.1 之后的本地改动）

范围：
ode --test --test-concurrency=1 "tests/*.test.mjs" 全量，另有纸飞机三组 Python 用例。

结果：**461 项通过 / 0 失败**；python -B tests/test_ball_categories.py、	est_ball_target.py、	est_ball_wait_state.py 各 1 项 OK（offscreen，无 pyc 残留）。

修掉两条过期断言（	ests/sticker-order.test.mjs，都是本轮改动改了写法、行为没退化）：

- pinned 列表保手动顺序：原来盯 config.pinnedIds.map(id => serializedSticker(byId.get(id))) 这一行的排版，带分类后它展开成多行就匹配不上了。改为盯来源与输出两端——const stickers = config.pinnedIds 后接 .map(，且 pinnedIds: stickers.map(item => item.id)，顺序仍来自手动保存的 pinnedIds，不重排成 newest。
- 拖拽回调：纸飞机改成「有分类筛选时不接拖拽」，on_drag=self._on_sticker_drag 这种写法不再出现。断言跟到新契约：on_drag = None if self._category_filter else self._on_sticker_drag。

未覆盖：实机交互（面板实际观感、拖拽手感）仍需宿主里手动过一遍，测试只能守住契约与源码形态。

补充（拆分提交时）：先用 git worktree 逐笔验快照，发现按「输入栏开关」单独成笔会装不上——lib/sticker-input-panel.js 同时承载面板的收藏分类接口与按钮开关，import 了下一笔才出现的 favorite-categories.js，中间快照直接 ERR_MODULE_NOT_FOUND。分类模块与开关逻辑合并成一笔后，逐笔快照均可装载、全绿。

## 2026-10-23 定版 0.5.2 后的发布验证

改动 README 与新增一张图片后，指纹变了，以下是重跑后的结果：

- `verify`：Node 461 项通过 / 0 失败；Python 纸飞机用例 2 组通过。
- `pack`（官方打包器）：剥内测 `index.js` 1 个块，语法检查 1 个文件通过。
- `release-tests`（对最终包副本）：最终副本测试通过 461 项，已自动绑定 ZIP/entry 双指纹。
- **偶发失败记录**：第一次 `release-tests` 时 `py -B tests/test_ball_target.py` 失败 1 项（同一轮本地 `verify` 刚跑完、`pack` 并发进行）。在源码目录单独跑该用例通过，紧接着重跑 `release-tests` 也全部通过。当时本机无纸飞机进程、18904 端口空闲，倾向环境资源争用而非用例本身缺陷。**如实记为偶发，不当作稳定通过。**
- 云候选：`cloud-build-app-package`（run 39905820269）与 `CI`（run 39905805645）在提交 `2a93d9b` 上均成功；云端 ZIP/entry 双指纹与本地候选完全一致（`d1adaf11…` / `d64ee689…`），因此复用本地副本测试与独立审查结论，不重复全审。
- 包体积从 5,192,043 字节涨到 7,088,484 字节，增量全部来自新增的 `assets/release-screenshots/sticker-sakura-girl.png`（1,990,281 字节）。尝试用 GDI+ 无损重存 PNG 反而涨到 3,163,273 字节，放弃压缩，保留原图。
- 文档修正：`TESTING.md` 里有一处 `favorite-categories.js` 的首字母 `f` 曾被换成 form feed（0x0C）控制字符，已修回；该文件与其他发布文档已全文扫过，无同类残留。
- 未覆盖：本版收藏分类与纸飞机交互仍未由作者实机验收；包体未做极限压缩。
