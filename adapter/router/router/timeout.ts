import { splitRoutePath } from "../path"
import { parseHttpMethods, HttpMethodString } from "../method"
import { HTTP_STATUS } from "../responseBuilder"
import type { EndpointRoute, RequestMiddleware } from "../types"

export interface TimeoutOptions {
    timeoutMs: number
    message?: string
}

/**
 * Register a timeout middleware.
 * Aborts the request and sends a 408 response if the handler doesn't complete within the specified time.
 * @param routes The routes array to add to
 * @param method The HTTP method(s) to match
 * @param path The path to apply timeout to
 * @param options Timeout configuration
 * @returns The updated routes array.
 */
export function timeout(
    routes: EndpointRoute[],
    method: "*" | HttpMethodString,
    path: string,
    options: TimeoutOptions,
): EndpointRoute[] {
    const {
        timeoutMs,
        message = "Request timeout",
    } = options

    const timeoutMiddleware: RequestMiddleware = (ctx) => {
        const res = ctx.res
        const timer = setTimeout(() => {
            if (!res.submit) {
                res.status(HTTP_STATUS.REQUEST_TIMEOUT).send(message)
            }
        }, timeoutMs)

        res.beforeSent(() => {
            clearTimeout(timer)
        })
    }

    routes.push({
        splitPath: splitRoutePath(path),
        method: parseHttpMethods(method),
        handler: timeoutMiddleware,
        middlewareName: "timeout",
    })

    return routes
}
