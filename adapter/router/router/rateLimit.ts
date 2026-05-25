import { splitRoutePath } from "../path"
import { parseHttpMethods, HttpMethodString } from "../method"
import { HTTP_STATUS } from "../responseBuilder"
import type { EndpointRoute, Request, RequestMiddleware } from "../types"

export interface RateLimitOptions {
    max: number
    windowMs: number
    keyGenerator?: (req: Request) => string
    message?: string
    headers?: boolean
}

interface RateLimitEntry {
    count: number
    resetAt: number
}

/**
 * Register a rate limiting middleware.
 * Limits the number of requests from a client within a time window.
 * @param routes The routes array to add to
 * @param method The HTTP method(s) to match
 * @param path The path to rate limit
 * @param options Rate limit configuration
 * @returns The updated routes array.
 */
export function rateLimit(
    routes: EndpointRoute[],
    method: "*" | HttpMethodString,
    path: string,
    options: RateLimitOptions,
): EndpointRoute[] {
    const {
        max,
        windowMs,
        keyGenerator = (req: Request) => {
            const forwarded = req.headers.get("x-forwarded-for")
            if (forwarded) {
                return forwarded.split(",")[0].trim()
            }
            return req.headers.get("x-real-ip") || "unknown"
        },
        message = "Too many requests",
        headers = true,
    } = options

    const store = new Map<string, RateLimitEntry>()

    const cleanup = () => {
        const now = Date.now()
        for (const [key, entry] of store) {
            if (now > entry.resetAt) {
                store.delete(key)
            }
        }
    }

    let lastCleanup = Date.now()
    const cleanupInterval = Math.max(windowMs, 60000)

    const rateLimitMiddleware: RequestMiddleware = (ctx) => {
        const req = ctx.req
        const res = ctx.res
        const now = Date.now()

        if (now - lastCleanup > cleanupInterval) {
            cleanup()
            lastCleanup = now
        }

        const key = keyGenerator(req)
        let entry = store.get(key)

        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs }
            store.set(key, entry)
        }

        entry.count++

        if (headers) {
            res.setHeader("X-RateLimit-Limit", String(max))
            res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)))
            res.setHeader("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)))
        }

        if (entry.count > max) {
            if (headers) {
                res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)))
            }
            res.status(HTTP_STATUS.TOO_MANY_REQUESTS).send(message)
        }
    }

    routes.push({
        splitPath: splitRoutePath(path),
        method: parseHttpMethods(method),
        handler: rateLimitMiddleware,
        middlewareName: "rateLimit",
    })

    return routes
}
