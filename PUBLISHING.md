# 表情包（App 版）发布契约

这份文件只约束本项目发布，不替代 Hana 应用开发规范。每次发布前先读本文件，再动手。

## 发布类型

- **小改动**（纯美化、小修复、没有用户流程变化）：push 代码并打 git tag，不创建 Release；`PENDING_CHANGES.md` 继续积累。
- **功能级改动**（新功能、用户在等的修复、交互流程变化）：走完整发布流程，创建带安装包的 GitHub Release。
- 拿不准档位时先停在本地问一句，不擅自创建 Release。
- tag 每版都打，不省；已发布历史漏打的补上。

自带「检查更新」的应用，每次发 Release 用户都会收到提醒，所以小改动逐发 Release 等于频繁打扰。这是分档的原因。

## 发布工作区

本地正式目录（`<HANA_HOME>/apps/biaoqingbao-app`）是唯一开发位置，改完直接改它，不走 Builder、不走 dev slot。公开内容从独立克隆推送：

- 发布仓库克隆：`<工作台>/hanako-biaoqingbao-app`（remote 指向 `moononnn/hanako-biaoqingbao-app`）
- 同步方式：从正式目录整树复制到克隆，排除 `.git`、`_backups`、`node_modules`、`data`、`stickers`、`__pycache__`、`.pytest_cache`、`*.pyc`、`*.zip`、`*.log`、`*.bak`、`x.json`、`PROJECT_LOG.md`（内部开发记录，不公开）
- 克隆里独有的 `.github/` 不能被正式目录覆盖掉，复制方向始终是 正式目录 → 克隆
- 打包不要手工压：一律用 `node scripts/build-release.mjs`（见下）

## 版本与账本

- 每完成一个功能或修复且测试全绿，就往 `PENDING_CHANGES.md` 记一笔，并把 `manifest.json` 版本 patch +1；两个动作一次做完，半成品不升版本。
- 完整发布前，把账本内容整理进 `CHANGELOG.md`，确认没有遗漏后再清空账本（保留文件头）。
- 跨窗口漏升时补升：账本攒的一波未发布改动整体算一个 minor 版本，之后从 patch +1 递增。
- 发布时直接发当前 manifest 版本号，不额外跳号（首个公开版本是 `0.1.39`）。
- 本项目没有 `package.json`，所以「manifest 与 package 版本一致」那条检查在这里不适用；CI 只校验 manifest 本身能解析、关键字段齐全、卡片声明的页面文件存在。
- 发布后核对 `TESTING.md` 里声明的测试项数与当次实跑输出一致（这项易腐，功能迭代后经常落后）。

## 发布前必须做的事

1. **剥掉开发期入口。** `index.js` 里带 `#release-strip-start` / `#release-strip-end` 标记的块（目前是 `/api/_dev/deliver-test`）只存在于本地，构建脚本会把它从发布副本里删掉，并复查残留。本地正式目录保留不动。
2. **核对仓库地址。** 应用内的检查更新读的是 `server/api.js` 顶部的 `REPO` 常量，`NOTICE` 和 `README.md` 的反馈链接也各写了一次。仓库名一旦定下来，三处一起改，别留下指向早期插件版仓库的地址。
3. **核对网络放行名单。** `manifest.json` 的 `network.allowedHosts` 决定应用能访问哪些域名。用户自己填的模型地址如果不在名单里，请求会被宿主拦下——改动模型接入方式时记得同步这一项。
4. **核对文件名里的红线。** 打包前按 plugin-dev-guide skill 里的「命名红线」清单全库 grep 一遍（对外内容里不出现作者本机路径、真实称呼、以及其他伙伴的名字，审查记录一律写「审查伙伴」）。
5. **走一遍发布前交叉审查。** 对着打好的 zip 实物查三层：包内容审查、用户安装模拟、外部红线复查。清单在 plugin-dev-guide skill 的 `references/17-release-cross-review.md`，A/B 两组最好派独立审查伙伴复核。

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
7. 建 GitHub Release：标题带上这一版的主要内容（例如 `v0.1.38 — 首个公开版本`），附上 zip 和它的 SHA-256。
8. 提醒项目作者确认。

## 发布后

- 把 `PENDING_CHANGES.md` 清空（保留文件头），从下一版重新记账。
- 若这版改了用法（界面位置、配置项、依赖），同步更新 `README.md`；README 里引用的截图若有变化，一并替换 `assets/release-screenshots/`。
