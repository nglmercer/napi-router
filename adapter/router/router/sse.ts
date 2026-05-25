import type { ResponseBuilder } from "../responseBuilder"

export interface SSEMessage {
    event?: string
    data: string | string[]
    id?: string
    retry?: number
}

export interface SSEStream {
    send(message: SSEMessage): void
    sendEvent(event: string, data: string | string[], id?: string): void
    sendComment(comment: string): void
    close(): void
    isOpen(): boolean
}

/**
 * Creates a Server-Sent Events stream on the response.
 * Sets appropriate headers and returns a stream controller.
 * @param res The response builder
 * @returns An SSE stream controller
 */
export function createSSEStream(res: ResponseBuilder): SSEStream {
    let closed = false
    let sseController: ReadableStreamDefaultController<Uint8Array> | undefined

    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
        start(controller) {
            sseController = controller
        },
        cancel() {
            closed = true
        },
        pull(controller) {
            if (closed) {
                controller.close()
            }
        }
    })

    const sseApi: SSEStream = {
        send(message: SSEMessage) {
            if (closed || !sseController) return

            let payload = ""
            if (message.id !== undefined) {
                payload += `id: ${message.id}\n`
            }
            if (message.retry !== undefined) {
                payload += `retry: ${message.retry}\n`
            }
            if (message.event !== undefined) {
                payload += `event: ${message.event}\n`
            }
            if (Array.isArray(message.data)) {
                for (const line of message.data) {
                    payload += `data: ${line}\n`
                }
            } else {
                payload += `data: ${message.data}\n`
            }
            payload += "\n"

            try {
                sseController.enqueue(encoder.encode(payload))
            } catch {
                closed = true
            }
        },

        sendEvent(event: string, data: string | string[], id?: string) {
            sseApi.send({ event, data, id })
        },

        sendComment(comment: string) {
            if (closed || !sseController) return
            try {
                sseController.enqueue(encoder.encode(`: ${comment}\n\n`))
            } catch {
                closed = true
            }
        },

        close() {
            if (closed) return
            closed = true
            try {
                sseController?.close()
            } catch {
                // Already closed
            }
        },

        isOpen() {
            return !closed
        }
    }

    res.body(stream)
    res.submit = true

    return sseApi
}

/**
 * Helper to send an SSE event from a handler.
 * Creates the stream and calls the handler with it.
 * @param res The response builder
 * @param handler A function that receives the SSE stream and can send messages
 */
export function sse(
    res: ResponseBuilder,
    handler: (stream: SSEStream) => void | Promise<void>,
): void {
    const stream = createSSEStream(res)
    Promise.resolve(handler(stream)).catch(() => {
        stream.close()
    })
}
