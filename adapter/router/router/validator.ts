import type { RequestMiddleware, Context, NRequest } from "../types"
import type { Validator as ValidatorType } from "../../../index.js"
import {
    SchemaBuilder as RustSchemaBuilder,
    StringField as RustStringField,
    NumberField as RustNumberField,
    BooleanField as RustBooleanField,
    ObjectField as RustObjectField,
    ArrayField as RustArrayField,
} from "../../../index.js"

// Re-export Rust builders for direct use
export {
    RustSchemaBuilder as SchemaBuilder,
    RustStringField as StringField,
    RustNumberField as NumberField,
    RustBooleanField as BooleanField,
    RustObjectField as ObjectField,
    RustArrayField as ArrayField,
}

// ─── Field Schema (TS-based, for s.* builder) ────────────────────────

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

/** A field definition can be a raw FieldSchema or a TS builder instance. */
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

// ─── TS Builder Classes (fluent API, compiled to JSON) ───────────────

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

    min(length: number): StringBuilder { this._schema.min = length; return this; }
    max(length: number): StringBuilder { this._schema.max = length; return this; }
    pattern(name: string): StringBuilder { this._schema.pattern = name; return this; }
    enum(...values: string[]): StringBuilder { this._schema.enum = values; return this; }
}

/** Number field builder. */
export class NumberBuilder extends BaseBuilder<NumberBuilder> {
    constructor(type: "number" | "integer" = "number") {
        super({ type });
        if (type === "integer") this._schema.int = true;
    }

    min(value: number): NumberBuilder { this._schema.min = value; return this; }
    max(value: number): NumberBuilder { this._schema.max = value; return this; }
    integer(): NumberBuilder { this._schema.int = true; if (this._schema.type === "number") this._schema.type = "integer"; return this; }
}

/** Boolean field builder. */
export class BooleanBuilder extends BaseBuilder<BooleanBuilder> {
    constructor() { super({ type: "boolean" }); }
}

/** Array field builder. */
export class ArrayBuilder extends BaseBuilder<ArrayBuilder> {
    constructor(itemSchema: FieldSchema) { super({ type: "array", items: itemSchema }); }
    min(length: number): ArrayBuilder { this._schema.min = length; return this; }
    max(length: number): ArrayBuilder { this._schema.max = length; return this; }
}

/** Object field builder. */
export class ObjectBuilder extends BaseBuilder<ObjectBuilder> {
    constructor(properties: Record<string, FieldSchema>) { super({ type: "object", properties }); }
}

// ─── Schema Builder Factory (s.*) ────────────────────────────────────

export const s = {
    string(): StringBuilder { return new StringBuilder(); },
    number(): NumberBuilder { return new NumberBuilder("number"); },
    integer(): NumberBuilder { return new NumberBuilder("integer"); },
    boolean(): BooleanBuilder { return new BooleanBuilder(); },
    array(items: FieldSchema | BaseBuilder<any>): ArrayBuilder {
        return new ArrayBuilder(items instanceof BaseBuilder ? items.build() : items);
    },
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
export function resolveFieldSchema(field: FieldSchema | BaseBuilder<any>): FieldSchema {
    return field instanceof BaseBuilder ? field.build() : field
}

/** @internal */
export function fieldSchemaToRustJson(schema: FieldSchema): Record<string, unknown> {
    const result: Record<string, unknown> = { type: schema.type, required: schema.required ?? false }
    if (schema.min !== undefined) result.min = schema.min
    if (schema.max !== undefined) result.max = schema.max
    if (schema.pattern !== undefined) result.pattern = schema.pattern
    if (schema.enum !== undefined) result.enum = schema.enum
    if (schema.int !== undefined) result.int = schema.int
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
export function schemaDefToJson(def: RouteSchemaDefinition): string {
    const result: Record<string, unknown> = {}
    if (def.body) {
        const body: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(def.body)) body[key] = fieldSchemaToRustJson(resolveFieldSchema(val))
        result.body = body
    }
    if (def.query) {
        const query: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(def.query)) query[key] = fieldSchemaToRustJson(resolveFieldSchema(val))
        result.query = query
    }
    if (def.params) {
        const params: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(def.params)) params[key] = fieldSchemaToRustJson(resolveFieldSchema(val))
        result.params = params
    }
    return JSON.stringify(result)
}

