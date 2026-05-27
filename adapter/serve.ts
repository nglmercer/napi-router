import { HttpServer, NativeResponse, RequestData, Validator } from "../index.js";
import { RawResponse } from "./router/rawResponse.js";

export interface ServerWebSocket {
  readonly id: string;
  readonly data: WebSocketConnectionData;
  send(message: string): number;
  send(data: Uint8Array | ArrayBuffer): number;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  readonly remoteAddress: string;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  publish(topic: string, message: string | Uint8Array | ArrayBuffer): void;
  isSubscribed(topic: string): boolean;
}

export type WebSocketConnectionData = Record<string, unknown> | null | undefined;

export interface WebSocketHandlers {
  open?(ws: ServerWebSocket): void | Promise<void>;
  message?(
    ws: ServerWebSocket,
    message: string | Uint8Array,
  ): void | Promise<void>;
  close?(
    ws: ServerWebSocket,
    code: number,
    reason: string,
  ): void | Promise<void>;
  error?(ws: ServerWebSocket, error: Error): void | Promise<void>;
  maxPayloadLength?: number;
  idleTimeout?: number;
  perMessageDeflate?: boolean;
}

export interface SocketAddress {
  address: string;
  family: "IPv4" | "IPv6";
  port: number;
}

export interface ServeOptions {
  port?: number;
  hostname?: string;
  fetch(
    request: Request,
    server: Server,
  ): Response | Promise<Response | NativeResponse> | NativeResponse | undefined;
  websocket?: WebSocketHandlers;
  error?(error: Error): Response | Promise<Response>;
}

const requestContexts = new WeakMap<
  Request,
  { requestId: number; remoteAddr?: string }
>();

const connectionMetas = new Map<
  string,
  { data: WebSocketConnectionData; remoteAddress: string | null }
>();

/// Stores Rust-parsed body/query per request (keyed by Request object).
/// Allows bodyParser to skip re-parsing when Rust already parsed the data.
const rustParsedData = new WeakMap<
  Request,
  { parsedBody?: string; queryParams?: Record<string, string> }
>();

export class Server {
  #raw: HttpServer;

  constructor(raw: HttpServer) {
    this.#raw = raw;
  }

  get port(): number {
    return this.#raw.port as number;
  }

  get hostname(): string {
    return this.#raw.hostname as string;
  }

  get url(): string {
    return this.#raw.url as string;
  }

  get pendingRequests(): number {
    return this.#raw.pendingCount() as number;
  }

  get pendingWebSockets(): number {
    return this.#raw.wsConnectionCount() as number;
  }

  async stop(closeActiveConnections = false): Promise<void> {
    await this.#raw.stop(closeActiveConnections);
  }

  upgrade(
    req: Request,
    options: { headers?: HeadersInit; data?: unknown } = {},
  ): boolean {
    const ctx = requestContexts.get(req);
    if (!ctx) return false;

    const connId = this.#raw.upgrade(ctx.requestId);
    if (connId == null) return false;

    connectionMetas.set(connId, {
      data: (options.data ?? null) as WebSocketConnectionData,
      remoteAddress: ctx.remoteAddr ?? null,
    });
    return true;
  }

  requestIP(req: Request): SocketAddress | null {
    const ctx = requestContexts.get(req);
    if (!ctx) return null;
    return this.#raw.requestIp(ctx.requestId) as SocketAddress | null;
  }

  publish(
    topic: string,
    data: string | ArrayBufferView | ArrayBuffer,
    _compress?: boolean,
  ): number {
    const message =
      typeof data === "string"
        ? data
        : new TextDecoder().decode(data as ArrayBufferView);
    return this.#raw.serverPublish(topic, message) as number;
  }

  sendToWs(connectionId: string, message: string): void {
    this.#raw.wsSend(connectionId, message);
  }

