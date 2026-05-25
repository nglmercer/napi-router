import { mock } from "bun:test";
import type { Server, SocketAddress } from "bun";
import type {
  WebSocketData,
  CookieOptions,
  Request as EnhancedRequest,
} from "../types";
import type { ResponseBuilder } from "../responseBuilder";
import { Param } from "../router/param";
import { HttpMethod, parseHttpMethods } from "../method";
import type { SplitPath } from "../path";
import type { Awaitable } from "../types";

// ─── Tracked mock helper ─────────────────────────────────────────────

type TrackedFn<T extends (...args: any[]) => any> = T & {
  calls: Array<Parameters<T>>;
  mock: {
    calls: Array<Parameters<T>>;
    results: Array<{ type: string; value: any }>;
  };
};

function tracked<T extends (...args: any[]) => any>(fn: T): TrackedFn<T> {
  const m = mock(fn) as any;
  Object.defineProperty(m, "calls", {
    get: () => m.mock.calls,
    enumerable: true,
    configurable: true,
  });
  return m;
}

/**
 * Type-safe accessor for tracked mock call data.
 * No `as any` needed at the call site.
 *
 * @example
 *   const etagCall = calls(res.setHeader).find(c => c[0] === "ETag");
 *   expect(calls(res.setHeader)).toContainEqual(["X-Foo", "bar"]);
 */
export function calls<T extends (...args: any[]) => any>(
  fn: T,
): Array<Parameters<T>> {
  return (fn as unknown as { calls?: Array<Parameters<T>> }).calls ?? [];
}

// ─── Events ───────────────────────────────────────────────────────────

export interface MockResponseEventMap {
  send: CustomEvent<{ body: unknown }>;
  status: CustomEvent<{ code: number; text?: string }>;
  header: CustomEvent<{ name: string; value: string }>;
  redirect: CustomEvent<{ url: string; permanent: boolean }>;
  reset: CustomEvent<void>;
  beforeSentRegister: CustomEvent<{ hook: Function }>;
  response: CustomEvent<{ response: Response }>;
}

// ─── MockRequest ──────────────────────────────────────────────────────

export interface MockRequestInit {
  method?: string;
  headers?: Headers | Record<string, string>;
  body?: string | ArrayBuffer | Blob | null;
  url?: string;

  // Custom fields from the Request interface
  httpMethod?: HttpMethod | string;
  path?: string;
  splitPath?: SplitPath;
  server?: Partial<Server<WebSocketData>>;
  sock?: Partial<SocketAddress>;
  cookies?: Record<string, string | undefined>;
  originCookies?: unknown;
  upgraded?: true;
  id?: string;
  pathParams?: string[] | Record<string, string>;
  parsedBody?: unknown;
  queryParams?: Record<string, string>;
  ip?: string;
  ips?: string[];
}

/**
 * A full in-memory mock of router-bun's enhanced Request type.
 *
 * - Body is stored internally as a string so `text()`, `json()`,
 *   `arrayBuffer()`, and `clone()` are all idempotent (no body locking).
 * - Extends `EventTarget` so tests can listen for events.
 * - All custom router-bun fields (cookies, parsedBody, pathParams, etc.)
 *   are real writable properties.
 */
export class MockRequest extends EventTarget {
  // ── Standard Request API ──────────────────────────────────────────
  readonly headers: Headers;
  readonly method: string;
  readonly url: string;
  readonly referrer: string = "";
  readonly referrerPolicy: ReferrerPolicy = "" as ReferrerPolicy;
  readonly mode: RequestMode = "cors";
  readonly credentials: RequestCredentials = "same-origin";
  readonly cache: RequestCache = "default";
  readonly redirect: RequestRedirect = "follow";
  readonly integrity: string = "";
  readonly keepalive: boolean = false;
  readonly isHistoryNavigation: boolean = false;
  readonly signal: AbortSignal = new AbortController().signal;
  readonly bodyUsed: boolean = false;
  readonly destination: RequestDestination = "" as RequestDestination;
  readonly body: ReadableStream<Uint8Array> | null = null;

