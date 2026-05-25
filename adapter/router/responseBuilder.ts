import type { Awaitable, CookieOptions } from "./types"

export const HTTP_STATUS = {
    OK: 200,
    NO_CONTENT: 204,
    TEMPORARY_REDIRECT: 307,
    PERMANENT_REDIRECT: 308,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    REQUEST_TIMEOUT: 408,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
} as const

export const HTTP_HEADERS = {
    CONTENT_TYPE: "content-type",
    LOCATION: "location",
    WWW_AUTHENTICATE: "WWW-Authenticate",
    SET_COOKIE: "Set-Cookie",
    AUTHORIZATION: "authorization",
    COOKIE: "cookie",
} as const

export const RESPONSE_DEFAULTS = {
    REALM: "User Visible Realm",
    CHARSET: "UTF-8",
} as const

export const notFoundResponse = new Response(
    "Not Found",
    {
        status: HTTP_STATUS.NOT_FOUND,
        statusText: "Not Found",
    }
)

export class ResponseBuilder {
    submit: boolean = false
    statusCode: number = HTTP_STATUS.OK
    statusText?: string
    bodyInit: BodyInit | null = null
    headers: [string, string][] = []

    beforeSentHooks: ((res: ResponseBuilder) => Awaitable<void>)[] | undefined

    /**
     * Adds a hook that will be called before the response is build for sending
     * @param hook The hook to add
     * @returns The ResponseBuilder instance
     */
    beforeSent(
        hook: (res: ResponseBuilder) => Awaitable<void>
    ): ResponseBuilder {
        if (!this.beforeSentHooks) {
            this.beforeSentHooks = []
        }
        this.beforeSentHooks.push(hook)
        return this
    }

    /**
     * Starts the before sent hooks in order and waits for them all to finish
     * @param p The promise to wait for before starting the hooks
     */
    private async startBeforeSentHookAsync(p: Promise<void>) {
        await p

        let hook = this.beforeSentHooks?.pop()
        while (hook != undefined) {
            const p = hook(this)
            if (
                p &&
                p.then != undefined
            ) {
                await p
            }
            hook = this.beforeSentHooks?.pop()
        }
    }

    /**
     * Sends a file to the client.
     * @param file The file data as ArrayBuffer
     * @param mimeType The MIME type of the file
     * @param code The status code to use for the response
     * @returns void because it is submitted to the client
     */
    sendFile(file: ArrayBuffer, mimeType?: string, code?: number): void {
        this.reset()
        this.bodyInit = file
        if (mimeType) this.setHeader(HTTP_HEADERS.CONTENT_TYPE, mimeType)
        if (code) this.statusCode = code
        this.submit = true
    }
    /**
     * Sends a file to the client.
     * alias sendFile
     */
    file(file: ArrayBuffer, mimeType?: string, code?: number): void {
        this.sendFile(file, mimeType, code)
    }
    /**
     * Sends a response with no content.
     * @returns void because it is submitted to the client
     */
    sendNoContent(): void {
        this.reset()
        this.statusCode = HTTP_STATUS.NO_CONTENT
        this.submit = true
    }
    /**
     * alias sendNoContent
     */
    noContent(): void {
        this.sendNoContent()
    }
    /**
     * Starts the before sent hooks in order and waits for them all to finish
     * @returns A promise that resolves when all the hooks have finished
     */
    startBeforeSentHook(): Awaitable<void> {
        if (this.beforeSentHooks) {
            let hook = this.beforeSentHooks.pop()
            while (hook != undefined) {
                const p = hook(this)
                if (
                    p &&
                    p.then != undefined
                ) {
                    return this.startBeforeSentHookAsync(p)
                }

                hook = this.beforeSentHooks.pop()
            }
        }
    }

    /**
     * Builds the response object
     * @returns The final response object
     */
    build(): Response {
        return new Response(
            this.bodyInit as BodyInit | null,
            {
                status: this.statusCode,
                statusText: this.statusText,
                headers: this.headers,
            }
        )
    }

    /**
     * Resets the response builder to its default state, clearing all options and properties.
     * @returns The response builder instance
     */
    reset(): ResponseBuilder {
        this.submit = false
        this.statusCode = HTTP_STATUS.OK
        this.statusText = undefined
        this.bodyInit = null
        this.headers = []
        return this
    }

    /**
     * Sets the status code and optional status text of the response.
     * @param statusCode The status code
     * @param statusText The status text, if provided
     * @returns The response builder instance
     */
    status(statusCode: number, statusText?: string): ResponseBuilder {
        this.statusCode = statusCode
        if (statusText) {
            this.statusText = statusText
        }
        return this
    }

    /**
     * Removes the given header from the response.
     * @param name The name of the header to remove
     * @returns The response builder instance
     */
    unsetHeader(name: string): ResponseBuilder {
        this.headers = this.headers.filter(
            (header) =>
                header[0].toLowerCase() !==
                name.toLowerCase()
        )
        return this
    }

    /**
     * Sets a header on the response.
     * @param name The name of the header to set
     * @param value The value of the header
     * @param overwrite Whether to overwrite any existing header with the same name. Default is true.
     * @returns The response builder instance
     */
    setHeader(
        name: string,
        value: string,
        overwrite: boolean = true,
    ): ResponseBuilder {
        if (overwrite) {
            this.unsetHeader(name)
        }

        this.headers.push([name, value])

        return this
    }

