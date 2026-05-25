import { splitPath } from "./path"
import { parseHttpMethods, HttpMethod } from "./method"
import type { Server, SocketAddress } from "../serve"
import type { SplitPath } from "./path"
import type { NRequest, PathParams } from "./types"
import { Param } from "./router/param"

export class EnhancedRequest extends Request implements NRequest {
    httpMethod: HttpMethod
    path: string
    splitPath: SplitPath
    server!: Server
    sock!: SocketAddress
    cookies: Record<string, string | undefined> = {}
    originCookies: unknown
    upgraded?: true
    id?: string
    pathParams?: PathParams
    parsedBody?: unknown
    queryParams: Record<string, string> = {}
    ip: string = "127.0.0.1"
    ips: string[] = ["127.0.0.1"]

    constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init)
        const url = new URL(this.url)
        this.path = url.pathname
        this.httpMethod = parseHttpMethods(this.method)
        this.splitPath = splitPath(this.path)
    }

    pathParam(key: string): Param
    pathParam(): Record<string, Param>
    pathParam(key?: string): Param | Record<string, Param> {
        const params = !this.pathParams
            ? {}
            : Array.isArray(this.pathParams)
                ? Object.fromEntries(
                      this.pathParams.map((v, i) => [String(i), v]),
                  )
                : this.pathParams
        if (key) return new Param(params[key])
        const result: Record<string, Param> = {}
        for (const k of Object.keys(params)) {
            result[k] = new Param(params[k])
        }
        return result
    }

    query(
        key?: string,
    ): string | string[] | Record<string, string> | undefined {
        if (key === undefined) return { ...this.queryParams }
        return this.queryParams[key]
    }

    queries(key: string): string[] {
        const v = this.queryParams[key]
        return v !== undefined ? [v] : []
    }

    queryParam(key: string): Param
    queryParam(): Record<string, Param>
    queryParam(key?: string): Param | Record<string, Param> {
        if (key) return new Param(this.queryParams[key])
        const result: Record<string, Param> = {}
        for (const k of Object.keys(this.queryParams)) {
            result[k] = new Param(this.queryParams[k])
        }
        return result
    }
}
