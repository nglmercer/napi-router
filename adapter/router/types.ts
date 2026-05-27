import { type Server, type SocketAddress } from "../serve";
import { type HttpMethod } from "./method";
import type { ResponseBuilder } from "./responseBuilder";
import type { SplitPath } from "./path";
import { Param } from "./router/param";

export type Awaitable<T> = T | Promise<T>;
export type WebSocketData =
  | {
      createdAt?: number;
      channelId?: string;
      authToken?: string;
      [key: string]: unknown;
    }
  | undefined;
export type PathParams = string[] | Record<string, string>;

export interface NRequest extends Request {
  pathParams?: PathParams;
  pathParam(key: string): Param;
  pathParam(): Record<string, Param>;
  httpMethod: HttpMethod;
  path: string;
  splitPath: SplitPath;
  server: Server;
  sock: SocketAddress;
  originCookies: unknown;
  cookies: {
    [key: string]: string | undefined;
  };
  upgraded?: true;
  id?: string;
  parsedBody?: unknown;
  queryParam(key: string): Param;
  queryParam(): Record<string, Param>;
  queryParams: Record<string, string>;
  query(key?: string): string | string[] | Record<string, string> | undefined;
  queries(key: string): string[];
  ip: string;
  ips: string[];
  /** Rust-parsed JSON body string (set by handler for validator reuse). */
  _rustParsedBody?: string;
  /** Rust-parsed query params (set by serve.ts from RequestData). */
  _rustQueryParams?: Record<string, string>;
}

export type RequestHandler = (
  request: Request,
  server: Server,
) => Awaitable<Response>;

export type RequestMiddleware = (
  ctx: Context,
) => void | Response | Promise<void | Response>;

export type MergedRequestMiddleware = RequestMiddleware & {
  base: RequestMiddleware[];
};

export interface EndpointRoute {
  handler: RequestMiddleware;
  method: HttpMethod;
  splitPath: SplitPath;
  middlewareName?: string;
}

export interface CookieOptions {
  MaxAge?: number;
  Path?: string;
  HttpOnly?: boolean;
  Secure?: boolean;
  SameSite?: "Strict" | "Lax" | "None";
}

/**
 * Extensible data map for per-request context storage.
 * Augment this interface to get auto-inferred types for ctx.get / ctx.set.
 *
 * @example
 *   declare module "router-bun" {
 *     interface ContextDataMap {
 *       user: { id: string; role: "admin" | "user" }
 *     }
 *   }
 *
 *   ctx.set("user", { id: "1", role: "admin" }) // type-checked
 *   const user = ctx.get("user")                // UserData | undefined
 */
export type { NRequest as Request };

export interface ContextDataMap {
  [key: string]: unknown;
}

// Forward-declare Context to avoid circular imports.
// The actual class is in ./context.ts and extends this.
export interface Context {
  req: NRequest;
  res: ResponseBuilder;
  readonly data: Record<string, unknown>;
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly path: string;

  set<K extends keyof ContextDataMap>(key: K, value: ContextDataMap[K]): void;
  set(key: string, value: unknown): void;
  get<K extends keyof ContextDataMap>(key: K): ContextDataMap[K] | undefined;
  get<T = unknown>(key: string): T;
  status(code: number): this;
  json(data: unknown, code?: number): void;
  text(body: string, code?: number): void;
  html(body: string, code?: number): void;
  redirect(url: string, code?: number): void;
  notFound(msg?: string): void;
  error(msg: string, code?: number): void;
  build(): Response;
}