function buildRouteKey(method: string, path: string): string {
    return `${method}:${path}`
}

// ─── Validate function — accepts either TS schema or Rust SchemaBuilder

/**
 * Create a validation middleware.
 *
 * Overload 1: Pass a Rust SchemaBuilder (fastest, zero JSON):
 * ```ts
 * const schema = new SchemaBuilder()
 * schema.addBodyString("name", new StringField().tap(f => f.required()))
 * router.validate(schema, validator)
 * ```
 *
 * Overload 2: Pass a TS schema definition (convenient, compiled to JSON):
 * ```ts
 * router.validate({ body: { name: s.string().required() } }, validator)
 * ```
 */
export function validate(
    schema: RustSchemaBuilder | RouteSchemaDefinition,
    validator: ValidatorType,
): RequestMiddleware {
    // Determine if this is a Rust SchemaBuilder or a TS schema definition
    const isRustBuilder = schema instanceof RustSchemaBuilder

    if (!isRustBuilder) {
        // Pre-compile TS schema to JSON once
        const schemaJson = schemaDefToJson(schema as RouteSchemaDefinition)
        const hasBody = (schema as RouteSchemaDefinition).body !== undefined
        const hasQuery = (schema as RouteSchemaDefinition).query !== undefined
        const hasParams = (schema as RouteSchemaDefinition).params !== undefined

        return (ctx: Context) => {
            const req: NRequest = ctx.req
            const url = new URL(req.url)
            const routeKey = buildRouteKey(req.method, url.pathname)

            if (!validator.hasSchema(routeKey)) {
                validator.addSchema(routeKey, schemaJson)
            }

            runValidation(ctx, req, validator, routeKey, hasBody, hasQuery, hasParams, schema as RouteSchemaDefinition)
        }
    }

    // Rust SchemaBuilder path — zero JSON
    const builder = schema as RustSchemaBuilder

    return (ctx: Context) => {
        const req: NRequest = ctx.req
        const url = new URL(req.url)
        const routeKey = buildRouteKey(req.method, url.pathname)

        if (!validator.hasSchema(routeKey)) {
            validator.addSchemaFromBuilder(routeKey, builder)
        }

        runValidation(ctx, req, validator, routeKey, true, true, true)
    }
}

/** @internal */
function runValidation(
    ctx: Context,
    req: NRequest,
    validator: ValidatorType,
    routeKey: string,
    hasBody: boolean,
    hasQuery: boolean,
    hasParams: boolean,
    schemaDef?: RouteSchemaDefinition,
): void {
    // Validate body
    if (hasBody) {
        let validated = false

        const rustBody = req._rustParsedBody
        if (typeof rustBody === "string") {
            const result = validator.validateBodyValue(routeKey, rustBody)
            if (!result.success) {
                ctx.status(400).json({ error: "Validation failed", errors: result.errors })
                return
            }
            validated = true
        }

        if (!validated) {
            if (req.parsedBody !== undefined) {
                const result = validator.validateBodyValue(routeKey, JSON.stringify(req.parsedBody))
                if (!result.success) {
                    ctx.status(400).json({ error: "Validation failed", errors: result.errors })
                    return
                }
            } else if (schemaDef?.body) {
                const hasRequired = Object.values(schemaDef.body).some(f => resolveFieldSchema(f).required)
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
    if (hasQuery) {
        const queryMap: Record<string, string> = {}
        const queryParams = req.queryParams
        if (queryParams) {
            for (const [key, val] of Object.entries(queryParams)) queryMap[key] = val
        }
        const result = validator.validateQuery(routeKey, queryMap)
        if (!result.success) {
            ctx.status(400).json({ error: "Validation failed", errors: result.errors })
            return
        }
    }

    // Validate path params
    if (hasParams && req.pathParams) {
        const paramMap: Record<string, string> = {}
        const pp = req.pathParams
        if (typeof pp === "object" && !Array.isArray(pp)) {
            for (const [key, val] of Object.entries(pp)) paramMap[key] = val
        }
        const result = validator.validateParams(routeKey, paramMap)
        if (!result.success) {
            ctx.status(400).json({ error: "Validation failed", errors: result.errors })
        }
    }
}
