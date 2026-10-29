# 表情包（App 版）发布契约

这份文件只约束本项目发布，不替代 Hana 应用开发规范。每次发布前先读本文件，再动手。

## 当前发布契约（2026-10-14）

本节与小工坊 `WORKFLOW.md` 的新规则优先；本文件更早的 Builder review/install/upgrade 强制门槛、README 强制改写或重复全量测试要求均属历史，不再适用于普通发布。项目分档与文件边界仍有效。

规范顺序：定版、CHANGELOG 与便携 cloud 配置 → `notes` → `preflight` → 最终 `verify` → 准确 `commit`/`push`、CI 与云候选 → `import` → 最终 ZIP/entry 机器核验 + 独立伙伴 `packageReview` → `freeze` → tag/Release/回下载 hash/市场登记。`verify` 可自动执行 preflight，但云发布在提交或上传前仍须显式跑一次，检查本地隐私、Git 字节漂移、云配置及 `.cloud-build`/`.github` 工作流和 payload 是否跟踪或纳入准确提交，并批量列出全部问题。当前 CLI 已支持 `preflight` 与 `record kind=packageReview`；审包记录的 pass 必须绑定最终 ZIP/entry，并填写 `reviewer`、`independent=true`，详细字段见 `WORKFLOW.md`。

审包仅针对最终官方 ZIP 与对应 entry。主会话可先做机械检查，独立伙伴须只读核查实物入口、资源引用、依赖，以及数据写入/升级代码风险；不得碰生产数据，不要求 Builder 实测。**「只读」指只做检查、不许改动，不是「只能读文件」——审包伙伴必须能执行命令**（自己解压、实算 SHA-256、逐文件比对、逐张看截图）。只读代理会被拦掉 exec，既解不开包也算不了哈希，它只能回答「实物层没验到」，那不算通过也不算不通过，会把流程卡在半路（2026-10-29 v0.6.4 踩过一次）。派审包任务要么给带执行权限的代理并写死「只读、不许改文件、不许 commit/push」，要么由主会话先把机械项跑完、把实测结果随包交给只读代理出结论（详见小工坊 WORKFLOW.md「审包代理的权限要求」）。`packageReview` 必须由独立伙伴判定，证据含 `kind=packageReview`、`status`、`method`、`scope`、`actual`、`time`、`reviewer`、`independent=true`，并绑定最终 `zipSha256` 与 `entrySha256`。一轮收齐意见；阻断问题修复后对新指纹重核，非阻断建议不扩改。派出审查或满篇未核验不算通过。

普通发布不强制 Builder review/install/upgrade，也不要求卸载重装或真实数据迁移。功能声明以本人实机已测场景为限：有验收时捕获的 `files` 指纹就按指纹核验；无指纹时须有本人原会话 `reference` 且 `observedVersion` 等于本版，才可记录该场景通过并标记 `reuse=reported-scenario-only`。该记录不得跨后续代码改动复用或冒称全应用通过；完整安装/迁移无证据不得宣称通过。副本内容变换仍须对应 `releaseTests`；验证复用仅限源码、测试、依赖、检查命令、相关验证器及运行环境完全一致。Notes 或审批策略脚本变更不触发业务重测；官方打包器/发布规则变化只重核包。README 与 `manifest.description` 不因版本号或功能更新自动改写；但**这次改动有没有让 README 里的事实描述过时，必须在动手发布之前逐条核过并请示作者**，见「发布前必须做的事」第 7 条。实质安装/权限差异如实记录，不因此自动改稿。唯一发布包仍为官方 ZIP + entry。

本项目应用内更新器硬编码 `biaoqingbao-app-v<version>.zip`，由 `package.compatibilityAliases` 生成与官方 ZIP 字节相同的兼容别名；别名不是第二种包，官方名与别名的 SHA-256 必须相同。

## 发布类型

- **小改动**（经核实为纯美化、小修复且没有用户流程变化）：按本项目既定轻量档 push 并打 git tag，不创建 Release；`PENDING_CHANGES.md` 继续积累。
- **功能级改动**（新功能、用户在等的修复、交互流程变化）：走完整发布流程，创建带安装包的 GitHub Release。
- 按可核实的变更事实自行定档；信息可查证就先查，不为普通技术取舍询问。确属作者个人决定才另行确认；无法明确判为小改动时按完整发布路径。
- tag 每版都打，不省；已发布历史漏打的补上。

自带「检查更新」的应用，每次发 Release 用户都会收到提醒，所以小改动逐发 Release 等于频繁打扰。这是分档的原因。

## 发布工作区

当前正式 App 目录 `<HANA_HOME>/apps/biaoqingbao-app` 同时是 `moononnn/hanako-biaoqingbao-app` 的 Git 工作区；配置中的 `src` 与 `repo` 相同，流水线因此跳过目录复制。旧文档所写的工作台独立克隆当前不存在，不要再按旧路径同步或覆盖目录。仓库中的 `.github/`、测试与 `.cloud-build/` 可以留在仓库，但不得进入 App 包。

