import type { EndpointRoute } from "../types"
import type { Server } from "../../serve"
import { stringifyHttpMethods } from "../method"
import { isMergedRequestMiddleware, unmergeRequestMiddleware } from "../middleware"
import { PATH_CHARS, ROUTE_TOKENS, isNamedParam, getNamedParamName } from "../path"
import type { RequestMiddleware } from "../types"

export interface RouteStats {
    requestCount: number
    totalTimeMs: number
    avgTimeMs: number
}

const routeStats = new Map<string, RouteStats>()

export function trackRouteTime(
    method: string,
    path: string,
    timeMs: number,
): void {
    const key = `${method}:${path}`
    let stats = routeStats.get(key)
    if (!stats) {
        stats = { requestCount: 0, totalTimeMs: 0, avgTimeMs: 0 }
        routeStats.set(key, stats)
    }
    stats.requestCount++
    stats.totalTimeMs += timeMs
    stats.avgTimeMs = stats.totalTimeMs / stats.requestCount
}

export function getRouteStats(): Map<string, RouteStats> {
    return routeStats
}

export function clearRouteStats(): void {
    routeStats.clear()
}

export type RouteParamType = "named" | "wildcard" | "double-wildcard"

export interface RouteParamInfo {
    name: string
    type: RouteParamType
    position: number
}

export interface MiddlewareInfo {
    name: string
    mergedToTop: boolean
}

export interface QueryParamInfo {
    name: string
    type: "string" | "number" | "integer" | "boolean" | "array"
    required: boolean
    description?: string
    default?: unknown
    enum?: string[]
}

export interface RouteDefinition {
    method: string
    path: string
    splitPath: string[]
    pathParams: RouteParamInfo[]
    handlerName: string
    middlewareName?: string
    middlewareChain: MiddlewareInfo[]
    isMerged: boolean
    stats?: RouteStats
    queryParams?: QueryParamInfo[]
}

/**
 * Extracts path parameter info from a split path array.
 * Parses `:named`, `*` (wildcard), and `**` (double-wildcard) segments.
 * Named params at their original positions; wildcards get auto-named `_0`, `_1`, etc.
 */
export function extractPathParams(splitPath: string[] | undefined): RouteParamInfo[] {
    if (!splitPath) return []
    const params: RouteParamInfo[] = []
    let wildcardIndex = 0
    for (let i = 0; i < splitPath.length; i++) {
        const segment = splitPath[i]
        if (isNamedParam(segment)) {
            params.push({ name: getNamedParamName(segment), type: "named", position: i })
        } else if (segment === ROUTE_TOKENS.WILDCARD) {
            params.push({ name: `_${wildcardIndex++}`, type: "wildcard", position: i })
        } else if (segment === ROUTE_TOKENS.DOUBLE_WILDCARD) {
            params.push({ name: "wild", type: "double-wildcard", position: i })
        }
    }
    return params
}

/**
 * Resolves a handler function name from a RequestMiddleware.
 */
export function resolveHandlerName(handler: RequestMiddleware): string {
    if (isMergedRequestMiddleware(handler)) {
        return "[merged]"
    }
    if (handler && typeof handler.name === "string" && handler.name.length > 0) {
        if (handler.name !== "handler") return handler.name
    }
    if (handler && handler.prototype && typeof handler.prototype.name === "string" && handler.prototype.name.length > 0) {
        return handler.prototype.name
    }
    const middlewareName = (handler as unknown as Record<string, unknown>).middlewareName
    if (typeof middlewareName === "string" && middlewareName.length > 0) {
        return middlewareName
    }
    return "[anonym]"
}

/**
 * Returns structured route definitions suitable for Swagger/OpenAPI generation,
 * API documentation, or dynamic endpoint listings.
 *
 * Each definition includes the method, path pattern, extracted path parameters,
 * middleware chain information, and optional performance stats.
 *
 * @param routes The endpoint routes to extract definitions from
 * @returns An array of structured route definitions
 *
 * @example
 * ```ts
 * const defs = getRouteDefinitions(router.routes)
 * for (const def of defs) {
 *   // Build Swagger path item from def.method, def.path, def.pathParams
 * }
 * ```
 */