  private _bodyText: string;

  // ── Custom router-bun fields ───────────────────────────────────────
  httpMethod: HttpMethod;
  path: string;
  splitPath: SplitPath;
  server: Server<WebSocketData>;
  sock: SocketAddress;
  originCookies: unknown;
  cookies: Record<string, string | undefined>;
  upgraded?: true;
  id?: string;
  pathParams?: string[] | Record<string, string>;
  parsedBody?: unknown;
  queryParams: Record<string, string>;
  ip: string;
  ips: string[];

  constructor(input?: string | MockRequestInit, init?: MockRequestInit) {
    super();

    let urlStr: string;
    let options: MockRequestInit;

    if (typeof input === "string") {
      urlStr = input;
      options = init ?? {};
    } else {
      options = input ?? {};
      urlStr = options.url ?? "http://localhost/";
    }

    this.url = urlStr;
    this.method = options.method ?? "GET";
    this._bodyText = typeof options.body === "string" ? options.body : "";
    this.headers =
      options.headers instanceof Headers
        ? options.headers
        : new Headers((options.headers as Record<string, string>) ?? {});

    // Custom fields
    this.httpMethod =
      typeof options.httpMethod === "string"
        ? parseHttpMethods(options.httpMethod)
        : (options.httpMethod ?? parseHttpMethods(this.method));
    this.path = options.path ?? new URL(this.url).pathname;
    this.splitPath = options.splitPath;
    this.server = (options.server ?? {}) as Server<WebSocketData>;
    this.sock = (options.sock ?? {}) as SocketAddress;
    this.cookies = ("cookies" in options ? options.cookies : {}) as Record<
      string,
      string | undefined
    >;
    this.originCookies =
      "originCookies" in options ? options.originCookies : undefined;
    this.upgraded = options.upgraded;
    this.id = options.id;
    this.pathParams = options.pathParams;
    this.parsedBody = options.parsedBody;
    this.queryParams = options.queryParams ?? {};
    this.ip = options.ip ?? "127.0.0.1";
    this.ips = options.ips ?? ["127.0.0.1"];
  }

  // ── Body reading (always succeeds, no locking) ────────────────────

  async text(): Promise<string> {
    this.dispatchEvent(new CustomEvent("text"));
    return this._bodyText;
  }

  async json(): Promise<unknown> {
    this.dispatchEvent(new CustomEvent("json"));
    return JSON.parse(this._bodyText);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.dispatchEvent(new CustomEvent("arrayBuffer"));
    return new TextEncoder().encode(this._bodyText).buffer;
  }

  async bytes(): Promise<Uint8Array> {
    this.dispatchEvent(new CustomEvent("bytes"));
    return new TextEncoder().encode(this._bodyText);
  }

  async blob(): Promise<Blob> {
    this.dispatchEvent(new CustomEvent("blob"));
    return new Blob([this._bodyText]);
  }

  async formData(): Promise<FormData> {
    this.dispatchEvent(new CustomEvent("formData"));
    const fd = new FormData();
    const params = new URLSearchParams(this._bodyText);
    params.forEach((value, key) => fd.append(key, value));
    return fd;
  }

  clone(): MockRequest {
    const cloned = new MockRequest({
      url: this.url,
      method: this.method,
      headers: new Headers(this.headers),
      body: this._bodyText,
      httpMethod: this.httpMethod,
      path: this.path,
      splitPath: this.splitPath,
      server: this.server,
      sock: this.sock,
      cookies: { ...this.cookies },
      originCookies: this.originCookies,
      upgraded: this.upgraded,
      id: this.id,
      pathParams: this.pathParams,
      parsedBody: this.parsedBody,
      queryParams: { ...this.queryParams },
      ip: this.ip,
      ips: [...this.ips],
    });
    return cloned;
  }

  // ── Query / param helpers ─────────────────────────────────────────