### 官方市场包与项目剥离规则

官方市场 ZIP 必须使用 Hana 官方 `extension-pack.mjs`，并且输入只能是小工坊生成的干净 stage；不可对开发目录直接打包。官方打包器不会理解项目哨兵，当前项目配置会先在 stage 中按完整独占行剥掉 `index.js` 的 `#release-strip-start/end` 区间，再做残留扫描和包验收。改了哨兵格式时，先更新配置并验证剥离结果，不能手工删正式源码。

历史 v0.1.41 附件曾含 `PROJECT_LOG.md` 与 `x.json`；已发布附件不得替换，本配置只保证之后的新包按白名单排除这些文件。

### 应用内更新器的兼容附件名

`server/api.js` 的更新链接仍请求 `biaoqingbao-app-v<version>.zip`。小工坊在 `package.compatibilityAliases` 中为官方 ZIP 生成该旧文件名；它与 `app-biaoqingbao-app-<version>.zip` 必须字节完全相同、SHA-256 完全相同，不另建第二种内容包。`scripts/build-release.mjs` 不再作为本版 Release 打包入口；不得单独重打一个内容不同的旧包。

## 版本与账本

- 每完成一个功能或修复且测试全绿，就往 `PENDING_CHANGES.md` 记一笔，**并把 `manifest.json` 的 `version` 递增成开发号 `<正式号>-dev.<N>`**（N 从 1 起）（2026-10-29 作者拍板，取代 2026-10-12「开发中不动版本号」）。正式号 `x.y.z` 发版前不动，市场和 Release 只见过正式号。
- 开发号随这次改动一起提交进 git；多个窗口并行改同一个项目时以更大的 N 为准（冲突取大，别各自拨号）。开发号不得打包、不得打 tag、不得进市场。
- 打包前把 `manifest.version` 与打包配置里的项目版本改成同一个正式号；打包器做版本对账，不一致直接报错。
- 完整发布前，把账本内容整理进 `CHANGELOG.md`，确认没有遗漏后再清空账本（保留文件头）。
- 发布那一刻才定版本号。**定档只看一件事：这版有没有让用户多做一件以前做不到的事。**
  - 能力型（新玩法、真能用的新页面、以前坏到不能用而这次真修通了）→ minor
  - 改造型（还是那件事：加开关、加选项、换窗口生效、界面重排、兼容修复、重构）→ patch，哪怕代码动了几千行
  - 数据要迁移或对外接口变成破坏性 → major，基本不碰
  - 正式号一轮只涨一次，就在发版那刻涨；开发期涨的是 `-dev` 号，正式号不会留下没发布过的空号
  - 判档由伙伴自己判，不打断作者；发版前只报一句「这版发 x.y.z」，作者要改就改，改了记 PROJECT_LOG
  - 一串 patch 太久（连续 15 个已发布版本没升过 minor）时，主动问一句要不要升，不自动升
  - 2026-10-26 作者拍板改口径，替代旧句「新能力/新玩法走 minor」。已发版本里 v0.4.0（兼容修复 + 一个开关）与 v0.6.0（Code 页分档，与拾光记 v0.2.1 同类）按新规则本应走 patch，不回改已发布号，只作后续口径。
- 发布时直接发这个定下来的版本号，不额外跳号（首个公开版本是 `0.1.40`）。
- 本项目没有 `package.json`，所以「manifest 与 package 版本一致」那条检查在这里不适用；CI 只校验 manifest 本身能解析、关键字段齐全、卡片声明的页面文件存在。
- 核对 `TESTING.md` 声明与本版实际有效的验证记录一致；指纹完全匹配时可复用既有测试结果，不为更新测试项数或 Notes/审批策略变化强制重跑全量业务测试。

## 发布前必须做的事

