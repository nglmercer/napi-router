import type { Validator as ValidatorType } from "../../../index.js"
import {
    SchemaBuilder as RustSchemaBuilder,
    StringField as RustStringField,
    NumberField as RustNumberField,
    BooleanField as RustBooleanField,
    ObjectField as RustObjectField,
    ArrayField as RustArrayField,
} from "../../../index.js"

export {
    RustSchemaBuilder as SchemaBuilder,
    RustStringField as StringField,
    RustNumberField as NumberField,
    RustBooleanField as BooleanField,
    RustObjectField as ObjectField,
    RustArrayField as ArrayField,
}

// ─── Field Schema ────────────────────────────────────────────────────

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

export type FieldDef = FieldSchema | BaseBuilder<any>

export interface ValidationError {
    field: string
    message: string
    code: string
}

export type ValidationResult<T = unknown> =
    | { success: true; data: T }
    | { success: false; errors: ValidationError[] }

// ─── Type Inference ──────────────────────────────────────────────────

/** Infer the output type of a single field builder. */
export type InferField<T> =
    T extends StringBuilder ? string
    : T extends NumberBuilder ? number
    : T extends BooleanBuilder ? boolean
    : T extends ArrayBuilder<infer Item> ? Item[]
    : T extends ObjectBuilder<infer Props> ? Props
    : T extends { __output: infer O } ? O
    : unknown

/** Infer the output type of a fields record. */
export type InferFields<T extends Record<string, FieldDef>> = {
    [K in keyof T]: InferField<T[K]>
}

// ─── Builders ────────────────────────────────────────────────────────

abstract class BaseBuilder<T extends BaseBuilder<T, O>, O = unknown> {
    declare readonly __output: O
    protected _schema: FieldSchema;
    constructor(schema: FieldSchema) { this._schema = schema; }
    required(): T { this._schema.required = true; return this as unknown as T; }
    build(): FieldSchema { return { ...this._schema }; }
}

export class StringBuilder extends BaseBuilder<StringBuilder, string> {
    constructor() { super({ type: "string" }); }
    min(n: number): StringBuilder { this._schema.min = n; return this; }
    max(n: number): StringBuilder { this._schema.max = n; return this; }
    pattern(p: string): StringBuilder { this._schema.pattern = p; return this; }
    enum(...v: string[]): StringBuilder { this._schema.enum = v; return this; }
}

export class NumberBuilder extends BaseBuilder<NumberBuilder, number> {
    constructor(type: "number" | "integer" = "number") { super({ type }); if (type === "integer") this._schema.int = true; }
    min(v: number): NumberBuilder { this._schema.min = v; return this; }
    max(v: number): NumberBuilder { this._schema.max = v; return this; }
    integer(): NumberBuilder { this._schema.int = true; this._schema.type = "integer"; return this; }
}

export class BooleanBuilder extends BaseBuilder<BooleanBuilder, boolean> {
    constructor() { super({ type: "boolean" }); }
}

export class ArrayBuilder<Item = unknown> extends BaseBuilder<ArrayBuilder<Item>, Item[]> {
    constructor(items: FieldSchema) { super({ type: "array", items }); }
    min(n: number): ArrayBuilder<Item> { this._schema.min = n; return this; }
    max(n: number): ArrayBuilder<Item> { this._schema.max = n; return this; }
}

export class ObjectBuilder<Props extends Record<string, unknown> = Record<string, unknown>> extends BaseBuilder<ObjectBuilder<Props>, Props> {
    constructor(props: Record<string, FieldSchema>) { super({ type: "object", properties: props }); }
}

// ─── Schema Builder Factory (s.*) ────────────────────────────────────

export const s = {
    string: (): StringBuilder => new StringBuilder(),
    number: (): NumberBuilder => new NumberBuilder("number"),
    integer: (): NumberBuilder => new NumberBuilder("integer"),
    boolean: (): BooleanBuilder => new BooleanBuilder(),
    array: <T>(items: FieldSchema | BaseBuilder<any> & { __output: T }): ArrayBuilder<T> =>
        new ArrayBuilder<T>(items instanceof BaseBuilder ? items.build() : items),
    object: <T extends Record<string, FieldSchema | BaseBuilder<any>>>(
        props: T
    ): ObjectBuilder<{ [K in keyof T]: InferField<T[K]> }> => {
        const r: Record<string, FieldSchema> = {};
        for (const [k, v] of Object.entries(props)) r[k] = v instanceof BaseBuilder ? v.build() : v;
        return new ObjectBuilder(r) as any;
    },
};

// ─── Helpers ─────────────────────────────────────────────────────────

function resolve(field: FieldSchema | BaseBuilder<any>): FieldSchema {
    return field instanceof BaseBuilder ? field.build() : field
}

function toRustJson(schema: FieldSchema): Record<string, unknown> {
    const r: Record<string, unknown> = { type: schema.type, required: schema.required ?? false }
    if (schema.min !== undefined) r.min = schema.min
    if (schema.max !== undefined) r.max = schema.max
    if (schema.pattern !== undefined) r.pattern = schema.pattern
    if (schema.enum !== undefined) r.enum = schema.enum
    if (schema.int !== undefined) r.int = schema.int
    if (schema.items !== undefined) r.items = toRustJson(schema.items)
    if (schema.properties !== undefined) {
        const p: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(schema.properties)) p[k] = toRustJson(v)
        r.properties = p
    }
    return r
}

let _counter = 0

// ─── validate() ──────────────────────────────────────────────────────

/**
 * Validate body data against fields. Returns `{ success, data?, errors? }`.
 * Types are auto-inferred from the field definitions.
 *
 * @example
 * ```ts
 * const result = validate({ name: "John", email: "john@example.com" }, {
 *   name: s.string().required().min(2),
 *   email: s.string().required().pattern("email"),
 * }, validator)
 *
 * if (result.success) {
 *   result.data.name  // string
 *   result.data.email // string
 * }
 * ```
 */
export function validate<T extends Record<string, FieldDef>>(
    data: unknown,
    fields: T,
    validator: ValidatorType,
): ValidationResult<InferFields<T>> {
    // Build JSON schema for body
    const bodySchema: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(fields)) {
        bodySchema[k] = toRustJson(resolve(v))
    }
    const schemaJson = JSON.stringify({ body: bodySchema })

    // Register with a unique key
    const key = `__validate_${_counter++}`
    validator.addSchema(key, schemaJson)

    // Serialize data
    let bodyString: string
    if (typeof data === "string") {
        bodyString = data
    } else if (data !== undefined && data !== null) {
        try { bodyString = JSON.stringify(data) } catch {
            return { success: false, errors: [{ field: "body", message: "Invalid data", code: "invalid_json" }] }
        }
    } else {
        return { success: false, errors: [{ field: "body", message: "Data is required", code: "required" }] }
    }

    const result = validator.validateBodyValue(key, bodyString)
    if (!result.success) {
        return { success: false, errors: result.errors ?? [] }
    }

    // Parse validated data
    let parsed: InferFields<T>
    if (typeof data === "string") {
        try { parsed = JSON.parse(result.data ?? data) as InferFields<T> } catch { parsed = data as InferFields<T> }
    } else {
        parsed = (result.data ? (tryParse(result.data) ?? data) : data) as InferFields<T>
    }

    return { success: true, data: parsed }
}

function tryParse(json: string): unknown {
    try { return JSON.parse(json) } catch { return undefined }
}