  query(key?: string): string | string[] | Record<string, string> | undefined {
    if (key) return this.queryParams[key];
    return this.queryParams;
  }

  queries(key: string): string[] {
    const v = this.queryParams[key];
    return v !== undefined ? [v] : [];
  }

  queryParam(key: string): Param;
  queryParam(): Record<string, Param>;
  queryParam(key?: string): Param | Record<string, Param> {
    if (key) return new Param(this.queryParams[key]);
    const result: Record<string, Param> = {};
    for (const k of Object.keys(this.queryParams)) {
      result[k] = new Param(this.queryParams[k]);
    }
    return result;
  }

  pathParam(key: string): Param;
  pathParam(): Record<string, Param>;
  pathParam(key?: string): Param | Record<string, Param> {
    const params = !this.pathParams
      ? {}
      : Array.isArray(this.pathParams)
        ? Object.fromEntries(this.pathParams.map((v, i) => [String(i), v]))
        : this.pathParams;
    if (key) return new Param(params[key]);
    const result: Record<string, Param> = {};
    for (const k of Object.keys(params)) {
      result[k] = new Param(params[k]);
    }
    return result;
  }

  // ── toString / toJSON ─────────────────────────────────────────────

  toString(): string {
    return `[MockRequest ${this.method} ${this.url}]`;
  }
}

// ─── MockResponseBuilder ──────────────────────────────────────────────

/**
 * A full in-memory mock of ResponseBuilder.
 *
 * - Extends `EventTarget` so tests can listen for events like `"send"`,
 *   `"header"`, `"status"`, `"redirect"`, `"reset"`, `"response"`.
 * - All methods are wrapped with `mock()` from bun:test so they can be
 *   inspected via `expect(res.setHeader).toHaveBeenCalledWith(...)`.
 * - `beforeSent` hooks are stored and executed by `startBeforeSentHook()`.
 */
export class MockResponseBuilder extends EventTarget {
  // ── State ─────────────────────────────────────────────────────────
  submit: boolean = false;
  statusCode: number = 200;
  statusText?: string;
  bodyInit: unknown = null;
  headers: [string, string][] = [];
  private _beforeSentHooks: Array<
    (res: MockResponseBuilder) => Awaitable<void>
  > = [];

  // ── Status ────────────────────────────────────────────────────────

  status = tracked((code: number, text?: string): this => {
    this.statusCode = code;
    if (text !== undefined) this.statusText = text;
    this.dispatchEvent(new CustomEvent("status", { detail: { code, text } }));
    return this;
  });

  // ── Body / send ───────────────────────────────────────────────────

  send = tracked((body: unknown = null): void => {
    this.bodyInit = body;
    this.submit = true;
    this.dispatchEvent(new CustomEvent("send", { detail: { body } }));
    this.dispatchEvent(new CustomEvent("response"));
  });

  body = tracked((body: unknown = null): this => {
    this.bodyInit = body;
    return this;
  });

  // ── Typed responses ───────────────────────────────────────────────

  sendJson = tracked((data: unknown, code?: number): void => {
    const saved = this.statusCode;
    this.reset();
    this.statusCode = saved;
    this.bodyInit = JSON.stringify(data);
    this.setHeader("content-type", "application/json");
    if (code !== undefined) this.statusCode = code;
    this.submit = true;
    this.dispatchEvent(new CustomEvent("response"));
  });

  json = tracked((data: unknown, code?: number): void => {
    this.sendJson(data, code);
  });

  sendText = tracked((data: string, code?: number): void => {
    this.reset();
    this.bodyInit = data;
    this.setHeader("content-type", "text/plain; charset=UTF-8");
    if (code !== undefined) this.statusCode = code;
    this.submit = true;
    this.dispatchEvent(new CustomEvent("response"));
  });

  text = tracked((data: string, code?: number): void => {
    this.sendText(data, code);
  });

