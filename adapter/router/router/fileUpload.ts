import { splitRoutePath } from "../path"
import { parseHttpMethods, HttpMethodString } from "../method"
import type { EndpointRoute, Request, RequestMiddleware } from "../types"

export interface UploadedFile {
    name: string
    type: string
    size: number
    arrayBuffer(): Promise<ArrayBuffer>
    text(): Promise<string>
    json(): Promise<unknown>
    blob(): Promise<Blob>
    stream(): ReadableStream
}

export interface FileUploadOptions {
    maxSize?: number
    allowedTypes?: string[]
}

/**
 * Parse a multipart/form-data request body.
 * @param req The request to parse
 * @returns Parsed files and fields
 */
async function parseMultipartBody(
    req: Request,
): Promise<{ files: Map<string, UploadedFile[]>; fields: Record<string, string> }> {
    const contentType = req.headers.get("content-type") || ""
    const files = new Map<string, UploadedFile[]>()
    const fields: Record<string, string> = {}

    if (!contentType.includes("multipart/form-data")) {
        return { files, fields }
    }

    const formData = await req.formData()

    for (const [key, value] of formData.entries()) {
        if (typeof value === "object" && "name" in value) {
            const file: UploadedFile = {
                name: (value as File).name,
                type: (value as File).type,
                size: (value as File).size,
                arrayBuffer: () => (value as File).arrayBuffer(),
                text: () => (value as File).text(),
                json: () => (value as File).text().then(t => JSON.parse(t)),
                blob: () => Promise.resolve(value as File),
                stream: () => (value as File).stream(),
            }
            const existing = files.get(key) || []
            existing.push(file)
            files.set(key, existing)
        } else {
            fields[key] = typeof value === "string" ? value : String(value)
        }
    }

    return { files, fields }
}

/**
 * Register a file upload middleware.
 * Parses multipart/form-data requests and populates `req.file()` and `req.files()`.
 * @param routes The routes array to add to
 * @param method The HTTP method(s) to match
 * @param path The path to handle file uploads on
 * @param options File upload configuration
 * @returns The updated routes array.
 */
export function fileUpload(
    routes: EndpointRoute[],
    method: "*" | HttpMethodString,
    path: string,
    options: FileUploadOptions = {},
): EndpointRoute[] {
    const { maxSize, allowedTypes } = options

    const fileUploadMiddleware: RequestMiddleware = async (ctx) => {
        const req = ctx.req
        const contentType = req.headers.get("content-type") || ""

        if (!contentType.includes("multipart/form-data")) {
            return
        }

        const { files, fields } = await parseMultipartBody(req)

        if (Object.keys(fields).length > 0) {
            req.parsedBody = fields
        }

        const reqAny = req as unknown as Record<string, unknown>
        reqAny._uploadedFiles = files
        reqAny._uploadedFields = fields

        if (maxSize !== undefined) {
            for (const [, fileList] of files) {
                for (const file of fileList) {
                    if (file.size > maxSize) {
                        return
                    }
                }
            }
        }

        if (allowedTypes && allowedTypes.length > 0) {
            for (const [, fileList] of files) {
                for (const file of fileList) {
                    if (!allowedTypes.includes(file.type)) {
                        return
                    }
                }
            }
        }
    }

    routes.push({
        splitPath: splitRoutePath(path),
        method: parseHttpMethods(method),
        handler: fileUploadMiddleware,
        middlewareName: "fileUpload",
    })

    return routes
}

/**
 * Get a single uploaded file from the request.
 * @param req The request object
 * @param fieldName The form field name
 * @returns The first uploaded file, or undefined
 */
export function getFile(req: Request, fieldName: string): UploadedFile | undefined {
    const reqAny = req as unknown as Record<string, unknown>
    const files = reqAny._uploadedFiles as Map<string, UploadedFile[]> | undefined
    return files?.get(fieldName)?.[0]
}

/**
 * Get all uploaded files for a field name from the request.
 * @param req The request object
 * @param fieldName The form field name
 * @returns Array of uploaded files, or empty array
 */
export function getFiles(req: Request, fieldName: string): UploadedFile[] {
    const reqAny = req as unknown as Record<string, unknown>
    const files = reqAny._uploadedFiles as Map<string, UploadedFile[]> | undefined
    return files?.get(fieldName) || []
}

/**
 * Get all uploaded field names from the request.
 * @param req The request object
 * @returns Array of field names that have files
 */
export function getFileFieldNames(req: Request): string[] {
    const reqAny = req as unknown as Record<string, unknown>
    const files = reqAny._uploadedFiles as Map<string, UploadedFile[]> | undefined
    return files ? Array.from(files.keys()) : []
}

/**
 * Get all parsed form fields (non-file) from the request.
 * @param req The request object
 * @returns Record of field names to values
 */
export function getFormFields(req: Request): Record<string, string> {
    const reqAny = req as unknown as Record<string, unknown>
    return (reqAny._uploadedFields as Record<string, string>) || {}
}