  sendBinaryToWs(
    connectionId: string,
    data: number[] | Uint8Array | ArrayBuffer,
  ): void {
    if (data instanceof Uint8Array) {
      this.#raw.wsSendBinary(connectionId, Array.from(data));
    } else if (data instanceof ArrayBuffer) {
      this.#raw.wsSendBinary(connectionId, Array.from(new Uint8Array(data)));
    } else {
      this.#raw.wsSendBinary(connectionId, data);
    }
  }

  closeWs(connectionId: string): void {
    this.#raw.wsClose(connectionId);
  }

  get wsConnectionIds(): string[] {
    return this.#raw.wsConnectionIds() as string[];
  }

  get [Symbol.toStringTag](): string {
    return "Server";
  }

  /**
   * Set a Validator instance for automatic request validation.
   * When set, the server will validate body/query/params before calling JS.
   */
  setValidator(validator: Validator): void {
    this.#raw.setValidator(validator);
  }

  /**
   * Enable/disable automatic validation before JS callback.
   * Requires a Validator to be set via setValidator() first.
   */
  setAutoValidate(enabled: boolean): void {
    this.#raw.setAutoValidate(enabled);
  }
}

function toWebRequest(data: RequestData, baseUrl: string): Request {
  const url = data.url[0] === "/" ? `${baseUrl}${data.url}` : data.url;

  const h = data.headers;
  const headerPairs: [string, string][] = [];
  for (let i = 0; i < h.length; i += 2) {
    headerPairs.push([h[i], h[i + 1]]);
  }

  const init: RequestInit = {
    method: data.method,
    headers: headerPairs,
  };

  if (data.body != null && data.method !== "GET" && data.method !== "HEAD") {
    const bodyBytes =
      data.body instanceof Uint8Array
        ? data.body
        : data.body.length > 0
          ? new Uint8Array(data.body)
          : null;
    if (bodyBytes && bodyBytes.length > 0) {
      init.body = bodyBytes as BodyInit;
    }
  }

  return new Request(url, init);
}

function makeWsProxy(connectionId: string, raw: HttpServer): ServerWebSocket {
  const getMeta = (): { data: WebSocketConnectionData; remoteAddress: string | null } =>
    connectionMetas.get(connectionId) ?? { data: null, remoteAddress: null };

  return {
    get id() {
      return connectionId;
    },

    get data() {
      return getMeta().data;
    },

    get remoteAddress() {
      return getMeta().remoteAddress ?? "";
    },

    get readyState() {
      return 1;
    },

    send(msg: string | Uint8Array | ArrayBuffer): number {
      if (typeof msg === "string")
        return raw.wsSend(connectionId, msg) as number;
      const bytes =
        msg instanceof Uint8Array ? msg : new Uint8Array(msg as ArrayBuffer);
      return raw.wsSendBinary(connectionId, Array.from(bytes)) as number;
    },

    close(_code?: number, _reason?: string): void {
      raw.wsClose(connectionId);
    },

    subscribe(topic: string): void {
      raw.wsSubscribe(connectionId, topic);
    },

    unsubscribe(topic: string): void {
      raw.wsUnsubscribe(connectionId, topic);
    },

    isSubscribed(topic: string): boolean {
      return raw.wsIsSubscribed(connectionId, topic) as boolean;
    },

    publish(topic: string, message: string | Uint8Array | ArrayBuffer): void {
      const msg = typeof message === "string"
        ? message
        : new TextDecoder().decode(message instanceof Uint8Array ? message : new Uint8Array(message));
      raw.wsPublish(connectionId, topic, msg);
    },
  };
}