  sendHtml = tracked((data: string, code?: number): void => {
    this.reset();
    this.bodyInit = data;
    this.setHeader("content-type", "text/html; charset=UTF-8");
    if (code !== undefined) this.statusCode = code;
    this.submit = true;
    this.dispatchEvent(new CustomEvent("response"));
  });

  html = tracked((data: string, code?: number): void => {
    this.sendHtml(data, code);
  });

  sendError = tracked((message: string, code: number = 500): void => {
    this.reset();
    this.bodyInit = JSON.stringify({ error: message, status: code });
    this.setHeader("content-type", "application/json");
    this.statusCode = code;
    this.submit = true;
    this.dispatchEvent(new CustomEvent("response"));
  });

  error = tracked((message: string, code: number = 500): void => {
    this.sendError(message, code);
  });

  sendNoContent = tracked((): void => {
    this.reset();
    this.statusCode = 204;
    this.submit = true;
    this.dispatchEvent(new CustomEvent("response"));
  });

  noContent = tracked((): void => {
    this.sendNoContent();
  });

  // ── File ──────────────────────────────────────────────────────────

  sendFile = tracked((file: import("bun").BunFile, code?: number): void => {
    this.reset();
    this.bodyInit = file;
    this.setHeader("content-type", file.type);
    if (code !== undefined) this.statusCode = code;
    this.submit = true;
    this.dispatchEvent(new CustomEvent("response"));
  });

  file = tracked((file: import("bun").BunFile, code?: number): void => {
    this.sendFile(file, code);
  });

  // ── Redirect ──────────────────────────────────────────────────────

  sendRedirect = tracked((url: string, permanent: boolean = false): void => {
    this.reset();
    this.statusCode = permanent ? 308 : 307;
    this.headers.push(["location", url]);
    this.submit = true;
    this.dispatchEvent(
      new CustomEvent("redirect", { detail: { url, permanent } }),
    );
    this.dispatchEvent(new CustomEvent("response"));
  });

  sendRedirectCustom = tracked((url: string, status: number): void => {
    this.reset();
    this.statusCode = status;
    this.headers.push(["location", url]);
    this.submit = true;
    this.dispatchEvent(
      new CustomEvent("redirect", { detail: { url, permanent: null } }),
    );
    this.dispatchEvent(new CustomEvent("response"));
  });

  // ── Headers ───────────────────────────────────────────────────────

  setHeader = tracked(
    (name: string, value: string, overwrite: boolean = true): this => {
      if (overwrite) {
        this.unsetHeader(name);
      }
      this.headers.push([name, value]);
      this.dispatchEvent(
        new CustomEvent("header", { detail: { name, value } }),
      );
      return this;
    },
  );

  unsetHeader = tracked((name: string): this => {
    const lower = name.toLowerCase();
    this.headers = this.headers.filter(([h]) => h.toLowerCase() !== lower);
    return this;
  });

  // ── Cookies ───────────────────────────────────────────────────────

  setCookie = tracked(
    (name: string, value: string, options: CookieOptions = {}): this => {
      const parts = [`${name}=${encodeURIComponent(value)}`];
      if (options.MaxAge) parts.push(`Max-Age=${options.MaxAge}`);
      if (options.Path) parts.push(`Path=${options.Path}`);
      if (options.HttpOnly) parts.push("HttpOnly");
      if (options.Secure) parts.push("Secure");
      if (options.SameSite) parts.push(`SameSite=${options.SameSite}`);
      this.setHeader("Set-Cookie", parts.join("; "), false);
      return this;
    },
  );

