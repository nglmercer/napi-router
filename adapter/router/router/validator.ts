import { splitRoutePath } from "../path"
import { parseHttpMethods, HttpMethodString } from "../method"
import type { EndpointRoute, RequestMiddleware, Context } from "../types"

export interface FieldSchema {
    type: "string" | "number" | "integer" | "boolean" | "object" | "array"
    required?: boolean
    min?: number
    max?: number
    pattern?: string
    enum?: string[]
    int?: boolean
    default?: unknown
    items?: FieldSchema
    properties?: Record<string, FieldSchema>
}

export interface RouteSchemaDefinition {
    body?: Record<string, FieldSchema>
    query?: Record<string, FieldSchema>
    params?: Record<string, FieldSchema>
}

export interface ValidationError {
    field: string
    message: string
    code: string
}

export interface ValidationResult {
    success: boolean
    errors?: ValidationError[]
    data?: string
}

/// Schema builder helpers — fluent API for defining field schemas
export const s = {
    string(opts?: { required?: boolean; min?: number; max?: number; pattern?: string; enum?: string[] }): FieldSchema {
        return { type: "string", ...opts }
    },
    number(opts?: { required?: boolean; min?: number; max?: number; int?: boolean }): FieldSchema {
        return { type: "number", ...opts }
    },
    integer(opts?: { required?: boolean; min?: number; max?: number }): FieldSchema {
        return { type: "integer", ...opts }
    },
    boolean(opts?: { required?: boolean }): FieldSchema {
        return { type: "boolean", ...opts }
    },
    object(properties: Record<string, FieldSchema>, opts?: { required?: boolean }): FieldSchema {
        return { type: "object", properties, ...opts }
    },
    array(items: FieldSchema, opts?: { required?: boolean; min?: number; max?: number }): FieldSchema {
        return { type: "array", items, ...opts }
    },
}

function fieldSchemaToRustJson(schema: FieldSchema): Record<string, unknown> {
    const result: Record<string, unknown> = {
        type: schema.type,
        required: schema.required ?? false,
    }
    if (schema.min !== undefined) result.min = schema.min
    if (schema.max !== undefined) result.max = schema.max
    if (schema.pattern !== undefined) result.pattern = schema.pattern
    if (schema.enum !== undefined) result.enum = schema.enum
    if (schema.int !== undefined) result.int = schema.int
    if (schema.default !== undefined) result.default = schema.default
    if (schema.items !== undefined) result.items = fieldSchemaToRustJson(schema.items)
    if (schema.properties !== undefined) {
        const props: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(schema.properties)) {
            props[key] = fieldSchemaToRustJson(val)
        }
        result.properties = props
    }
    return result
}

function schemaDefToJson(def: RouteSchemaDefinition): string {
    const result: Record<string, unknown> = {}
    if (def.body) {
        const body: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(def.body)) {
            body[key] = fieldSchemaToRustJson(val)
        }
        result.body = body
    }
    if (def.query) {
        const query: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(def.query)) {
            query[key] = fieldSchemaToRustJson(val)
        }
        result.query = query
    }
    if (def.params) {
        const params: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(def.params)) {
            params[key] = fieldSchemaToRustJson(val)
        }
        result.params = params
    }
    return JSON.stringify(result)
}

/// Creates a validation middleware that validates request data using Rust-side validation.
/// Returns 400 with structured errors if validation fails.
export function validate(
    routes: EndpointRoute[],
    _routeMeta: Map<string, { queryParams?: unknown[] }>,
    method: "*" | HttpMethodString,
    path: string,
    schema: RouteSchemaDefinition,
    validator: import("../../../index.js").Validator,
): EndpointRoute[] {
    const routeKey = `${method === "*" ? "ALL" : method}:${path}`

    // Register schema with Rust validator
    validator.addSchema(routeKey, schemaDefToJson(schema))

    const validationMiddleware: RequestMiddleware = (ctx: Context) => {
        const req = ctx.req

        // Validate body — use Rust-parsed body string if available, otherwise from parsedBody
        if (schema.body) {
            let bodyJson: string | undefined

            // Check if Rust already provided the parsed body as string
            const rustData = (req as any)._rustParsedBody
            if (typeof rustData === "string") {
                bodyJson = rustData
            } else if (req.parsedBody !== undefined) {
                // Body was parsed by bodyParser (or Rust), serialize for validation
                bodyJson = JSON.stringify(req.parsedBody)
            }

            if (bodyJson) {
                const result = validator.validateBodyValue(routeKey, bodyJson)
                if (!result.success) {
                    ctx.status(400).json({
                        error: "Validation failed",
                        errors: result.errors,
                    })
                    return
                }
            } else if (schema.body) {
                // Check if any body field is required
                const hasRequired = Object.values(schema.body).some(f => f.required)
                if (hasRequired) {
                    ctx.status(400).json({
                        error: "Validation failed",
                        errors: [{ field: "body", message: "Request body is required", code: "required" }],
                    })
                    return
                }
            }
        }

        // Validate query params
        if (schema.query) {
            const queryMap: Record<string, string> = {}
            const queryParams = req.queryParams
            if (queryParams) {
                for (const [key, val] of Object.entries(queryParams)) {
                    queryMap[key] = val
                }
            }
            const result = validator.validateQuery(routeKey, queryMap)
            if (!result.success) {
                ctx.status(400).json({
                    error: "Validation failed",
                    errors: result.errors,
                })
                return
            }
        }

        // Validate path params
        if (schema.params && req.pathParams) {
            const paramMap: Record<string, string> = {}
            const pp = req.pathParams
            if (typeof pp === "object" && !Array.isArray(pp)) {
                for (const [key, val] of Object.entries(pp)) {
                    paramMap[key] = val
                }
            }
            const result = validator.validateParams(routeKey, paramMap)
            if (!result.success) {
                ctx.status(400).json({
                    error: "Validation failed",
                    errors: result.errors,
                })
                return
            }
        }
    }

    routes.push({
        splitPath: splitRoutePath(path),
        method: parseHttpMethods(method),
        handler: validationMiddleware,
        middlewareName: "validator",
    })

    return routes
}
