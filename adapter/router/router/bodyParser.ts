import { splitRoutePath } from "../path"
import { parseHttpMethods, HttpMethodString } from "../method"
import type { EndpointRoute, Request, RequestMiddleware } from "../types"

export interface BodyParserOptions {
    json?: boolean
    text?: boolean
    form?: boolean
    limit?: number
}

async function parseJsonBody(req: Request, limit?: number): Promise<unknown> {
    const clone = req.clone()
    const text = limit ? (await clone.text()).slice(0, limit) : await clone.text()
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}

async function parseTextBody(req: Request, limit?: number): Promise<string> {
    const clone = req.clone()
    return limit ? (await clone.text()).slice(0, limit) : await clone.text()
}

async function parseFormBody(req: Request, limit?: number): Promise<Record<string, string>> {
    const clone = req.clone()
    const text = limit ? (await clone.text()).slice(0, limit) : await clone.text()
    const params = new URLSearchParams(text)
    const result: Record<string, string> = {}
    for (const [key, value] of params) {
        result[key] = value
    }
    return result
}

/**
 * Register a body parsing middleware.
 * Parses the request body based on content-type and populates `req.parsedBody`.
 * @param routes The routes array to add to
 * @param method The HTTP method(s) to match
 * @param path The path to parse body on
 * @param options Body parser configuration
 * @returns The updated routes array.
 */
export function bodyParser(
    routes: EndpointRoute[],
    method: "*" | HttpMethodString,
    path: string,
    options: BodyParserOptions = {},
): EndpointRoute[] {
    const { json = true, text = true, form = true, limit } = options

    const bodyParserMiddleware: RequestMiddleware = async (ctx) => {
        const req = ctx.req
        const contentType = req.headers.get("content-type") || ""

        try {
            if (json && contentType.includes("application/json")) {
                req.parsedBody = await parseJsonBody(req, limit)
            } else if (form && contentType.includes("application/x-www-form-urlencoded")) {
                req.parsedBody = await parseFormBody(req, limit)
            } else if (text) {
                req.parsedBody = await parseTextBody(req, limit)
            }
        } catch {
            // Body parsing failed, leave parsedBody as undefined
        }
    }

    routes.push({
        splitPath: splitRoutePath(path),
        method: parseHttpMethods(method),
        handler: bodyParserMiddleware,
        middlewareName: "bodyParser",
    })

    return routes
}
