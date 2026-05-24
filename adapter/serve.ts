import { HttpServer } from "../index.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ServerWebSocket {
  /** Unique connection identifier assigned by napi-router */
  readonly id: string;
  /** Contextual data attached during upgrade */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly data: any;
  /** Send a text message */
  send(message: string): number;
  /** Send binary data */
  send(data: Uint8Array | ArrayBuffer): number;
  /** Close the connection */
  close(code?: number, reason?: string): void;
  /** Always 1 (OPEN) while the handler is invoked */
  readonly readyState: number;
  /** Remote IP address */
  readonly remoteAddress: string;

  /** Subscribe to a pub/sub topic */
  subscribe(topic: string): void;
  /** Unsubscribe from a pub/sub topic */
  unsubscribe(topic: string): void;
  /** Publish a message to all subscribers of a topic */
  publish(topic: string, message: string | Uint8Array | ArrayBuffer): void;
  /** Check if subscribed to a topic */
  isSubscribed(topic: string): boolean;
}

export interface WebSocketHandlers {
  /** Called when a new WebSocket connection is established */
  open?(ws: ServerWebSocket): void | Promise<void>;
  /** Called when a message is received */
  message?(
    ws: ServerWebSocket,
    message: string | Uint8Array,
  ): void | Promise<void>;
  /** Called when the connection closes */
  close?(
    ws: ServerWebSocket,
    code: number,
    reason: string,
  ): void | Promise<void>;
  /** Called on a WebSocket error */
  error?(ws: ServerWebSocket, error: Error): void | Promise<void>;

  maxPayloadLength?: number;
  idleTimeout?: number;
  perMessageDeflate?: boolean;
}

export interface ServeOptions {
  /** TCP port to listen on. Defaults to 3000. */
  port?: number;
  /** Hostname / IP to bind. Defaults to "0.0.0.0". */
  hostname?: string;
  /**
   * Request handler — receives a standard Web API `Request` and must return a
   * `Response` (or a Promise that resolves to one).
   * May return `undefined` if `server.upgrade()` was called to handle a
   * WebSocket upgrade.
   */
  fetch(
    request: Request,
    server: Server,
  ): Response | Promise<Response> | undefined;
  /**
   * WebSocket event handlers. Providing this object enables WebSocket support.
   */
  websocket?: WebSocketHandlers;
  /**
   * Optional error handler called when `fetch` throws.
   * Must return a `Response`. Falls back to a 500 if omitted.
   */
  error?(error: Error): Response | Promise<Response>;
}

// ---------------------------------------------------------------------------
// FastResponse — zero-copy optimisation
// ---------------------------------------------------------------------------

const OrigResponse = globalThis.Response;

class FastResponse extends OrigResponse {
  /** @internal cached raw body for zero-copy sends */
  _rawBody?: string | Uint8Array | ArrayBuffer;

  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    if (
      typeof body === "string" ||
      body instanceof Uint8Array ||
      body instanceof ArrayBuffer
    ) {
      this._rawBody = body as string | Uint8Array | ArrayBuffer;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static override json(data: any, init?: ResponseInit): FastResponse {
    const body = JSON.stringify(data);
    const headers = {
      ...(init?.headers ?? {}),
      "content-type": "application/json",
    };
    const resp = Reflect.construct(
      OrigResponse,
      [body, { ...init, headers }],
      FastResponse,
    ) as FastResponse;
    resp._rawBody = body;
    return resp;
  }
}

FastResponse.error = OrigResponse.error;
FastResponse.redirect = OrigResponse.redirect;
globalThis.Response = FastResponse as unknown as typeof Response;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const requestContexts = new WeakMap<
  Request,
  {
    requestId: unknown;
    upgraded: boolean;
    connectionId: string | null;
    remoteAddr?: string;
  }
>();

const connectionMetas = new Map<
  string,
  { data: unknown; remoteAddress: string | null }
>();

let nextId = 1;
function uniqueId(prefix = "c"): string {
  return `${prefix}_${nextId++}_${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Server handle (public class)
// ---------------------------------------------------------------------------

export class Server {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #raw: HttpServer;
  #port: number;
  #hostname: string;
  #stopped = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(raw: HttpServer, port: number, hostname: string) {
    this.#raw = raw;
    this.#port = port;
    this.#hostname = hostname;
  }

  /** Bound port */
  get port(): number {
    return this.#port;
  }

  /** Bound hostname / IP */
  get hostname(): string {
    return this.#hostname;
  }

  /** Convenience URL string, e.g. "http://0.0.0.0:3000/" */
  get url(): string {
    return `http://${this.#hostname}:${this.#port}/`;
  }

