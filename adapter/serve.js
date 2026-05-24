import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _require = createRequire(import.meta.url);

const native = _require(resolve(__dirname, "../index.js"));
const { HttpServer } = native;

const textEncoder = new TextEncoder();

const OrigResponse = globalThis.Response;
const OrigResponseJSON = OrigResponse.json;

class FastResponse extends OrigResponse {
  constructor(body, init) {
    super(body, init);
    if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) {
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

const requestContexts = new WeakMap();

const connectionMetas = new Map();

let nextId = 1;
function uniqueId(prefix = "c") {
  return `${prefix}_${nextId++}_${Date.now()}`;
}

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

  publish(topic, data) {
    const message = typeof data === "string" ? data : new TextDecoder().decode(data);
    return this.#raw.serverPublish(topic, message);
  }

  sendToWs(connectionId, message) {
    this.#raw.wsSend(connectionId, message);
  }

  sendBinaryToWs(connectionId, data) {
    if (data instanceof Uint8Array) {
      this.#raw.wsSendBinary(connectionId, data);
    } else if (data instanceof ArrayBuffer) {
      this.#raw.wsSendBinary(connectionId, new Uint8Array(data));
    } else {
      this.#raw.wsSendBinary(connectionId, data);
    }
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

function toWebRequest(data, baseUrl) {
  const url = data.url.startsWith("http") ? data.url : `${baseUrl}${data.url}`;

  const h = data.headers;
  const headers = new Headers();
  if (h) {
    for (let i = 0; i < h.length; i += 2) {
      headers.set(h[i], h[i + 1]);
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
    init.body = new Uint8Array(data.body);
  }

  return new Request(url, init);
}

function sendResponseFast(raw, requestId, response) {
  const headers = [];
  response.headers.forEach((value, key) => {
    headers.push(key, value);
  });

  const rawBody = response._rawBody;
  if (typeof rawBody === "string") {
    raw.sendResponseText(requestId, response.status, headers, rawBody);
    return;
  }
  if (rawBody instanceof Uint8Array || rawBody instanceof ArrayBuffer) {
    const bytes = rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody);
    raw.sendResponseBuffer(requestId, response.status, headers, Array.from(bytes));
    return;
  }

  response.arrayBuffer().then(
    (buf) => raw.sendResponseBuffer(requestId, response.status, headers, Array.from(new Uint8Array(buf))),
    () => raw.sendResponseBuffer(requestId, response.status, headers, []),
  );
}

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
      if (msg instanceof Uint8Array || msg instanceof ArrayBuffer) {
        const bytes = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
        return raw.wsSendBinary(connectionId, Array.from(bytes));
      }
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

  const baseUrl = `http://${hostname}:${port}`;

  if (websocket) {
    raw.onRequest(async ({ request: requestData, requestId }) => {
      const webRequest = toWebRequest(requestData, baseUrl);

      const reqCtx = { requestId, upgraded: false, connectionId: null, remoteAddr: requestData.remoteAddr };
      requestContexts.set(webRequest, reqCtx);

      let response;
      try {
        response = await fetchHandler(webRequest, handle);
        if (!(response instanceof Response)) {
          response = new Response("Internal Server Error: fetch handler must return a Response", { status: 500 });
        }
      } catch (err) {
        if (typeof errorHandler === "function") {
          try { response = await errorHandler(err); } catch { response = new Response("Internal Server Error", { status: 500 }); }
        } else {
          console.error("[napi-router] Unhandled error in fetch handler:", err);
          response = new Response("Internal Server Error", { status: 500 });
        }
      }

      if (reqCtx.upgraded && reqCtx.connectionId) {
        raw.sendResponse(requestId, { status: 101, headers: [], upgrade: true, connectionId: reqCtx.connectionId });
        return;
      }

      const reqHeaders = requestData.headers ?? [];
      let hasWsUpgrade = false;
      let hasConnUpgrade = false;
      for (let i = 0; i < reqHeaders.length; i += 2) {
        const k = reqHeaders[i];
        const v = reqHeaders[i + 1];
        if (k === "upgrade" && v.toLowerCase() === "websocket") hasWsUpgrade = true;
        if (k === "connection" && v.toLowerCase().includes("upgrade")) hasConnUpgrade = true;
      }

      if (hasWsUpgrade && hasConnUpgrade) {
        const connectionId = uniqueId("ws");
        connectionMetas.set(connectionId, { data: null, remoteAddress: requestData.remoteAddr ?? null });
        raw.sendResponse(requestId, { status: 101, headers: [], upgrade: true, connectionId });
        return;
      }

      sendResponseFast(raw, requestId, response);
    });
  } else {
    raw.onRequest(async ({ request: requestData, requestId }) => {
      const webRequest = toWebRequest(requestData, baseUrl);

      let response;
      try {
        response = await fetchHandler(webRequest, handle);
        if (!(response instanceof Response)) {
          response = new Response("Internal Server Error: fetch handler must return a Response", { status: 500 });
        }
      } catch (err) {
        if (typeof errorHandler === "function") {
          try { response = await errorHandler(err); } catch { response = new Response("Internal Server Error", { status: 500 }); }
        } else {
          console.error("[napi-router] Unhandled error in fetch handler:", err);
          response = new Response("Internal Server Error", { status: 500 });
        }
      }

      sendResponseFast(raw, requestId, response);
    });
  }

  const info = await raw.listen(port, hostname);
  handle = new ServerHandle(raw, info.port, info.address);
  return handle;
}

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
