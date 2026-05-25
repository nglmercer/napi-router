import { splitRoutePath } from "../path"
import { parseHttpMethods, HttpMethodString } from "../method"
import type { EndpointRoute, RequestMiddleware } from "../types"

export interface RequestIdOptions {
    header?: string
    generator?: (req: { headers: Headers }) => string
}

/**
 * Register a request ID middleware.
 * Sets `req.id` and adds an X-Request-Id header to the response.
 * @param routes The routes array to add to
 * @param method The HTTP method(s) to match
 * @param path The path to add request ID to
 * @param options Request ID configuration
 * @returns The updated routes array.
 */
export function requestId(
    routes: EndpointRoute[],
    method: "*" | HttpMethodString,
    path: string,
    options: RequestIdOptions = {},
): EndpointRoute[] {
    const {
        header = "X-Request-Id",
        generator = () => crypto.randomUUID(),
    } = options

    const requestIdMiddleware: RequestMiddleware = (ctx) => {
        const req = ctx.req
        const res = ctx.res
        const existingId = req.headers.get(header.toLowerCase())
        const id = existingId || generator(req)
        req.id = id
        res.setHeader(header, id)
    }

    routes.push({
        splitPath: splitRoutePath(path),
        method: parseHttpMethods(method),
        handler: requestIdMiddleware,
        middlewareName: "requestId",
    })

    return routes
}
