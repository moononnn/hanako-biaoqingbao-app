# 表情包（App 版）发布契约

这份文件只约束本项目发布，不替代 Hana 应用开发规范。每次发布前先读本文件，再动手。

## 发布类型

- **小改动**（纯美化、小修复、没有用户流程变化）：push 代码并打 git tag，不创建 Release；`PENDING_CHANGES.md` 继续积累。
- **功能级改动**（新功能、用户在等的修复、交互流程变化）：走完整发布流程，创建带安装包的 GitHub Release。
- 拿不准档位时先停在本地问一句，不擅自创建 Release。
- tag 每版都打，不省；已发布历史漏打的补上。

自带「检查更新」的应用，每次发 Release 用户都会收到提醒，所以小改动逐发 Release 等于频繁打扰。这是分档的原因。

## 发布工作区

### 市场安装包必须手工过一遍（2026-10-10 踩到的坑）

市场的 `app-biaoqingbao-app-<version>.zip` 用**官方打包器**产出（宿主 `artifacts/server/<版本>/scripts/extension-pack.mjs`），它**不认识**本项目的构建约定，会把两样不该外发的东西打进包里：

1. `PROJECT_LOG.md`——内部开发记录，含私人称呼与本机路径。红线内容。
2. `index.js` 里 `#release-strip-start/end` 包着的开发期验证入口——`scripts/build-release.mjs` 会剥，官方打包器不会剥，包里留着一条能往任意会话投递图的接口。

正确做法：先从正式目录复制一份到临时暂存目录（排除 `PROJECT_LOG.md`、`x.json`、`_backups`、`data`、`*.log`、`__pycache__` 等），暂存目录名必须是 id（`biaoqingbao-app`），在暂存目录里手工删掉 strip 标记区间，再用官方打包器对着暂存目录打包。

> v0.1.41 的市场安装包已经带上了 `PROJECT_LOG.md` 和 `x.json`（`PROJECT_LOG.md` 有 108 次下载）。替换附件会让市场按 sha256 校验安装失败，所以不能动，只能从下一版开始保证干净。

### 本地目录

本地正式目录（`<HANA_HOME>/apps/biaoqingbao-app`）是唯一开发位置，改完直接改它，不走 Builder、不走 dev slot。公开内容从独立克隆推送：

- 发布仓库克隆：`<工作台>/hanako-biaoqingbao-app`（remote 指向 `moononnn/hanako-biaoqingbao-app`）
- 同步方式：从正式目录整树复制到克隆，排除 `.git`、`_backups`、`node_modules`、`data`、`stickers`、`__pycache__`、`.pytest_cache`、`*.pyc`、`*.zip`、`*.log`、`*.bak`、`x.json`、`PROJECT_LOG.md`（内部开发记录，不公开）
- 克隆里独有的 `.github/` 不能被正式目录覆盖掉，复制方向始终是 正式目录 → 克隆
- 打包不要手工压：一律用 `node scripts/build-release.mjs`（见下）

## 版本与账本

- 每完成一个功能或修复且测试全绿，就往 `PENDING_CHANGES.md` 记一笔，并把 `manifest.json` 版本 patch +1；两个动作一次做完，半成品不升版本。
- 完整发布前，把账本内容整理进 `CHANGELOG.md`，确认没有遗漏后再清空账本（保留文件头）。
- 跨窗口漏升时补升：账本攒的一波未发布改动整体算一个 minor 版本，之后从 patch +1 递增。
- 发布时直接发当前 manifest 版本号，不额外跳号（首个公开版本是 `0.1.40`）。
- 本项目没有 `package.json`，所以「manifest 与 package 版本一致」那条检查在这里不适用；CI 只校验 manifest 本身能解析、关键字段齐全、卡片声明的页面文件存在。
- 发布后核对 `TESTING.md` 里声明的测试项数与当次实跑输出一致（这项易腐，功能迭代后经常落后）。

