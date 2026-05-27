import type { RequestMiddleware, Context, NRequest } from "../types"
import type { Validator as ValidatorType } from "../../../index.js"

// ─── Field Schema (internal representation) ──────────────────────────

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

/** A field definition can be a raw FieldSchema or a builder instance. */
export type FieldDef = FieldSchema | BaseBuilder<any>

export interface RouteSchemaDefinition {
    body?: Record<string, FieldDef>
    query?: Record<string, FieldDef>
    params?: Record<string, FieldDef>
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

// ─── Builder Classes (fluent API) ────────────────────────────────────

/** Base builder with shared methods for all types. */
abstract class BaseBuilder<T extends BaseBuilder<T>> {
    protected _schema: FieldSchema;

    constructor(schema: FieldSchema) {
        this._schema = schema;
    }

    /** Mark this field as required. */
    required(): T {
        this._schema.required = true;
        return this as unknown as T;
    }

    /** Set a default value. */
    default(value: unknown): T {
        this._schema.default = value;
        return this as unknown as T;
    }

    /** Build and return the schema. */
    build(): FieldSchema {
        return { ...this._schema };
    }
}

/** String field builder. */
export class StringBuilder extends BaseBuilder<StringBuilder> {
    constructor() {
        super({ type: "string" });
    }

    /** Minimum string length. */
    min(length: number): StringBuilder {
        this._schema.min = length;
        return this;
    }

    /** Maximum string length. */
    max(length: number): StringBuilder {
        this._schema.max = length;
        return this;
    }

    /** Validate against a pattern. */
    pattern(name: string): StringBuilder {
        this._schema.pattern = name;
        return this;
    }

    /** Restrict to allowed values. */
    enum(...values: string[]): StringBuilder {
        this._schema.enum = values;
        return this;
    }
}

/** Number field builder. */
export class NumberBuilder extends BaseBuilder<NumberBuilder> {
    constructor(type: "number" | "integer" = "number") {
        super({ type });
        if (type === "integer") {
            this._schema.int = true;
        }
    }

    /** Minimum value. */
    min(value: number): NumberBuilder {
        this._schema.min = value;
        return this;
    }

    /** Maximum value. */
    max(value: number): NumberBuilder {
        this._schema.max = value;
        return this;
    }

    /** Restrict to integer values. */
    integer(): NumberBuilder {
        this._schema.int = true;
        if (this._schema.type === "number") {
            this._schema.type = "integer";
        }
        return this;
    }
}

/** Boolean field builder. */
export class BooleanBuilder extends BaseBuilder<BooleanBuilder> {
    constructor() {
        super({ type: "boolean" });
    }
}

/** Array field builder. */
export class ArrayBuilder extends BaseBuilder<ArrayBuilder> {
    constructor(itemSchema: FieldSchema) {
        super({ type: "array", items: itemSchema });
    }

    /** Minimum array length. */
    min(length: number): ArrayBuilder {
        this._schema.min = length;
        return this;
    }