function wireWebSocket(
  raw: HttpServer,
  wsHandlers: WebSocketHandlers | undefined,
): void {
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

export async function serve(options: ServeOptions): Promise<Server> {
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

  const raw: HttpServer = new HttpServer();
  const server = new Server(raw);
  wireWebSocket(raw, websocket);
  const baseUrl = `http://${hostname}:${port}`;

  raw.onRequest(async (requestData) => {
    const { requestId } = requestData;
    const webRequest = toWebRequest(requestData, baseUrl);
    requestContexts.set(webRequest, {
      requestId,
      remoteAddr: requestData.remoteAddr,
    });

    // Store Rust-parsed data so bodyParser can reuse it (zero duplicate parsing)
    if (requestData.parsedBody !== null && requestData.parsedBody !== undefined) {
      rustParsedData.set(webRequest, {
        parsedBody: requestData.parsedBody,
        queryParams: requestData.queryParams ?? undefined,
      });
    } else if (requestData.queryParams) {
      rustParsedData.set(webRequest, {
        queryParams: requestData.queryParams,
      });
    }

    let response: Response | undefined;

    try {
      const result = await fetchHandler(webRequest, server);

      // NativeResponse path — fully Rust-backed, zero-copy data extraction
      if (result instanceof NativeResponse) {
        raw.submitNativeResponse(requestId, result);
        return;
      }

      // RawResponse path — bypasses Response object creation entirely
      if (RawResponse.isRawResponse(result)) {
        const body = result.body;
        if (typeof body === "string") {
          raw.sendResponseText(
            requestId,
            result.statusCode,
            result.headers,
            body,
          );
        } else if (body instanceof Uint8Array) {
          raw.sendResponseBufferDirect(
            requestId,
            result.statusCode,
            result.headers,
            Buffer.from(body),
          );
        } else {
          raw.sendResponseBufferDirect(
            requestId,
            result.statusCode,
            result.headers,
          );
        }
        return;
      }

      if (!(result instanceof Response)) {
        response = new Response(
          "Internal Server Error: fetch handler must return a Response",
          { status: 500 },
        );
      } else {
        response = result;
      }
    } catch (err) {
      if (typeof errorHandler === "function") {
        try {
          response = await errorHandler(err as Error);
        } catch {
          response = new Response("Internal Server Error", { status: 500 });
        }
      } else {
        console.error("[napi-router] Unhandled error in fetch handler:", err);
        response = new Response("Internal Server Error", { status: 500 });
      }
    }

    if (!response) return;

    const headers: string[] = [];
    response.headers.forEach((value, key) => {
      headers.push(key, value);
    });

    if (websocket) {
      const reqHeaders = requestData.headers;
      let hasWsUpgrade = false;
      let hasConnUpgrade = false;
      for (let i = 0; i < reqHeaders.length; i += 2) {
        const k = reqHeaders[i];
        const v = reqHeaders[i + 1];
        if (k === "upgrade" && v.toLowerCase() === "websocket")
          hasWsUpgrade = true;
        if (k === "connection" && v.toLowerCase().includes("upgrade"))
          hasConnUpgrade = true;
      }

      if (hasWsUpgrade && hasConnUpgrade) {
        const connId = raw.upgrade(requestId);
        if (connId) {
          raw.sendResponse(requestId, {
            status: 101,
            headers: [],
          });
          return;
        }
      }
    }

    if (response.body) {
      const ab = await response.arrayBuffer();
      if (ab.byteLength > 0) {
        raw.sendResponseBufferDirect(
          requestId,
          response.status,
          headers,
          Buffer.from(ab),
        );
      } else {
        raw.sendResponseBufferDirect(requestId, response.status, headers);
      }
    } else {
      raw.sendResponseBufferDirect(requestId, response.status, headers);
    }
  });

  await raw.listen(port, hostname);
  return server;
}

export async function tryServe(
  options: ServeOptions,
): Promise<{ server: Server | null; error: Error | null }> {
  try {
    const server = await serve(options);
    return { server, error: null };
  } catch (err) {
    return { server: null, error: err as Error };
  }
}

/**
 * Get Rust-parsed data for a request (used by bodyParser to avoid re-parsing).
 * @internal
 */
export function getRustParsedData(req: Request): {
  parsedBody?: string;
  queryParams?: Record<string, string>;
} | undefined {
  return rustParsedData.get(req);
}
