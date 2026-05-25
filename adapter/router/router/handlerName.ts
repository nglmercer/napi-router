import type { RequestMiddleware } from "../types"

/**
 * Names an otherwise anonymous handler function so `getRouteDefinitions()`
 * and `dump()` show a meaningful name instead of `[anonym]`.
 *
 * @example
 * ```ts
 * router.get("/users/:id", handlerName("getUser", ({ req, res }) => {
 *   res.send("ok")
 * }))
 * // getRouteDefinitions() → handlerName: "getUser"
 * ```
 */
export function handlerName(name: string, handler: RequestMiddleware): RequestMiddleware {
  ;(handler as unknown as Record<string, unknown>).middlewareName = name
  return handler
}
