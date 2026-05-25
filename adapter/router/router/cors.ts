import { splitRoutePath } from "../path"
import { parseHttpMethods, HttpMethodString } from "../method"
import { HTTP_STATUS } from "../responseBuilder"
import type { EndpointRoute, RequestMiddleware } from "../types"

export interface CorsOptions {
    origin?: string | string[] | ((origin: string) => string | undefined)
    methods?: string[]
    allowedHeaders?: string[]
    exposedHeaders?: string[]
    credentials?: boolean
    maxAge?: number
    preflightContinue?: boolean
}

function getAllowOrigin(origin: string | null, options: CorsOptions): string | undefined {
    if (!origin) {
        return undefined
    }
    const allowed = options.origin
    if (allowed === undefined || allowed === "*") {
        return "*"
    }
    if (typeof allowed === "string") {
        return origin === allowed ? origin : undefined
    }
    if (Array.isArray(allowed)) {
        return allowed.includes(origin) ? origin : undefined
    }
    return allowed(origin)
}

/**
 * Register a CORS middleware.
 * @param routes The routes array to add to
 * @param method The HTTP method(s) to match
 * @param path The path to apply CORS to
 * @param options CORS configuration options
 * @returns The updated routes array.
 */
export function cors(
    routes: EndpointRoute[],
    method: "*" | HttpMethodString,
    path: string,
    options: CorsOptions = {},
): EndpointRoute[] {
    const {
        methods = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
        allowedHeaders,
        exposedHeaders,
        credentials = false,
        maxAge = 86400,
        preflightContinue = false,
    } = options

    const corsMiddleware: RequestMiddleware = (ctx) => {
        const req = ctx.req
        const res = ctx.res
        const reqOrigin = req.headers.get("origin")
        const allowOrigin = getAllowOrigin(reqOrigin, options)

        if (allowOrigin) {
            res.setHeader("Access-Control-Allow-Origin", allowOrigin)
        }

        if (credentials) {
            res.setHeader("Access-Control-Allow-Credentials", "true")
        }

        if (exposedHeaders && exposedHeaders.length > 0) {
            res.setHeader("Access-Control-Expose-Headers", exposedHeaders.join(", "))
        }

        // Handle preflight OPTIONS request
        if (req.httpMethod === parseHttpMethods("OPTIONS")) {
            res.setHeader(
                "Access-Control-Allow-Methods",
                methods.join(", ")
            )

            const reqAllowedHeaders = req.headers.get("access-control-request-headers")
            if (allowedHeaders && allowedHeaders.length > 0) {
                res.setHeader("Access-Control-Allow-Headers", allowedHeaders.join(", "))
            } else if (reqAllowedHeaders) {
                res.setHeader("Access-Control-Allow-Headers", reqAllowedHeaders)
            }

            if (maxAge) {
                res.setHeader("Access-Control-Max-Age", String(maxAge))
            }

            if (!preflightContinue) {
                res.status(HTTP_STATUS.NO_CONTENT).send()
                return
            }
        }
    }

    routes.push({
        splitPath: splitRoutePath(path),
        method: parseHttpMethods(method),
        handler: corsMiddleware,
        middlewareName: "cors",
    })

    return routes
}
