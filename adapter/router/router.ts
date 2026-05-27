import type {
  Awaitable,
  RequestHandler,
  EndpointRoute,
  RequestMiddleware,
  NRequest,
  NRequest as Request,
  MergedRequestMiddleware,
  Context,
} from "./types";
import {
  type Server,
  type WebSocketHandlers,
} from "../serve";
import { isMergedRequestMiddleware } from "./middleware";
import { HttpMethodString, stringifyHttpMethods } from "./method";
import { ResponseBuilder, HTTP_STATUS } from "./responseBuilder";
import { splitRoutePath } from "./path";
import { innerHandle } from "./router/handler";
// Import modularized components
import { parseCookies, storeCookies } from "./router/cookies";
import {
  dump as dumpRoutes,
  getRouteDefinitions as getDefs,
} from "./router/dump";
import type { RouteDefinition, QueryParamInfo } from "./router/dump";
import {
  use as registerUse,
  get as registerGet,
  post as registerPost,
  put as registerPut,
  deleteMethod as registerDelete,
  patch as registerPatch,
  trace as registerTrace,
  head as registerHead,
  connect as registerConnect,
  options as registerOptions,
} from "./router/registration";
import {
  ws as registerWs,
  redirect as registerRedirect,
  staticFiles as registerStatic,
  cookies as registerCookies,
} from "./router/builtin";
import { cors as registerCors, type CorsOptions } from "./router/cors";
import {
  bodyParser as registerBodyParser,
  type BodyParserOptions,
} from "./router/bodyParser";
import {
  rateLimit as registerRateLimit,
  type RateLimitOptions,
} from "./router/rateLimit";
import {
  requestId as registerRequestId,
  type RequestIdOptions,
} from "./router/requestId";
import {
  timeout as registerTimeout,
  type TimeoutOptions,
} from "./router/timeout";
import {
  fileUpload as registerFileUpload,
  type FileUploadOptions,
  getFile,
  getFiles,
  getFileFieldNames,
  getFormFields,
} from "./router/fileUpload";
import {
  validate as createValidateMiddleware,
  schemaDefToJson,
  type RouteSchemaDefinition,
} from "./router/validator";
import type { Validator } from "../index.js";
export type ErrorHandler = (err: Error, ctx: Context) => Awaitable<void>;

/**
 * ## Simple Router
 * ### About
 * A simple express-like router for napi-router serve.
 *
 * ### Usage:
 * Use router.handle as the fetch handler for napi-router's serve:
 * ```ts
 * const server = await serve({
 *     fetch: router.handle,
 * })
 * ```
 *
 * But you can also use the convenient router.listen function:
 * ```ts
 * const server = router.listen()
 * ```
 */
export class Router {
  routes: EndpointRoute[] = [];
  mergeHandlers: boolean = true;
  private wsHandlers?: WebSocketHandlers;
  private errorHandler?: ErrorHandler;
  private routeMeta = new Map<string, { queryParams?: QueryParamInfo[] }>();
  private _validator?: Validator;

  // Expose cookie methods as static
  static parseCookies = parseCookies;
  static storeCookies = storeCookies;

  /**
   * Prints a table of all endpoints defined in this router.
   *
   * If a server is given as a parameter, a running message with the url of the server is printed too.
   * @param server The server to print the url of
   * @returns A string representing the table of endpoints
   */
  dump(...servers: Server[]): string {
    return dumpRoutes(this.routes, ...servers);
  }

  /**
   * Returns all registered routes as a structured object.
   * Useful for API documentation or creating dynamic endpoint listings.
   * @param includeMiddleware Whether to include middleware routes (default: false)
   * @returns An array of route objects with method and path
   */
  getRoutes(
    includeMiddleware: boolean = false,
  ): Array<{ method: string; path: string }> {
    const seen = new Set<string>();
    const result: Array<{ method: string; path: string }> = [];

    for (const route of this.routes) {
      const method = stringifyHttpMethods(route.method);
      const path = route.splitPath ? "/" + route.splitPath.join("/") : "/";
      const key = `${method}:${path}`;

      // Skip duplicates
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      // Skip middleware routes unless requested
      if (!includeMiddleware && this.isMiddlewareRoute(route)) {
        continue;
      }

      result.push({ method, path });
    }

    return result;
  }

