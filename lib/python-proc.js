// lib/python-proc.js — App 版 Python 子进程管理
//
// 骨架照搬插件版 lib/python-lifecycle/core/manager.js。
// 环境构造抽到了 core/env.js（启动探测、脚本执行都共用同一套，不再各写各的）。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { buildChildEnv } from "./python-lifecycle/core/env.js";

export { buildChildEnv };

export class PythonProcess {
  constructor({ name = "python", script, args = [], cwd, env = {}, python, log, onLine } = {}) {
    if (!script) throw new Error("python-proc: script 必填");
    this.name = name;
    this.script = script;
    this.args = Array.isArray(args) ? args : [];
    this.cwd = cwd;
    this.extraEnv = env;
    this.python = python || null;
    this.log = typeof log === "function" ? log : () => {};
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
    if (!this.python) return Promise.resolve({ ok: false, error: "未指定 Python 解释器" });
    if (!existsSync(this.script)) {
      return Promise.resolve({ ok: false, error: `${this.script} 不存在` });
    }

    let child;
    try {
      child = spawn(this.python, [this.script, ...this.args], {
        cwd: this.cwd,
        // stdin 必须是 pipe：stdio 桥靠它往下发指令。
        // （插件版这里是 "ignore"，因为插件版走 HTTP，不需要 stdin；
        //   照抄过来的话 Python 一读 stdin 就 EOF，进程当场退干净。）
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv(this.extraEnv),
        windowsHide: true,
      });
    } catch (e) {
      this.state = { running: false, startedAt: null, exitCode: null, error: e.message };
      return Promise.resolve({ ok: false, error: `无法启动 Python：${e.code || ""} ${e.message}` });
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
    child.on("exit", (code) => {
      this.state.running = false;
      this.state.exitCode = code;
      this._flushBuffers();
      this._emitExit(code, null);
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

  status() {
    return {
      running: this.state.running,
      startedAt: this.state.startedAt,
      exitCode: this.state.exitCode,
      error: this.state.error,
    };
  }

  onExit(cb) {
    if (typeof cb === "function") this._exitHandlers.push(cb);
  }

  _emitExit(code, error) {
    const handlers = this._exitHandlers;
    this._exitHandlers = [];
    this.child = null;
    for (const cb of handlers) {
      try {
        cb({ exitCode: code, error });
      } catch {
        /* 回调异常不阻塞 */
      }
    }
  }

  _onChunk(chunk, kind) {
    const text = chunk.toString("utf-8");
    const buf = kind === "out" ? this._outBuffer : this._errBuffer;
    const lines = (buf + text).split("\n");
    const last = lines.pop(); // 最后一段可能不完整，留到下一块
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed) continue;
      this.log(`[${this.name}] ${trimmed}`);
      this._emitLine(trimmed, kind);
    }
    if (kind === "out") this._outBuffer = last;
    else this._errBuffer = last;
  }

  _flushBuffers() {
    for (const [buf, which] of [
      [this._outBuffer, "out"],
      [this._errBuffer, "err"],
    ]) {
      const trimmed = buf.replace(/\r$/, "");
      if (trimmed) {
        this.log(`[${this.name}] ${trimmed}`);
        this._emitLine(trimmed, which);
      }
    }
    this._outBuffer = "";
    this._errBuffer = "";
  }

  /** 把整行交给外部（stdio 桥用）。回调异常不能拖垮进程管理。 */
  _emitLine(text, kind) {
    if (!this.onLine) return;
    try {
      this.onLine(text, kind);
    } catch {
      /* 回调异常不阻塞 */
    }
  }
}
