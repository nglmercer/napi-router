import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _require = createRequire(import.meta.url);

const native = _require(resolve(__dirname, "../index.js"));
const { HttpServer } = native;

// ---------------------------------------------------------------------------
// Patch global Response to capture body synchronously, avoiding the
// microtask delay of await response.text() for simple string bodies.
// ---------------------------------------------------------------------------
const OrigResponse = globalThis.Response;
const OrigResponseJSON = OrigResponse.json;

class FastResponse extends OrigResponse {
  constructor(body, init) {
    super(body, init);
    if (typeof body === "string") {
      this._rawBody = body;
    }
  }

  static json(data, init) {
    const body = JSON.stringify(data);
    const headers = { ...(init?.headers ?? {}), "content-type": "application/json" };
    const resp = Reflect.construct(OrigResponse, [body, { ...init, headers }], FastResponse);
    resp._rawBody = body;
    return resp;
  }
}
FastResponse.error = OrigResponse.error;
FastResponse.redirect = OrigResponse.redirect;
globalThis.Response = FastResponse;

// ---------------------------------------------------------------------------
// Request context tracking (WeakMap so GC can collect when request is done)
// ---------------------------------------------------------------------------
const requestContexts = new WeakMap();

// ---------------------------------------------------------------------------
// WebSocket connection metadata
// ---------------------------------------------------------------------------
const connectionMetas = new Map();

// ---------------------------------------------------------------------------
// Unique ID generator
// ---------------------------------------------------------------------------
let nextId = 1;
function uniqueId(prefix = "c") {
  return `${prefix}_${nextId++}_${Date.now()}`;
}

// ---------------------------------------------------------------------------
// ServerHandle
// ---------------------------------------------------------------------------

class ServerHandle {
  #raw;
  #port;
  #hostname;
  #stopped = false;

  constructor(raw, port, hostname) {
    this.#raw = raw;
    this.#port = port;
    this.#hostname = hostname;
  }

  get port() {
    return this.#port;
  }

  get hostname() {
    return this.#hostname;
  }

  get url() {
    return `http://${this.#hostname}:${this.#port}/`;
  }

  get pendingRequests() {
    return this.#raw.pendingCount();
  }

  get pendingWebSockets() {
    return this.#raw.wsConnectionCount();
  }

  async stop(closeActiveConnections = false) {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#raw.close(closeActiveConnections).catch(() => {});
  }

  /**
   * Upgrade an HTTP request to a WebSocket connection.
   * Returns true if the upgrade was accepted, false otherwise.
   * @param {Request} req
   * @param {{ data?: unknown }} [options]
   * @returns {boolean}
   */
  upgrade(req, options = {}) {
    const ctx = requestContexts.get(req);
    if (!ctx || ctx.upgraded) return false;

    const connectionId = uniqueId("ws");
    ctx.upgraded = true;
    ctx.connectionId = connectionId;

    connectionMetas.set(connectionId, {
      data: options.data ?? null,
      remoteAddress: ctx.remoteAddr ?? null,
    });

    return true;
  }

  /**
   * Publish a message to all subscribers of a topic.
   * @param {string} topic
   * @param {string | ArrayBuffer | Uint8Array} data
   * @returns {number}
   */
  publish(topic, data) {
    const message = typeof data === "string" ? data : new TextDecoder().decode(data);
    return this.#raw.serverPublish(topic, message);
  }

  // ── WebSocket helpers ──────────────────────────────────────────────────

  sendToWs(connectionId, message) {
    this.#raw.wsSend(connectionId, message);
  }

  sendBinaryToWs(connectionId, data) {
    this.#raw.wsSendBinary(connectionId, data);
  }

  closeWs(connectionId) {
    this.#raw.wsClose(connectionId);
  }

  get wsConnectionIds() {
    return this.#raw.wsConnectionIds();
  }

  get [Symbol.toStringTag]() {
    return "ServerHandle";
  }
}

// ---------------------------------------------------------------------------
// Request bridge
// ---------------------------------------------------------------------------

function toWebRequest(data, baseUrl) {
  const url = data.url.startsWith("http") ? data.url : `${baseUrl}${data.url}`;

  const h = data.headers;
  const headers = new Headers();
  if (h) {
    for (let i = 0; i < h.length; i++) {
      headers.set(h[i][0], h[i][1]);
    }
  }

  const init = {
    method: data.method,
    headers,
  };

  if (
    data.body != null &&
    data.body.length > 0 &&
    data.method !== "GET" &&
    data.method !== "HEAD"
  ) {
    init.body = data.body;
  }

  return new Request(url, init);
}

// ---------------------------------------------------------------------------
// Response bridge
// ---------------------------------------------------------------------------

function fromWebResponse(response) {
  const headers = [];
  response.headers.forEach((value, key) => {
    headers.push([key, value]);
  });

  const raw = response._rawBody;
  if (raw !== undefined) {
    return {
      status: response.status,
      headers,
      body: raw,
    };
  }

  return response.text().then(
    (body) => ({ status: response.status, headers, body }),
    () => ({ status: response.status, headers, body: "" }),
  );
}

// ---------------------------------------------------------------------------
// WebSocket bridge
// ---------------------------------------------------------------------------

