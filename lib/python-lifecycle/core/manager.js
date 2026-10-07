// python-lifecycle · core/manager.js — Python 子进程生命周期管理
// 样板来源：闲不住 lib/fengling.js / 接个话 lib/zhujian.js（两份几乎相同的 start/stop/状态跟踪代码）

import fs from "node:fs";
import { spawn } from "node:child_process";
import { detectPython } from "./detect.js";
import { buildChildEnv } from "./env.js";

/**
 * Python 子进程管理器。
 *
 * const proc = new PythonProcess({
 *   name: "风铃",                          // 日志前缀（[风铃]）
 *   script: "/path/fengling_app.py",       // 脚本绝对路径
 *   args: ["--duration", "90"],           // 可选，追加给脚本的命令行参数
 *   cwd: "/path/python",                   // 工作目录（脚本所在目录）
 *   env: { XIANBUZHU_API: "http://..." },  // 附加环境变量（合并进 process.env）
 *   python: "C:\\Python314\\python.exe",   // 可选，不传自动探测
 *   log: (line) => console.log(line),      // 日志回调（默认 console.log）
 * });
 *
 * await proc.start();    // 幂等：已在运行直接返回 ok
 * await proc.stop();     // kill + 等退出
 * proc.status();         // { running, startedAt, exitCode, error }
 * proc.onExit(cb);       // 注册退出回调
 */
export class PythonProcess {
  constructor({ name = "python", script, args = [], cwd, env = {}, python, log, onLine } = {}) {
    if (!script) throw new Error("python-lifecycle: script 必填");
    this.name = name;
    this.script = script;
    this.args = Array.isArray(args) ? args : [];
    this.cwd = cwd;
    this.env = env;
    this.python = python || null;
    this.log = typeof log === "function" ? log : (line) => console.log(line);
    // 整行回调（App 版的管道桥靠它收请求）；不传则只走 log
    this.onLine = typeof onLine === "function" ? onLine : null;
    this.child = null;
    this.state = { running: false, startedAt: null, exitCode: null, error: null };
    this._exitHandlers = [];
    this._outBuffer = "";
    this._errBuffer = "";
  }

  /** 启动（幂等：已在运行直接返回 ok）。脚本不存在返回 { ok:false, error } */
  start() {
    if (this.child) return Promise.resolve({ ok: true, message: "已在运行" });
    if (!fs.existsSync(this.script)) {
      return Promise.resolve({ ok: false, error: `${this.script} 不存在` });
    }
    const python = this.python || detectPython();
    // 不能写成 { ...process.env, ...this.env }：
    // AppHost 交给子进程的环境只有 PATH/HOME/TMPDIR/LANG，缺 APPDATA。
    // 而 PyQt6 装在用户级 site-packages（%APPDATA%\Python\Python3xx\site-packages），
    // 少了它就报 ModuleNotFoundError: No module named 'PyQt6' —— 不是没装，是找不到。
    // 统一走 buildChildEnv：按 HOME 推导补回 APPDATA/LOCALAPPDATA，也不把宿主之外的环境整份透传。
    const env = buildChildEnv(this.env);

    let child;
    try {
      child = spawn(python, [this.script, ...this.args], {
        cwd: this.cwd,
        // stdin 必须是 pipe：App 版靠它把回复写回子进程
        //（插件版走 HTTP，不需要 stdin，这里原来是 ignore；照搬就会让管道桥永远发不出话）
        stdio: ["pipe", "pipe", "pipe"],
        env,
        windowsHide: true,
      });
    } catch (e) {
      this.state = { running: false, startedAt: null, exitCode: null, error: e.message };
      return Promise.resolve({ ok: false, error: `无法启动 Python：${e.message}` });
    }

    this.child = child;
    this.state = { running: true, startedAt: Date.now(), exitCode: null, error: null };
    this._outBuffer = "";
    this._errBuffer = "";

    child.stdout?.on("data", (chunk) => this._onChunk(chunk, "out"));
    child.stderr?.on("data", (chunk) => this._onChunk(chunk, "err"));

    child.on("error", (err) => {
      this.state.running = false;
      this.state.error = err.message;
      this._emitExit(err.code || null, err.message);
    });
    child.on("exit", (code, signal) => {
      this.state.running = false;
      this.state.exitCode = code;
      // signal 有值时说明是被强制终止的（code 会是 null），这跟“程序自己报错退出”不是一回事
      this._exitSignal = signal || null;
      this._flushBuffers();
      this._emitExit(code, signal ? `signal:${signal}` : null);
    });

    return Promise.resolve({ ok: true, message: "已启动" });
  }

  /** 往子进程 stdin 写一行（管道桥回复用）。未运行返回 false。 */
  send(line) {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) return false;
    try {
      child.stdin.write(String(line ?? "") + "\n");
      return true;
    } catch (e) {
      this.log(`[${this.name}] 写入子进程失败: ${e?.message || e}`);
      return false;
    }
  }

  /** 停止：kill 进程，等退出（最多 timeoutMs）。已在停止/未运行幂等。 */
  stop({ timeoutMs = 5000 } = {}) {
    const child = this.child;
    if (!child) return Promise.resolve({ ok: true, message: "未在运行" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.state.error = "停止超时";
        resolve({ ok: false, error: "停止超时" });
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve({ ok: true, message: "已停止" });
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        this.state.error = "kill 失败";
        resolve({ ok: false, error: "kill 失败" });
      }
    });
  }

  /** 当前状态快照 */
  status() {
    return { running: this.state.running, startedAt: this.state.startedAt, exitCode: this.state.exitCode, error: this.state.error };
  }

  /** 注册退出回调（进程崩溃/退出时通知，可用于自动重启等） */
  onExit(cb) {
    if (typeof cb === "function") this._exitHandlers.push(cb);
  }

  _emitExit(code, error) {
    const handlers = this._exitHandlers;
    this._exitHandlers = [];
    this.child = null;
    for (const cb of handlers) {
      try { cb({ exitCode: code, error }); } catch { /* 回调异常不阻塞 */ }
    }
  }

  _onChunk(chunk, kind) {
    const text = chunk.toString("utf-8");
    const buf = kind === "out" ? this._outBuffer : this._errBuffer;
    const lines = (buf + text).split("\n");
    const last = lines.pop(); // 最后一段可能不完整，留到下一块
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed) {
        this.log(`[${this.name}] ${trimmed}`);
        this._emitLine(trimmed, kind);
      }
    }
    if (kind === "out") this._outBuffer = last; else this._errBuffer = last;
  }

  _flushBuffers() {
    for (const [buf, kind] of [[this._outBuffer, "out"], [this._errBuffer, "err"]]) {
      const trimmed = buf.replace(/\r$/, "");
      if (trimmed) {
        this.log(`[${this.name}] ${trimmed}`);
        this._emitLine(trimmed, kind);
      }
    }
    this._outBuffer = "";
    this._errBuffer = "";
  }

  /** 整行交给外部（管道桥用）。回调异常不能拖垮进程管理。 */
  _emitLine(text, kind) {
    if (!this.onLine) return;
    try {
      this.onLine(text, kind);
    } catch {
      /* 回调异常不阻塞 */
    }
  }
}