  /**
   * Returns structured route definitions with path parameter info, middleware chains,
   * handler names, and optional performance stats.
   *
   * Unlike `getRoutes()` which returns plain method/path pairs, this returns rich
   * metadata suitable for Swagger/OpenAPI generation, API documentation, or tooling.
   * Duplicate method+path combinations are deduplicated.
   *
   * @example
   * ```ts
   * const defs = router.getRouteDefinitions()
   * for (const def of defs) {
   *   // def.method   → "GET"
   *   // def.path     → "/users/:id"
   *   // def.pathParams → [{ name: "id", type: "named", position: 1 }]
   * }
   * ```
   */
  getRouteDefinitions(): RouteDefinition[] {
    return getDefs(this.routes, this.routeMeta);
  }

  /**
   * Attach metadata (query params, descriptions) to a route path.
   * The metadata is included in `getRouteDefinitions()` output and is
   * used for Swagger/OpenAPI generation or API documentation tooling.
   *
   * Query params are **declarative metadata only** — they don't affect routing.
   * At runtime, ANY query string is accepted; use `req.queryParam()` to read them.
   *
   * @param path The route path (e.g. "/search")
   * @param meta Metadata describing the route's expected query parameters
   *
   * @example
   * ```ts
   * router.get("/search", handlerName("search", handler))
   * router.describe("/search", {
   *   queryParams: [
   *     { name: "q",        type: "string",  required: true,  description: "Search query" },
   *     { name: "limit",    type: "integer", required: false, default: 20 },
   *     { name: "category", type: "string",  required: false, enum: ["tech", "design"] },
   *   ]
   * })
   * // getRouteDefinitions() → queryParams populated with metadata
   * ```
   */
  describe(path: string, meta: { queryParams?: QueryParamInfo[] }): this {
    this.routeMeta.set(path, { ...meta });
    return this;
  }