function makeWsProxy(connectionId, raw) {
  const getMeta = () => connectionMetas.get(connectionId) ?? {
    data: null,
    remoteAddress: null,
  };

  return {
    get id() {
      return connectionId;
    },

    get data() {
      return getMeta().data;
    },

    get remoteAddress() {
      return getMeta().remoteAddress;
    },

    get readyState() {
      return 1;
    },

    send(msg) {
      if (typeof msg === "string") return raw.wsSend(connectionId, msg);
      return raw.wsSendBinary(connectionId, Array.from(msg));
    },

    close(code, reason) {
      return raw.wsClose(connectionId);
    },

    subscribe(topic) {
      raw.wsSubscribe(connectionId, topic);
    },

    unsubscribe(topic) {
      raw.wsUnsubscribe(connectionId, topic);
    },

    isSubscribed(topic) {
      return raw.wsIsSubscribed(connectionId, topic);
    },

    publish(topic, message) {
      return raw.wsPublish(connectionId, topic, message);
    },
  };
}

function wireWebSocket(raw, wsHandlers) {
  if (!wsHandlers) return;

  raw.onWsEvent((event) => {
    const ws = makeWsProxy(event.connectionId, raw);

    switch (event.eventType) {
      case "open":
        if (event.remoteAddr) {
          const meta = connectionMetas.get(event.connectionId);
          if (meta) meta.remoteAddress = event.remoteAddr;
        }
        wsHandlers.open?.(ws);
        break;

      case "message":
        if (event.text != null) {
          wsHandlers.message?.(ws, event.text);
        } else if (event.binary != null) {
          wsHandlers.message?.(ws, new Uint8Array(event.binary));
        }
        break;

      case "close":
        connectionMetas.delete(event.connectionId);
        wsHandlers.close?.(ws, event.code ?? 1000, event.reason ?? "");
        break;

      case "error":
        wsHandlers.error?.(ws, new Error(event.error ?? "WebSocket error"));
        break;

      case "disconnect":
        connectionMetas.delete(event.connectionId);
        wsHandlers.close?.(ws, event.code ?? 1000, event.reason ?? "");
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// serve()
// ---------------------------------------------------------------------------

export async function serve(options) {
  const {
    port = 3000,
    hostname = "0.0.0.0",
    fetch: fetchHandler,
    websocket,
    error: errorHandler,
  } = options;

  if (typeof fetchHandler !== "function") {
    throw new TypeError("serve(): options.fetch must be a function");
  }

  const raw = new HttpServer();
  let handle = null;

  wireWebSocket(raw, websocket);

  raw.onRequest(async ({ request: requestData, requestId }) => {
    const baseUrl = `http://${hostname}:${port}`;
    const webRequest = toWebRequest(requestData, baseUrl);

    // Store request context for potential upgrade()
    const reqCtx = { requestId, upgraded: false, connectionId: null, remoteAddr: requestData.remoteAddr };
    requestContexts.set(webRequest, reqCtx);

    // Normal HTTP request — call the user's fetch handler
    let response;
    try {
      response = await fetchHandler(webRequest, handle);
      if (!(response instanceof Response)) {
        response = new Response(
          "Internal Server Error: fetch handler must return a Response",
          { status: 500 },
        );
      }
    } catch (err) {
      if (typeof errorHandler === "function") {
        try {
          response = await errorHandler(err);
        } catch {
          response = new Response("Internal Server Error", { status: 500 });
        }
      } else {
        console.error("[napi-router] Unhandled error in fetch handler:", err);
        response = new Response("Internal Server Error", { status: 500 });
      }
    }

    // If the user called server.upgrade(req) inside the fetch handler,
    // honour that instead of using the Response they returned.
    if (reqCtx.upgraded && reqCtx.connectionId) {
      raw.sendResponse(requestId, {
        status: 101,
        headers: [],
        body: "",
        upgrade: true,
        connectionId: reqCtx.connectionId,
      });
      return;
    }

    // Auto-detect WebSocket upgrade fallback: if the request has Upgrade: websocket,
    // and the user did NOT call upgrade() manually, but websocket option is provided,
    // perform the upgrade automatically.
    const reqHeaders = requestData.headers ?? [];
    const isUpgrade =
      reqHeaders.some(([k, v]) => k === "upgrade" && v.toLowerCase() === "websocket") &&
      reqHeaders.some(([k, v]) => k === "connection" && v.toLowerCase().includes("upgrade"));

    if (isUpgrade && websocket) {
      const connectionId = uniqueId("ws");
      reqCtx.upgraded = true;
      reqCtx.connectionId = connectionId;

      connectionMetas.set(connectionId, {
        data: null,
        remoteAddress: requestData.remoteAddr ?? null,
      });

      raw.sendResponse(requestId, {
        status: 101,
        headers: [],
        body: "",
        upgrade: true,
        connectionId,
      });
      return;
    }

    const responseData = fromWebResponse(response);
    if (typeof responseData.then === "function") {
      raw.sendResponse(requestId, await responseData);
    } else {
      raw.sendResponse(requestId, responseData);
    }
  });

  const info = await raw.listen(port, hostname);
  handle = new ServerHandle(raw, info.port, info.address);
  return handle;
}

// ---------------------------------------------------------------------------
// tryServe()
// ---------------------------------------------------------------------------

export async function tryServe(options) {
  try {
    const server = await serve(options);
    return { server, error: null };
  } catch (err) {
    return { server: null, error: /** @type {Error} */ (err) };
  }
}

export { HttpServer };
export { ServerHandle as Server };