## 发布前必须做的事

1. **剥掉开发期入口。** `index.js` 里带 `#release-strip-start` / `#release-strip-end` 标记的块（目前是 `/api/_dev/deliver-test`）只存在于本地，构建脚本会把它从发布副本里删掉，并复查残留。本地正式目录保留不动。
2. **核对仓库地址。** 应用内的检查更新读的是 `server/api.js` 顶部的 `REPO` 常量，`NOTICE` 和 `README.md` 的反馈链接也各写了一次。仓库名一旦定下来，三处一起改，别留下指向早期插件版仓库的地址。
3. **核对网络放行名单。** `manifest.json` 的 `network.allowedHosts` 决定应用能访问哪些域名。用户自己填的模型地址如果不在名单里，请求会被宿主拦下——改动模型接入方式时记得同步这一项。
4. **核对文件名里的红线。** 打包前按 plugin-dev-guide skill 里的「命名红线」清单全库 grep 一遍（对外内容里不出现作者本机路径、真实称呼、以及其他伙伴的名字，审查记录一律写「审查伙伴」）。
5. **走一遍发布前交叉审查。** 对着打好的 zip 实物查三层：包内容审查、用户安装模拟、外部红线复查。清单在 plugin-dev-guide skill 的 `references/17-release-cross-review.md`。A/B 两组必须做实机核验，**派只读审查伙伴不够**——它解压不了、跑不了测试、算不了哈希，回你一份满篇「未核验」那是没做成检查，不是通过也不是不通过。要么给审查伙伴可执行权限并约束它只读，要么自己对着 zip 实物跑完（解压清单、条目名检查、解压副本跑 `node --check` + `node --test`、逐文件 sha256 对账、宿主静态校验），把实测结果表喂给它做独立判断。审查记录里要写清哪几项谁跑的、哪几项压根没做。
6. **改动打包脚本后重新核。** 审查意见里只要动了打包脚本，就必须重新打包并重跑审查——审查的是实物，实物变了就得重核，记录里的 SHA-256 换成最后那次的值。

## 固定顺序

1. 读本文件、`TESTING.md`、plugin-dev-guide skill。
2. 核对 manifest 版本、账本条目、与克隆的差异；补齐 CHANGELOG。
3. 跑测试，全绿才继续：
   - `node --test tests/*.test.mjs`（零依赖）
   - 桌面悬浮球的 Python 离屏测试（需要本机 Python 3 + PyQt6，CI 里跑不了）
   - 应用静态校验：`node <Hana 安装目录>/artifacts/server/<版本>/scripts/validate-app.mjs --dir <本项目路径> --json`
4. 打发布包：`node scripts/build-release.mjs --out <工作台>/_releases/biaoqingbao-app`（剥开发入口、复查残留、算 SHA-256）。脚本会自行排除 `.git`、`_backups`、`node_modules`、`dist`、日志、备份、运行时残留；`PROJECT_LOG.md` 是内部开发记录（含本机现场与私人称呼），**不进发布包**，只在本地留档。
5. 对着 zip 走发布前交叉审查（见上一节第 5 条）。
6. push → 等 CI 全绿；红了先修，别发。
7. 建 GitHub Release：标题带上这一版的主要内容（例如 `v0.1.40 — 首个公开版本`），附上 zip 和它的 SHA-256。**附件名固定为 `biaoqingbao-app-<tag>.zip`**（tag 是 `v0.1.40` → 附件就是 `biaoqingbao-app-v0.1.40.zip`）：应用里的「检查更新」直接按这个名字拼下载地址，改名会让链接失效。
8. 提醒项目作者确认。

## 发布后

- 把 `PENDING_CHANGES.md` 清空（保留文件头），从下一版重新记账。
- 若这版改了用法（界面位置、配置项、依赖），同步更新 `README.md`；README 里引用的截图若有变化，一并替换 `assets/release-screenshots/`。