    /** Maximum array length. */
    max(length: number): ArrayBuilder {
        this._schema.max = length;
        return this;
    }
}

/** Object field builder. */
export class ObjectBuilder extends BaseBuilder<ObjectBuilder> {
    constructor(properties: Record<string, FieldSchema>) {
        super({ type: "object", properties });
    }
}

// ─── Schema Builder Factory ──────────────────────────────────────────

/**
 * Fluent schema builder for defining validation rules.
 *
 * @example
 * ```ts
 * import { s } from "napi-router/adapter/router/router/validator"
 *
 * // String with constraints
 * s.string().required().min(2).max(100)
 * s.string().required().pattern("email")
 * s.string().required().enum("admin", "user", "guest")
 *
 * // Number / Integer
 * s.number().min(0).max(100)
 * s.integer().required().min(1)
 *
 * // Boolean
 * s.boolean().required()
 *
 * // Array
 * s.array(s.string()).min(1).max(10)
 * s.array(s.object({ id: s.string().required(), qty: s.integer().min(1) }))
 *
 * // Object
 * s.object({
 *   name: s.string().required().min(2),
 *   age: s.integer().min(0).max(200),
 *   email: s.string().required().pattern("email"),
 * })
 * ```
 */
export const s = {
    /** Create a string field builder. */
    string(): StringBuilder {
        return new StringBuilder();
    },

    /** Create a number field builder. */
    number(): NumberBuilder {
        return new NumberBuilder("number");
    },

    /** Create an integer field builder. */
    integer(): NumberBuilder {
        return new NumberBuilder("integer");
    },

    /** Create a boolean field builder. */
    boolean(): BooleanBuilder {
        return new BooleanBuilder();
    },

    /** Create an array field builder. */
    array(items: FieldSchema | BaseBuilder<any>): ArrayBuilder {
        const itemSchema = items instanceof BaseBuilder ? items.build() : items;
        return new ArrayBuilder(itemSchema);
    },

    /** Create an object field builder. */
    object(properties: Record<string, FieldSchema | BaseBuilder<any>>): ObjectBuilder {
        const resolved: Record<string, FieldSchema> = {};
        for (const [key, val] of Object.entries(properties)) {
            resolved[key] = val instanceof BaseBuilder ? val.build() : val;
        }
        return new ObjectBuilder(resolved);
    },
};

// ─── Internal helpers ────────────────────────────────────────────────

/** @internal */
export function fieldSchemaToRustJson(schema: FieldSchema): Record<string, unknown> {
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

/** @internal */
export function resolveFieldSchema(field: FieldSchema | BaseBuilder<any>): FieldSchema {
    return field instanceof BaseBuilder ? field.build() : field
}

/** @internal */
export function schemaDefToJson(def: RouteSchemaDefinition): string {
    const result: Record<string, unknown> = {}
    if (def.body) {
        const body: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(def.body)) {
            body[key] = fieldSchemaToRustJson(resolveFieldSchema(val))
        }
        result.body = body
    }
    if (def.query) {
        const query: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(def.query)) {
            query[key] = fieldSchemaToRustJson(resolveFieldSchema(val))
        }
        result.query = query
    }
    if (def.params) {
        const params: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(def.params)) {
            params[key] = fieldSchemaToRustJson(resolveFieldSchema(val))
        }
        result.params = params
    }
    return JSON.stringify(result)
}

/**
 * Build a route key from the request's method and path.
 * Used for validator schema lookup.
 * @internal
 */
function buildRouteKey(method: string, path: string): string {
    return `${method}:${path}`
}

/**
 * Create a validation middleware that validates request data using Rust-side validation.
 * Returns 400 with structured errors if validation fails.
 *
 * The method and path are auto-detected from the request context at runtime.
 *
 * @param schema The schema definition for body/query/params
 * @param validator The Rust Validator instance
 * @returns A RequestMiddleware that validates the request
 *
 * @example
 * ```ts
 * import { Validator } from "napi-router"
 * import { validate, s } from "napi-router/adapter/router/router/validator"
 *
 * const validator = new Validator()
 * router.setValidator(validator)
 *
 * router.post("/users",
 *   validate({
 *     body: {
 *       name: s.string().required().min(2).max(100),
 *       email: s.string().required().pattern("email"),
 *     },
 *     query: {
 *       format: s.string().enum("short", "full"),
 *     },
 *   }, validator),
 *   handler
 * )
 * ```
 */
export function validate(
    schema: RouteSchemaDefinition,
    validator: ValidatorType,
): RequestMiddleware {
    const schemaJson = schemaDefToJson(schema)

    const validationMiddleware: RequestMiddleware = (ctx: Context) => {
        const req: NRequest = ctx.req
        const url = new URL(req.url)
        const routeKey = buildRouteKey(req.method, url.pathname)

        // Auto-register schema if not yet registered for this route
        if (!validator.hasSchema(routeKey)) {
            validator.addSchema(routeKey, schemaJson)
        }

        // Validate body — use Rust-parsed body string when available
        if (schema.body) {
            let validated = false

            const rustBody = req._rustParsedBody
            if (typeof rustBody === "string") {
                const result = validator.validateBodyValue(routeKey, rustBody)
                if (!result.success) {
                    ctx.status(400).json({
                        error: "Validation failed",
                        errors: result.errors,
                    })
                    return
                }
                validated = true
            }

            if (!validated) {
                if (req.parsedBody !== undefined) {
                    const result = validator.validateBodyValue(routeKey, JSON.stringify(req.parsedBody))
                    if (!result.success) {
                        ctx.status(400).json({
                            error: "Validation failed",
                            errors: result.errors,
                        })
                        return
                    }
                } else {
                    const hasRequired = Object.values(schema.body).some(f => {
                        const resolved = resolveFieldSchema(f)
                        return resolved.required
                    })
                    if (hasRequired) {
                        ctx.status(400).json({
                            error: "Validation failed",
                            errors: [{ field: "body", message: "Request body is required", code: "required" }],
                        })
                        return
                    }
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

    return validationMiddleware
}
