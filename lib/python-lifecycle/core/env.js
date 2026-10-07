// python-lifecycle · core/env.js — 构造给 Python 子进程的最小环境
//
// 为什么必须有这一层：
//   AppHost 交给子进程的环境只有 PATH / HOME / TMPDIR / LANG（外加只读的 HANA_LOCALE_DIR）。
//   缺 APPDATA 会让 Windows 上用户级 Python 包目录（AppData/Roaming/Python/Python3xx/site-packages）
//   解析错位，PyQt6 直接 ModuleNotFoundError。
//
// 实测对照（同一个 Python、同一台机器）：
//   · 补了 APPDATA 的进程 → pyqt6 6.11.0 正常导入
//   · 没补的探测进程     → `import PyQt6` 退出码 1
// 所以凡是起 Python 的地方都得走这里，不能各写各的。

import { homedir } from "node:os";
import { join } from "node:path";

/** 构造给 Python 子进程的最小环境，补齐 Windows 账号目录变量。 */
export function buildChildEnv(extra = {}) {
  const home = process.env.HOME || homedir() || "";
  const env = {
    PATH: process.env.PATH || "",
    HOME: home,
    TMPDIR: process.env.TMPDIR || process.env.TEMP || "",
    LANG: process.env.LANG || "",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    ...extra,
  };
  if (process.env.HANA_LOCALE_DIR) env.HANA_LOCALE_DIR = process.env.HANA_LOCALE_DIR;
  if (process.platform === "win32" && home) {
    env.APPDATA = process.env.APPDATA || join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  }
  return env;
}