  private isMiddlewareRoute(route: EndpointRoute): boolean {
    // Check if route has middlewareName set
    if (route.middlewareName) {
      return true;
    }

    // Check if it's a merged middleware containing middleware
    if (isMergedRequestMiddleware(route.handler)) {
      const base = (route.handler as MergedRequestMiddleware).base;
      for (const m of base) {
        // Check if any base handler has a middlewareName in its route
        // We can't directly access route from here, so check handler name patterns
        const name = m.name || "";
        if (name.endsWith("Middleware") || name.endsWith("middleware")) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * This function can be used as fetch handler for napi-router serve.
   * It will route a request to the correct handler based on the request's method and path.
   * @param request A request object
   * @param server A server object
   * @returns Response, void or a promise of response or void
   */
  handle: RequestHandler = (request, server) => {
    try {
      const result = innerHandle(this.routes, request as unknown as NRequest, server);
      if (result && result instanceof Promise) {
        return (result as Promise<Response>).catch((err: Error) => {
          if (this.errorHandler) {
            const res = new ResponseBuilder();
            const ctx = { req: request, res } as Context;
            const p = this.errorHandler(err, ctx);
            if (p && p instanceof Promise) {
              return (p as Promise<void>).then(() => res.build());
            }
            return res.build();
          }
          return new Response("Internal Server Error", {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
          });
        });
      }
      return result as Response;
    } catch (err) {
      if (this.errorHandler) {
        const res = new ResponseBuilder();
        const ctx = { req: request, res } as Context;
        const p = this.errorHandler(err as Error, ctx);
        if (p && p instanceof Promise) {
          return (p as Promise<void>).then(() => res.build());
        }
        return res.build();
      }
      return new Response("Internal Server Error", {
        status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      });
    }
  };

  /**
   * Send a request directly to the router without an HTTP server.
   * Useful for testing.
   * @param request A Request object, or a URL string.
   * @param options RequestInit options if the first param is a string.
   * @returns A promise of the Response object returned by the handler.
   */
  request(
    request: globalThis.Request | string,
    options?: RequestInit,
  ): Promise<Response> {
    let req: globalThis.Request;
    if (typeof request === "string") {
      // Handle relative URLs by prepending default base
      const url = request.startsWith("/")
        ? `http://localhost${request}`
        : request;
      req = new globalThis.Request(url, options);
    } else {
      req = request;
    }
    const res = this.handle(
      req as unknown as Request,
      {
        requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 0 }),
      } as unknown as Server,
    );
    return Promise.resolve(res as Response);
  }

  /**
   * Register a handler to run for all incoming requests.
   * @param method The HTTP method to run the handler on (undefined = all)
   * @param path The path to run the handler on (undefined = all)
   * @param handlers The handler(s) to run
   * @returns The router
   */
  use(
    method: "*" | HttpMethodString,
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
  ): Router {
    registerUse(
      this.routes,
      this.mergeHandlers,
      method,
      path,
      handler,
      ...handlers,
    );
    return this;
  }

  /**
   * Registers a route for the `GET` HTTP method.
   * @param path The route path.
   * @param handler The handler function for the route.
   * @param handlers Additional middleware functions to apply to the route.
   * @returns The router instance.
   */
  get(
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
  ): Router {
    registerGet(this.routes, this.mergeHandlers, path, handler, ...handlers);
    return this;
  }

  /**
   * Register a handler to run on incoming POST requests.
   * @param path The path to run the handler on
   * @param handler The handler(s) to run
   * @returns The router
   */
  post(
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
  ): Router {
    registerPost(this.routes, this.mergeHandlers, path, handler, ...handlers);
    return this;
  }

  /**
   * Register a PUT route.
   * @param path The path to match.
   * @param handler The handler for the route.
   * @param handlers Additional handlers to run before the main handler.
   * @returns The Router instance.
   */
  put(
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
  ): Router {
    registerPut(this.routes, this.mergeHandlers, path, handler, ...handlers);
    return this;
  }

  /**
   * Register a middleware function to handle DELETE requests to `path`.
   * @param path The path to register the handler for.
   * @param handler The middleware function to call.
   * @param handlers Additional middleware functions to call.
   * @returns this
   */
  delete(
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
  ): Router {
    registerDelete(this.routes, this.mergeHandlers, path, handler, ...handlers);
    return this;
  }

  /**
   * Register a middleware function to handle PATCH requests to `path`.
   * @param path The path to register the handler for.
   * @param handler The middleware function to call.
   * @param handlers Additional middleware functions to call.
   * @returns this
   */
  patch(
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
  ): Router {
    registerPatch(this.routes, this.mergeHandlers, path, handler, ...handlers);
    return this;
  }

  /**
   * Add a route for the HTTP TRACE method.
   * The TRACE method is used to invoke a remote, application-layer loop-back
   * of the request message.
   * @param path The path this route will match.
   * @param handler The handler to invoke when this route is matched.
   * @param handlers Additional handlers to run when this route is matched.
   * @returns This router, for chaining.
   */
  trace(
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
  ): Router {
    registerTrace(this.routes, this.mergeHandlers, path, handler, ...handlers);
    return this;
  }

  /**
   * Registers a route for the `HEAD` HTTP method.
   * @param path The route path.
   * @param handler The handler function for the route.
   * @param handlers Additional middleware functions to apply to the route.
   * @returns The router instance.
   */
  head(
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
  ): Router {
    registerHead(this.routes, this.mergeHandlers, path, handler, ...handlers);
    return this;
  }

  /**
   * Register a handler to run for CONNECT requests on the given path.
   * @param path The path to run the handler on
   * @param handler The handler to run
   */
  connect(
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
  ): Router {
    registerConnect(
      this.routes,
      this.mergeHandlers,
      path,
      handler,
      ...handlers,
    );
    return this;
  }

  /**
   * Register a handler to run on OPTIONS requests.
   * @param path The path to run the handler on (undefined = all)
   * @param handler The handler(s) to run
   * @returns The router
   */
  options(
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
  ): Router {
    registerOptions(
      this.routes,
      this.mergeHandlers,
      path,
      handler,
      ...handlers,
    );
    return this;
  }

  /**
   * Upgrade a request to a websocket connection.
   * @param path The path to use for the websocket connection.
   * @returns The router, for chaining.
   */
  ws(path: string): Router {
    registerWs(this.routes, path);
    return this;
  }

  /**
   * Set the WebSocket handlers for napi-router serve.
   * @param handlers The WebSocket handlers.
   * @returns The router, for chaining.
   */
  setWebSocketHandlers(handlers: WebSocketHandlers): Router {
    this.wsHandlers = handlers;
    return this;
  }

  /**
   * Register a global error handler for unhandled errors in route handlers.
   * @param handler The error handler function
   * @returns The router, for chaining
   */
  onError(handler: ErrorHandler): Router {
    this.errorHandler = handler;
    return this;
  }

  /**
   * Get the WebSocket handlers for napi-router serve.
   * @returns The WebSocket handlers, or undefined if not set.
   */
  getWebSocketHandlers(): WebSocketHandlers | undefined {
    return this.wsHandlers;
  }

  redirect(
    method: "*" | HttpMethodString,
    path: string,
    redirectTarget: string,
    perma: boolean = false,
  ): Router {
    registerRedirect(this.routes, method, path, redirectTarget, perma);
    return this;
  }

  static(
    path: string,
    targetDir: string,
    indexFile: string = "index.html",
    deepestLevel: number = 10,
  ): Router {
    registerStatic(this.routes, path, targetDir, indexFile, deepestLevel);
    return this;
  }

  cookies(
    method: "*" | HttpMethodString,
    path: string,
    autoResponseHeaders: boolean = false,
  ): Router {
    registerCookies(this.routes, method, path, autoResponseHeaders);
    return this;
  }

  cors(
    method: "*" | HttpMethodString,
    path: string,
    options?: CorsOptions,
  ): Router {
    registerCors(this.routes, method, path, options);
    return this;
  }

  body(
    method: "*" | HttpMethodString,
    path: string,
    options?: BodyParserOptions,
  ): Router {
    registerBodyParser(this.routes, method, path, options);
    return this;
  }

  rateLimit(
    method: "*" | HttpMethodString,
    path: string,
    options: RateLimitOptions,
  ): Router {
    registerRateLimit(this.routes, method, path, options);
    return this;
  }

  requestId(
    method: "*" | HttpMethodString,
    path: string,
    options?: RequestIdOptions,
  ): Router {
    registerRequestId(this.routes, method, path, options);
    return this;
  }

  timeout(
    method: "*" | HttpMethodString,
    path: string,
    options: TimeoutOptions,
  ): Router {
    registerTimeout(this.routes, method, path, options);
    return this;
  }

  fileUpload(
    method: "*" | HttpMethodString,
    path: string,
    options?: FileUploadOptions,
  ): Router {
    registerFileUpload(this.routes, method, path, options);
    return this;
  }

  /**
   * Set a Rust Validator instance for request validation.
   * Required before using `router.validate()`.
   * @param validator A Validator instance from napi-router
   * @returns The router, for chaining
   */
  setValidator(validator: Validator): Router {
    this._validator = validator;
    return this;
  }

  /**
   * Create a validation middleware for the given schema.
   * The method and path are auto-detected from the request at runtime.
   *
   * Requires a Validator to be set via `router.setValidator()` first.
   *
   * @param schema The schema definition for body/query/params
   * @returns A RequestMiddleware that validates the request
   *
   * @example
   * ```ts
   * import { Validator } from "napi-router"
   * import { s } from "napi-router/adapter/router/router/validator"
   *
   * const validator = new Validator()
   * router.setValidator(validator)
   *
   * router.post("/users",
   *   router.validate({
   *     body: {
   *       name: s.string({ required: true, min: 2, max: 100 }),
   *       email: s.string({ required: true, pattern: "email" }),
   *     },
   *     query: {
   *       format: s.string({ enum: ["short", "full"] }),
   *     },
   *   }),
   *   async (ctx) => {
   *     const user = ctx.req.parsedBody
   *     return ctx.json({ created: true, user })
   *   }
   * )
   * ```
   */
  validate(schema: RouteSchemaDefinition): RequestMiddleware {
    if (!this._validator) {
      throw new Error(
        "Router.validate() requires a Validator. Call router.setValidator(validator) first.",
      );
    }
    return createValidateMiddleware(schema, this._validator);
  }

  /**
   * Get the Rust Validator instance associated with this router.
   * @returns The Validator, or undefined if not set
   */
  getValidator(): Validator | undefined {
    return this._validator;
  }

  /**
   * Register all validation schemas with the server for auto-validate mode.
   * When auto-validate is enabled, the server validates requests in Rust
   * before calling JS — zero NAPI overhead.
   *
   * Call this after all routes are registered.
   *
   * @param server The server instance
   *
   * @example
   * ```ts
   * const validator = new Validator()
   * const router = new Router()
   * router.setValidator(validator)
   *
   * router.post("/users",
   *   router.validate({ body: { name: s.string({ required: true }) } }),
   *   handler
   * )
   *
   * const server = await serve({ port: 3000, fetch: router.handle })
   * router.enableAutoValidate(server)  // Register schemas + enable auto-validate
   * ```
   */
  enableAutoValidate(server: import("../serve").Server): Router {
    if (!this._validator) {
      throw new Error(
        "Router.enableAutoValidate() requires a Validator. Call router.setValidator(validator) first.",
      );
    }
    server.setValidator(this._validator);
    server.setAutoValidate(true);
    return this;
  }

  /**
   * Get a single uploaded file from the request.
   * @param req The request object
   * @param fieldName The form field name
   * @returns The first uploaded file, or undefined
   */
  static getFile = getFile;

  /**
   * Get all uploaded files for a field name from the request.
   * @param req The request object
   * @param fieldName The form field name
   * @returns Array of uploaded files, or empty array
   */
  static getFiles = getFiles;

  /**
   * Get all uploaded field names from the request.
   * @param req The request object
   * @returns Array of field names that have files
   */
  static getFileFieldNames = getFileFieldNames;

  /**
   * Get all parsed form fields (non-file) from the request.
   * @param req The request object
   * @returns Record of field names to values
   */
  static getFormFields = getFormFields;

  /**
   * Create a route group with a common prefix path.
   * All routes registered via the callback will be prefixed with the given path.
   * @param prefix The prefix path for all routes in the group
   * @param callback A function that receives the router to register routes on
   * @returns The router, for chaining
   */
  group(prefix: string, callback: (router: Router) => void): Router {
    const subRouter = new Router();
    callback(subRouter);

    for (const route of subRouter.routes) {
      const mergedSplitPath = this.mergeSplitPaths(
        splitRoutePath(prefix),
        route.splitPath,
      );
      this.routes.push({
        ...route,
        splitPath: mergedSplitPath,
      });
    }

    return this;
  }

  /**
   * Mount a sub-router at the given path prefix.
   * All routes from the sub-router will be registered with the prefix prepended.
   * @param prefix The prefix path to mount the sub-router at
   * @param subRouter The sub-router to mount
   * @returns The router, for chaining
   */
  mount(prefix: string, subRouter: Router): Router {
    for (const route of subRouter.routes) {
      const mergedSplitPath = this.mergeSplitPaths(
        splitRoutePath(prefix),
        route.splitPath,
      );
      this.routes.push({
        ...route,
        splitPath: mergedSplitPath,
      });
    }
    return this;
  }

  private mergeSplitPaths(
    prefix: ReturnType<typeof splitRoutePath>,
    suffix: ReturnType<typeof splitRoutePath>,
  ): ReturnType<typeof splitRoutePath> {
    if (!prefix && !suffix) {
      return undefined;
    }
    if (!prefix) {
      return suffix;
    }
    if (!suffix) {
      return prefix;
    }
    return [...prefix, ...suffix] as ReturnType<typeof splitRoutePath>;
  }
}