export function getRouteDefinitions(
    routes: EndpointRoute[],
    routeMeta?: Map<string, { queryParams?: QueryParamInfo[] }>,
): RouteDefinition[] {
    const seen = new Set<string>()
    const definitions: RouteDefinition[] = []

    for (const route of routes) {
        const method = stringifyHttpMethods(route.method)
        const splitPath = route.splitPath ?? []
        const path = splitPath.length > 0 ? "/" + splitPath.join("/") : "/"
        const key = `${method}:${path}`

        if (seen.has(key)) continue
        seen.add(key)

        const pathParams = extractPathParams(splitPath)
        const middlewares = unmergeRequestMiddleware(route.handler)
        const handlerName = resolveHandlerName(route.handler)
        const isMerged = isMergedRequestMiddleware(route.handler)

        const middlewareChain: MiddlewareInfo[] = middlewares.map((m, i) => ({
            name: resolveHandlerName(m),
            mergedToTop: isMerged && i !== middlewares.length - 1,
        }))

        const statsKey = `${method}:${path}`
        const stats = routeStats.get(statsKey)

        const meta = routeMeta?.get(path)

        const def: RouteDefinition & { toJSON?(): Record<string, unknown> } = {
            method,
            path,
            splitPath,
            pathParams,
            handlerName,
            middlewareName: route.middlewareName,
            middlewareChain,
            isMerged,
            stats: stats ? { ...stats } : undefined,
            queryParams: meta?.queryParams,
        }

        def.toJSON = function (this: RouteDefinition) {
            const base: Record<string, unknown> = {
                method: this.method,
                path: this.path,
                splitPath: this.splitPath,
                pathParams: this.pathParams.map(p => ({ name: p.name, type: p.type, position: p.position })),
                handlerName: this.handlerName,
                middlewareName: this.middlewareName,
                middlewareChain: this.middlewareChain.map(m => ({ name: m.name, mergedToTop: m.mergedToTop })),
                isMerged: this.isMerged,
                stats: this.stats ? { ...this.stats } : undefined,
            }
            if (this.queryParams) {
                base.queryParams = this.queryParams
            }
            return base
        }

        definitions.push(def)
    }

    return definitions
}

/**
 * Creates a string tuple that contains the method, path and name of the middleware
 * @param route The route to generate the string for
 * @param handler The handler of the route
 * @param mergedToTop Whether the handler is merged to the top
 * @returns A string with 3 parts: method, path and name
 */
export function getDefinitionString(
    route: EndpointRoute,
    handler: RequestMiddleware,
    mergedToTop: boolean,
): [string, string, string] {
    let parts: [string, string, string] = [PATH_CHARS.SLASH, "X", PATH_CHARS.SLASH]

    if (mergedToTop) {
        parts[0] = "^ (M)"
    } else {
        parts[0] = stringifyHttpMethods(route.method)
    }

    if (route.splitPath) {
        parts[1] = PATH_CHARS.SLASH + route.splitPath.join(PATH_CHARS.SLASH)
    } else {
        parts[1] = PATH_CHARS.SLASH
    }

    parts[2] = resolveHandlerName(handler)

    return parts
}

/**
 * Prints a table of all endpoints defined in the router.
 * 
 * If a server is given as a parameter, a running message with the url of the server is printed too.
 * @param routes The routes to dump
 * @param servers The server to print the url of
 * @returns A string representing the table of endpoints
 */