  /** Number of in-flight requests awaiting a fetch-handler response */
  get pendingRequests(): number {
    return this.#raw.pendingCount() as number;
  }

  /** Number of open WebSocket connections */
  get pendingWebSockets(): number {
    return this.#raw.wsConnectionCount() as number;
  }

  /** Stop the server. Safe to call multiple times. */
  async stop(closeActiveConnections = false): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#raw.close(closeActiveConnections).catch(() => {});
  }

  /**
   * Upgrade the request to a WebSocket connection.
   * Call inside `fetch` when you detect an upgrade request.
   */
  upgrade(
    req: Request,
    options: { headers?: HeadersInit; data?: unknown } = {},
  ): boolean {
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

  /** Publish a message to all subscribers of a topic */
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

  /** Send a text message to a specific WebSocket connection */
  sendToWs(connectionId: string, message: string): void {
    this.#raw.wsSend(connectionId, message);
  }

  /** Send binary data to a specific WebSocket connection */
  sendBinaryToWs(
    connectionId: string,
    data: number[] | Uint8Array | ArrayBuffer,
  ): void {
    if (data instanceof Uint8Array) {
      this.#raw.wsSendBinary(connectionId, data);
    } else if (data instanceof ArrayBuffer) {
      this.#raw.wsSendBinary(connectionId, new Uint8Array(data));
    } else {
      this.#raw.wsSendBinary(connectionId, data);
    }
  }

  /** Close a specific WebSocket connection */
  closeWs(connectionId: string): void {
    this.#raw.wsClose(connectionId);
  }

  /** All currently open WebSocket connection IDs */
  get wsConnectionIds(): string[] {
    return this.#raw.wsConnectionIds() as string[];
  }

  get [Symbol.toStringTag](): string {
    return "Server";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Matches the flat RequestData shape actually emitted by the NAPI layer. */
interface RawRequestData {
  url: string;
  path: string;
  method: string;
  headers: string[];
  /**
   * With `Buffer` on the Rust side, NAPI-RS delivers body as a `Uint8Array`
   * (zero-copy external buffer).  A `number[]` path is kept as a safety net
   * for any legacy / compatibility scenario.
   */
  body?: Uint8Array | number[] | null;
  remoteAddr: string;
  requestId: number;
}

function toWebRequest(data: RawRequestData, baseUrl: string): Request {
  const url = data.url[0] === "/" ? `${baseUrl}${data.url}` : data.url;

  const h = data.headers;
  const headersObj: Record<string, string> = {};
  for (let i = 0; i < h.length; i += 2) {
    headersObj[h[i]] = h[i + 1];
  }

  const init: RequestInit = {
    method: data.method,
    headers: headersObj,
  };

  if (data.body != null && data.method !== "GET" && data.method !== "HEAD") {
    // Uint8Array arrives zero-copy from the Rust Buffer; number[] is a legacy fallback.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sendResponseFast(
  raw: any,
  requestId: unknown,
  response: Response & { _rawBody?: string | Uint8Array | ArrayBuffer },
): void {
  const headers: string[] = [];
  response.headers.forEach((value, key) => {
    headers.push(key, value);
  });

  const rawBody = response._rawBody;
  if (typeof rawBody === "string") {
    raw.sendResponseText(requestId, response.status, headers, rawBody);
    return;
  }
  if (rawBody instanceof Uint8Array) {
    // Pass the Uint8Array directly — Rust side accepts Buffer | Vec<u8>.
    raw.sendResponseBuffer(requestId, response.status, headers, rawBody);
    return;
  }
  if (rawBody instanceof ArrayBuffer) {
    raw.sendResponseBuffer(
      requestId,
      response.status,
      headers,
      new Uint8Array(rawBody),
    );
    return;
  }

  response.arrayBuffer().then(
    (buf) =>
      raw.sendResponseBuffer(
        requestId,
        response.status,
        headers,
        new Uint8Array(buf),
      ),
    () =>
      raw.sendResponseBuffer(
        requestId,
        response.status,
        headers,
        new Uint8Array(0),
      ),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeWsProxy(connectionId: string, raw: any): ServerWebSocket {
  const getMeta = () =>
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
      raw.wsPublish(connectionId, topic, message);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wireWebSocket(
  raw: any,
  wsHandlers: WebSocketHandlers | undefined,
): void {
  if (!wsHandlers) return;

  raw.onWsEvent(
    (event: {
      connectionId: string;
      eventType: "open" | "message" | "close" | "error" | "disconnect";
      remoteAddr?: string;
      text?: string;
      binary?: number[];
      code?: number;
      reason?: string;
      error?: string;
    }) => {
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
    },
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start an HTTP server with a Bun-compatible `serve()` API.
 * Works in Node.js, Bun, and Deno.
 *
 * @example
 * ```ts
 * import { serve } from 'napi-router/adapter';
 *
 * const server = await serve({
 *   port: 3000,
 *   fetch(req) {
 *     return new Response('Hello!');
 *   },
 * });
 * console.log(`Listening on ${server.url}`);
 * ```
 */
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = new HttpServer();
  let handle: Server | null = null;

  wireWebSocket(raw, websocket);

  const baseUrl = `http://${hostname}:${port}`;

  if (websocket) {
    raw.onRequest(async (requestData: RawRequestData) => {
      const { requestId } = requestData;
      const webRequest = toWebRequest(requestData, baseUrl);

      const reqCtx = {
        requestId,
        upgraded: false,
        connectionId: null as string | null,
        remoteAddr: requestData.remoteAddr,
      };
      requestContexts.set(webRequest, reqCtx);

      let response: Response;
      try {
        const result = await fetchHandler(webRequest, handle!);
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

      if (reqCtx.upgraded && reqCtx.connectionId) {
        raw.sendResponse(requestId, {
          status: 101,
          headers: [],
          upgrade: true,
          connectionId: reqCtx.connectionId,
        });
        return;
      }

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
        const connectionId = uniqueId("ws");
        connectionMetas.set(connectionId, {
          data: null,
          remoteAddress: requestData.remoteAddr ?? null,
        });
        raw.sendResponse(requestId, {
          status: 101,
          headers: [],
          upgrade: true,
          connectionId,
        });
        return;
      }

      sendResponseFast(raw, requestId, response);
    });
  } else {
    raw.onRequest(async (requestData: RawRequestData) => {
      const { requestId } = requestData;
      const webRequest = toWebRequest(requestData, baseUrl);

      let response: Response;
      try {
        const result = await fetchHandler(webRequest, handle!);
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

      sendResponseFast(raw, requestId, response);
    });
  }

  const info = await raw.listen(port, hostname);
  handle = new Server(raw, info.port, info.address);
  return handle;
}

/**
 * Non-throwing variant of `serve()`.
 * Returns `{ server, error }` instead of throwing.
 *
 * @example
 * ```ts
 * const { server, error } = await tryServe({ port: 3000, fetch: handler });
 * if (error) console.error('Failed to start:', error);
 * ```
 */
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