1. **剥掉开发期入口。** `index.js` 里带 `#release-strip-start` / `#release-strip-end` 标记的块（目前是 `/api/_dev/deliver-test`）只从本地发布 stage 删除，并复查残留；正式源码保留不动。不得手工编辑源码来替代 stage 转换。
2. **核对仓库地址。** 应用内的检查更新读的是 `server/api.js` 顶部的 `REPO` 常量，`NOTICE` 和 `README.md` 的反馈链接也各写了一次。仓库名一旦定下来，三处一起改，别留下指向早期插件版仓库的地址。
3. **核对网络放行名单。** `manifest.json` 的 `network.allowedHosts` 决定应用能访问哪些域名。用户自己填的模型地址如果不在名单里，请求会被宿主拦下——改动模型接入方式时记得同步这一项。
4. **核对文件名里的红线。** 打包前按 plugin-dev-guide skill 里的「命名红线」清单全库 grep 一遍（对外内容里不出现作者本机路径、真实称呼、以及其他伙伴的名字，审查记录一律写「审查伙伴」）。图片里的文字扫不出来，**低分辨率的小标签判读不出来时不要硬猜成某个名字**——猜错会把正常内容当红线拦下。判读不出来就写「看不清」并交人工确认；确认是误判后，把结论记回本项目，别让下一次再当一遍。已知误判：`assets/release-screenshots/paper-plane.png` 里蓝发 Q 版表情左上角的两字标签曾被判读为其他伙伴名，作者确认那是角色设定而非真实称呼，不属红线，不必重复拦。
5. **核对清单里的资源路径。** 同一个 `assets/` 前缀在两处指向不同目录：顶层 `icon` 以**包根**为基址（`assets/icon.png`），而 `cards[].face.image` 与 `pageIcon` 以 **`ui/`** 为基址（清单里写 `assets/cover.png`，实指 `ui/assets/cover.png`）。核对某张图是否落盘时两个基址都要查；只查一个就断言「文件丢了」，会把本来正常的资源当成缺陷去「修」。拿解压后的 zip 对着 manifest 逐条核对卡片声明的页面与图标是否都在包里。
5. **最终包机器核验与独立审包。** 主会话先核对最终 ZIP/entry 指纹、包内真实入口、资源引用、依赖、隐私/残留与官方静态校验；有副本内容变换时，对最终解包副本执行对应 `releaseTests`。再交独立伙伴只读检查同一 ZIP/entry 的实物与数据写入/升级代码风险，不碰生产数据、不要求 Builder 实测。证据须 `kind=packageReview`，填写 `status`、`method`、`scope`、`actual`、`time`、`reviewer`、`independent=true` 并绑定 `zipSha256`、`entrySha256`；只有独立伙伴可判 pass。意见一轮收齐，只修阻断项；ZIP/entry 变化后重做受影响包核验与审包，非阻断建议不扩改。
6. **打包器/发布规则变更。** 官方打包器或发布规则变更只重核最终包及受影响包检查，不自动触发业务全量重测；若新包内容有变换，`releaseTests` 仍必须通过。
7. **先核 README，再决定发不发。** 把本版改动逐条对着 `README.md` 读一遍：图标长相、按钮位置与名称、操作步骤、版本要求、权限项、界面截图里的东西。只要有一句事实描述被这版改掉了，就**先停下来问作者**「这版 README 要不要跟着改」，不许先发布再报告。
   - 作者说改：同版改完、重新打包、重跑核验再发。
   - 作者说这次不改：照原样发，并在市场 PR 的「已知问题」里写明哪一句与当前行为不符，留待下版。
   - 只有版本号行不同、正文事实没变：不阻断，不用问。
   - 这条是 2026-10-26 作者拍板的：旧写法让「README 不自动改」被执行成「README 不用看」，连着两版都是发完才说，作者要求改成“动手前核、要改就先问”。

## 固定顺序

1. 读本文件、`TESTING.md`、`PENDING_CHANGES.md`；核对 App Manager、manifest ID/版本、Git remote、tag/Release 和本版账目。开发期命名/隐私红线仍按适用规范核查；发布门禁以本文件与小工坊 `WORKFLOW.md` 为准。
2. 整理真实待发条目进 `CHANGELOG.md`，按项目契约定版本；README 版本行不作为阻断项，但**正文事实是否过时必须在发布前核并请示**（「发布前必须做的事」第 7 条），不得因为「不自动改」就跳过后改。
3. 定版并稳定便携 cloud 配置，部署 workflow，执行 `notes` → `preflight` → 最终 `verify`。preflight 批量核本地隐私、Git 字节漂移、云配置与 `.cloud-build`/`.github` workflow/payload 跟踪；云上传前须显式执行一次。随后 commit/push 准确源码与 workflow/config，等待准确 CI 和候选构建，下载并 `import`。Cloud 模块未部署/不可用时才本地 `pack` 备用。
4. 对最终官方 ZIP + entry 做机器核验，再由独立伙伴完成并记录 `packageReview`，绑定 ZIP/entry 指纹并填写 `status`、`method`、`scope`、`actual`、`time`、`reviewer`、`independent=true`；不要求 Builder review/install/upgrade 或卸载重装。功能只按本人实机已测场景记述；副本内容变换仍须 `releaseTests`。迁移风险先静态核与合成数据测试，真实数据操作另行授权。
5. 达到 freeze 门槛后打 tag、创建 GitHub Release，上传官方 ZIP + entry 及 `biaoqingbao-app-v<version>.zip` 字节相同的兼容别名；回下载每个 ZIP 并确认 SHA-256 相同且与 entry 一致，再登记市场。

完整阶段与 Cloud Runner 校验见小工坊 `WORKFLOW.md`。用户说“推送表情包应用”按已核实变更事实和项目分档执行：功能级改动走完整 Release + 市场登记；经核实的纯小改动按轻量档 push+tag，不再为普通档位选择重复确认。

## 发布后

- 把 `PENDING_CHANGES.md` 清空（保留文件头），从下一版重新记账。
- README 不因版本号或每项功能更新而自动改写。发布前已按第 7 条核过并请示过的，按作者的意思处理；没核过的，视为这一轮发布流程没走完。确需替换 README 截图时，同时核对 `assets/release-screenshots/` 的公开内容。