  unsetCookie = tracked((name: string): this => {
    this.setHeader(
      "Set-Cookie",
      `${name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      false,
    );
    return this;
  });

  // ── Hooks ─────────────────────────────────────────────────────────

  beforeSent = tracked(
    (hook: (res: MockResponseBuilder) => Awaitable<void>): this => {
      this._beforeSentHooks.push(hook);
      this.dispatchEvent(
        new CustomEvent("beforeSentRegister", { detail: { hook } }),
      );
      return this;
    },
  );

  /**
   * Execute all registered beforeSent hooks in order.
   * Returns a promise if any hook is async.
   */
  startBeforeSentHook(): Awaitable<void> {
    const run = (): void | Promise<void> => {
      const hook = this._beforeSentHooks.shift();
      if (!hook) return;
      const result = hook(this);
      if (result && typeof (result as Promise<void>).then === "function") {
        return (result as Promise<void>).then(() => {
          const next = run();
          if (next && typeof (next as Promise<void>).then === "function") {
            return next;
          }
        });
      }
      return run();
    };
    return run();
  }

  // ── Reset / build / clone ─────────────────────────────────────────

  reset = tracked((): this => {
    this.submit = false;
    this.statusCode = 200;
    this.statusText = undefined;
    this.bodyInit = null;
    this.headers = [];
    this.dispatchEvent(new CustomEvent("reset"));
    return this;
  });

  build(): Response {
    const body =
      typeof this.bodyInit === "string" || this.bodyInit === null
        ? (this.bodyInit as BodyInit | null)
        : JSON.stringify(this.bodyInit);
    return new Response(body, {
      status: this.statusCode,
      statusText: this.statusText,
      headers: this.headers,
    });
  }

  clone(): MockResponseBuilder {
    const rb = new MockResponseBuilder();
    rb.submit = this.submit;
    rb.statusCode = this.statusCode;
    rb.statusText = this.statusText;
    rb.bodyInit = this.bodyInit;
    rb.headers = [...this.headers];
    rb._beforeSentHooks = [...this._beforeSentHooks];
    return rb;
  }
}

// ─── Mock Server (unchanged) ──────────────────────────────────────────

/**
 * Mock Server for WebSocket/Upgrade testing.
 * Stubs every member of Bun's Server<WebSocketData> interface so the type
 * check passes without maintaining a separate interface.
 */
export const createMockServer = () => {
  const server = {
    upgrade: mock(() => true),
    pendingWebSockets: 0,
    publish: mock(() => 0),
    requestIP: mock(() => ({
      address: "127.0.0.1",
      family: "IPv4" as const,
      port: 3000,
    })),
    stop: mock(async () => {}),
    reload: mock(() => {}),
    fetch: mock(async () => new Response(null)),
    subscriberCount: mock(() => 0),
    subscribe: mock(() => {}),
    unsubscribe: mock(() => {}),
    isSubscribed: mock(() => false),
    cork: mock((cb: any) => cb()),
    ref: mock(() => {}),
    unref: mock(() => {}),
    hostname: "localhost",
    port: 3000,
    development: false,
    id: "",
  } as unknown as Server<WebSocketData>;

  Object.defineProperty(server, "url", {
    value: new URL("http://localhost:3000"),
    writable: false,
    enumerable: true,
    configurable: true,
  });

  return server;
};

// ─── Factory functions (backward compatible) ─────────────────────────

export type MockRequestOverrides = Partial<MockRequestInit>;

/**
 * Creates a MockRequest with sensible defaults.
 * Returns it cast as the enhanced Request type for Context constructor compatibility.
 */
export const createMockReq = (
  overrides: MockRequestOverrides = {},
): EnhancedRequest => {
  const { headers, body, ...rest } = overrides;
  return new MockRequest({
    url: "http://localhost/",
    method: "GET",
    headers:
      headers instanceof Headers
        ? headers
        : new Headers((headers as Record<string, string>) ?? {}),
    httpMethod: "GET",
    path: "/",
    splitPath: ["/"],
    cookies: {},
    queryParams: {},
    ip: "127.0.0.1",
    ips: ["127.0.0.1"],
    ...rest,
    body: body ?? undefined,
  }) as unknown as EnhancedRequest;
};

/**
 * Creates a MockResponseBuilder.
 * Returns it cast as ResponseBuilder for Context constructor compatibility.
 */
export const createMockRes = (): ResponseBuilder => {
  return new MockResponseBuilder() as unknown as ResponseBuilder;
};
