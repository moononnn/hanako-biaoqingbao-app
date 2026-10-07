// lib/ipc-bridge.js — App 版进程间通信桥（stdin/stdout，一行一条 JSON）
//
// 为什么不用原来的本地 HTTP 服务：
//   AppHost 起的子进程拿不到 --allow-net，Node v26 下 net 的 bind 会被 Permission Model
//   直接拒绝（实测：Error: Access to this API has been restricted. Use --allow-net）。
//   spawn 出来的管道不属于 net，不受这道限制。PoC 阶段已验证「一行一条 JSON 来回」可行。
//
// 接口与 lib/ipc-server/core/server.js 的 LocalIpcServer 保持一致（route / start / stop /
// url / running），这样 ball.js 里那几十条 ipc.route(...) 定义一行都不用改。
//
// 协议（Python → Node 的请求）：
//   {"__bqb_request": true, "id": 7, "method": "POST", "route": "/send", "payload": {...}}
// 回复（Node → Python，写回子进程 stdin）：
//   {"id": 7, "ok": true, ...路由返回的字段}
// 不带 id 的行（比如 Python 启动时那句 ready 通知）不进桥，交给上层自己处理。

import crypto from "node:crypto";

export class StdioIpcBridge {
  constructor({ token, log } = {}) {
    this.token = token || crypto.randomBytes(24).toString("hex");
    this.log = typeof log === "function" ? log : () => {};
    this._routes = []; // { method, path, handler }
    this._started = false;
    this._handled = 0;
  }

  /** 注册路由：method 大写（"GET"/"POST"/...），path 精确匹配，handler 返回对象 */
  route(method, path, handler) {
    if (typeof handler !== "function") throw new Error("ipc-bridge: handler 必须是函数");
    this._routes.push({ method: String(method).toUpperCase(), path, handler });
  }

  /**
   * "启动"：管道桥不需要监听任何端口，只标记就绪。
   * 保留同样的返回形状，好让调用方（startBallInternal）不必改判断逻辑。
   */
  start() {
    if (this._started) return Promise.resolve({ ok: true, message: "已在运行" });
    this._started = true;
    return Promise.resolve({ ok: true, message: "管道桥就绪" });
  }

  stop() {
    this._started = false;
    return Promise.resolve({ ok: true, message: "已停止" });
  }

  /** 占位：Python 侧不再靠地址找这边，但保留取值以免上游逻辑读空。 */
  get url() {
    return "stdio://biaoqingbao-ball";
  }

  get running() {
    return this._started;
  }

  get handled() {
    return this._handled;
  }

  /**
   * 处理 Python 送来的一行。
   * 返回要写回子进程的对象；不是请求行则返回 null（由调用方忽略）。
   */
  async handleLine(line) {
    const text = String(line ?? "").trim();
    if (!text || text[0] !== "{") return null;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return null;
    }
    if (!message || message.__bqb_request !== true) return null;

    const id = message.id ?? null;
    const method = String(message.method || "GET").toUpperCase();
    const rawRoute = String(message.route || "");
    const [pathPart, queryPart] = rawRoute.split("?");

    const found = this._routes.find((r) => r.method === method && r.path === pathPart);
    if (!found) {
      this.log(`[ipc-bridge] 未注册的路由: ${method} ${pathPart}`);
      return { id, ok: false, error: `not found: ${method} ${pathPart}` };
    }

    const query = Object.fromEntries(new URLSearchParams(queryPart || ""));
    this._handled += 1;

    try {
      const result = await found.handler({
        body: message.payload,
        method,
        url: rawRoute,
        query,
      });
      if (result && typeof result === "object" && "status" in result && "body" in result) {
        return { id, status: result.status, ...(result.body ?? {}) };
      }
      return { id, ...(result && typeof result === "object" ? result : { ok: true }) };
    } catch (error) {
      this.log(`[ipc-bridge] 路由异常 ${pathPart}: ${error?.message || error}`);
      return { id, ok: false, error: error?.message || "内部错误" };
    }
  }
}