export function dump(
    routes: EndpointRoute[],
    ...servers: Server[]
): string {
    if (routes.length == 0) {
        throw new Error("No endpoint routes defined")
    }

    let unmergedParts: [string, string, string][] = []
    let mergedParts: [string, string, string][] = []
    for (const route of routes) {
        mergedParts.push(
            getDefinitionString(
                route,
                route.handler,
                false
            )
        )

        unmergedParts.push(
            ...unmergeRequestMiddleware(route.handler)
                .map(
                    (middleware, index) => getDefinitionString(
                        route,
                        middleware,
                        index != 0,
                    )
                )
        )
    }

    const both = [
        ...unmergedParts,
        ...mergedParts
    ]
    const part1MinLen = both.sort(
        (a, b) => b[0].length - a[0].length
    )[0][0].length
    const part2MinLen = both.sort(
        (a, b) => b[1].length - a[1].length
    )[0][1].length
    const part3MinLen = both.sort(
        (a, b) => b[2].length - a[2].length
    )[0][2].length

    const hasStats = routeStats.size > 0
    let part4MinLen = 0
    if (hasStats) {
        for (const [, stats] of routeStats) {
            const timeStr = stats.avgTimeMs.toFixed(2) + "ms"
            if (timeStr.length > part4MinLen) {
                part4MinLen = timeStr.length
            }
        }
        part4MinLen = Math.max(part4MinLen, "Avg Time".length)
    }

    const lines: string[] = []

    if (servers && servers.length != 0) {
        if (servers.length == 1) {
            lines.push("Server is listening on " + servers[0].url)
        } else {
            lines.push("Server is listening on:")
            lines.push(
                ...servers.map(
                    (server) => "- " + server.url
                )
            )
        }
    }

    const header = hasStats
        ? `| ${"Method".padEnd(part1MinLen)} | ${"Path".padEnd(part2MinLen)} | ${"Handler".padEnd(part3MinLen)} | ${"Requests".padEnd(8)} | ${"Avg Time".padEnd(part4MinLen)} |`
        : `| ${"Method".padEnd(part1MinLen)} | ${"Path".padEnd(part2MinLen)} | ${"Handler".padEnd(part3MinLen)} |`
    const separator = hasStats
        ? `| ${"-".repeat(part1MinLen)} | ${"-".repeat(part2MinLen)} | ${"-".repeat(part3MinLen)} | ${"-".repeat(8)} | ${"-".repeat(part4MinLen)} |`
        : `| ${"-".repeat(part1MinLen)} | ${"-".repeat(part2MinLen)} | ${"-".repeat(part3MinLen)} |`

    lines.push(
        "",
        "# Defined endpoints:",
        header,
        separator,
        ...unmergedParts.map(
            ([part1, part2, part3]): string => {
                if (hasStats) {
                    const statsKey = `${part1}:${part2}`
                    const stats = routeStats.get(statsKey)
                    const reqCount = stats ? String(stats.requestCount).padEnd(8) : "0".padEnd(8)
                    const avgTime = stats ? (stats.avgTimeMs.toFixed(2) + "ms").padEnd(part4MinLen) : "N/A".padEnd(part4MinLen)
                    return `| ${part1.padEnd(part1MinLen)} | ${part2.padEnd(part2MinLen)} | ${part3.padEnd(part3MinLen)} | ${reqCount} | ${avgTime} |`
                }
                return `| ${part1.padEnd(part1MinLen)} | ${part2.padEnd(part2MinLen)} | ${part3.padEnd(part3MinLen)} |`
            }
        ),
        "",
    )

    if (unmergedParts.length != mergedParts.length) {
        lines.push(
            "# Merged endpoints:",
            header,
            separator,
            ...mergedParts.map(
                ([part1, part2, part3]): string => {
                    if (hasStats) {
                        const statsKey = `${part1}:${part2}`
                        const stats = routeStats.get(statsKey)
                        const reqCount = stats ? String(stats.requestCount).padEnd(8) : "0".padEnd(8)
                        const avgTime = stats ? (stats.avgTimeMs.toFixed(2) + "ms").padEnd(part4MinLen) : "N/A".padEnd(part4MinLen)
                        return `| ${part1.padEnd(part1MinLen)} | ${part2.padEnd(part2MinLen)} | ${part3.padEnd(part3MinLen)} | ${reqCount} | ${avgTime} |`
                    }
                    return `| ${part1.padEnd(part1MinLen)} | ${part2.padEnd(part2MinLen)} | ${part3.padEnd(part3MinLen)} |`
                }
            ),
            "",
        )
    }

    return lines.join("\n")
}