    /**
     * Sets a cookie on the response.
     * @param name The name of the cookie
     * @param value The value of the cookie
     * @param options The options for the cookie
     * @returns The response builder instance
     */
    setCookie(
        name: string,
        value: string,
        options: CookieOptions = {},
    ): ResponseBuilder {
        const cookieParts = [`${name}=${encodeURIComponent(value)}`]

        if (options.MaxAge) {
            cookieParts.push(`Max-Age=${options.MaxAge}`)
        }
        if (options.Path) {
            cookieParts.push(`Path=${options.Path}`)
        }
        if (options.HttpOnly) {
            cookieParts.push(`HttpOnly`)
        }
        if (options.Secure) {
            cookieParts.push(`Secure`)
        }
        if (options.SameSite) {
            cookieParts.push(`SameSite=${options.SameSite}`)
        }

        this.setHeader(HTTP_HEADERS.SET_COOKIE, cookieParts.join('; '), false)

        return this
    }

    /**
     * Unsets a cookie on the response.
     * @param name The name of the cookie to unset
     * @returns The response builder instance
     */
    unsetCookie(name: string): ResponseBuilder {
        this.setHeader(HTTP_HEADERS.SET_COOKIE, name + "=; Expires=Thu, 01 Jan 1970 00:00:00 GMT", false)
        return this
    }

    /**
     * Sets the body of the response.
     * @param bodyInit The body of the response
     * @returns The response builder instance
     */
    body(
        bodyInit: BodyInit | null = null,
    ): ResponseBuilder {
        this.bodyInit = bodyInit
        return this
    }

    /**
     * Submits the response to the client, with an optional body.
     * @param bodyInit The body of the response, if any
     */
    send(
        bodyInit: BodyInit | null = null,
    ): void {
        this.bodyInit = bodyInit
        this.submit = true
    }
    /**
     * Sends a JSON response to the client.
     * 
     * @param data - The data to send
     * @param code - The status code to use for the response
     * @returns void because it is submitted to the client
     */
    sendJson(data: unknown, code?: number): void {
        const savedStatusCode = this.statusCode
        this.reset()
        this.statusCode = savedStatusCode
        this.bodyInit = JSON.stringify(data)
        this.setHeader(HTTP_HEADERS.CONTENT_TYPE, 'application/json')
        if (code) {
            this.statusCode = code
        }
        this.submit = true
    }
    /**
     * alias sendJson
     */
    json(data: unknown, code?: number): void {
        this.sendJson(data, code)
    }
    /**
     * sends a text response to the client.
     * @param data The text data to send
     * @param code The status code to use for the response
     * @returns void because it is submitted to the client
     */
    sendText(data: string, code?: number): void {
        this.reset()
        this.bodyInit = data
        this.setHeader(HTTP_HEADERS.CONTENT_TYPE, 'text/plain; charset=UTF-8')
        if (code) this.statusCode = code
        this.submit = true
    }
    /**
     * alias sendText
     */
    text(data: string, code?: number): void {
        this.sendText(data, code)
    }
    /**
     * sends a html response to the client.
     * @param data The html data to send
     * @param code The status code to use for the response
     * @returns void because it is submitted to the client
     */
    sendHtml(data: string, code?: number): void {
        this.reset()
        this.bodyInit = data
        this.setHeader(HTTP_HEADERS.CONTENT_TYPE, 'text/html; charset=UTF-8')
        if (code) this.statusCode = code
        this.submit = true
    }
    /**
     * alias sendHtml
     */
    html(data: string, code?: number): void {
        this.sendHtml(data, code)
    }
    /**
     * Sends an error response to the client.
     * @param message The error message to send
     * @param code The status code to use for the response
     * @returns void because it is submitted to the client
     */
    sendError(message: string, code: number = HTTP_STATUS.INTERNAL_SERVER_ERROR): void {
        this.reset()
        this.bodyInit = JSON.stringify({ error: message, status: code })
        this.setHeader(HTTP_HEADERS.CONTENT_TYPE, 'application/json')
        this.statusCode = code
        this.submit = true
    }
    /**
     * alias sendError
     */
    error(message: string, code: number = HTTP_STATUS.INTERNAL_SERVER_ERROR): void {
        this.sendError(message, code)
    }
    /**
     * Redirects to a given url. If perma is true, this is a 308 redirect, otherwise it is a 307.
     * @param url The url to redirect to
     * @param perma Whether this is a permanent redirect
     * @returns void because it is submitted to the client
     */
    sendRedirect(url: string, perma: boolean = false): void {
        this.reset()
        this.statusCode = perma ? HTTP_STATUS.PERMANENT_REDIRECT : HTTP_STATUS.TEMPORARY_REDIRECT
        this.headers.push([HTTP_HEADERS.LOCATION, url])
        this.submit = true
    }

    /**
     * Redirects to a given url with a custom status code.
     * @param url The url to redirect to
     * @param status The status code to use for the redirect
     * @returns void because it is submitted to the client
     */
    sendRedirectCustom(url: string, status: number): void {
        this.reset()
        this.statusCode = status
        this.headers.push([HTTP_HEADERS.LOCATION, url])
        this.submit = true
    }

    /**
     * Clones the response builder.
     * @returns A new response builder instance with the same state
     */
    clone(): ResponseBuilder {
        const rb = new ResponseBuilder()
        rb.statusCode = this.statusCode
        rb.statusText = this.statusText
        rb.bodyInit = this.bodyInit
        rb.headers = [...this.headers]
        rb.submit = this.submit
        return rb
    }
}