use std::collections::HashMap;

use napi_derive::napi;

use crate::schema::{
    CompiledField, CompiledPattern, CompiledProperties, CompiledRouteSchema, PatternRegistry,
};

// ─── Field Schema Builder (NAPI-exposed) ─────────────────────────────

/// String field builder with fluent API.
#[napi]
pub struct StringField {
    pub(crate) required: bool,
    pub(crate) min: Option<f64>,
    pub(crate) max: Option<f64>,
    pub(crate) pattern: Option<String>,
    pub(crate) enum_values: Option<Vec<String>>,
}

impl Default for StringField {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl StringField {
    #[napi(constructor)]
    pub fn new() -> Self {
        StringField {
            required: false,
            min: None,
            max: None,
            pattern: None,
            enum_values: None,
        }
    }

    /// Mark field as required.
    #[napi]
    pub fn required(&mut self) {
        self.required = true;
    }

    /// Set minimum string length.
    #[napi]
    pub fn set_min(&mut self, length: f64) {
        self.min = Some(length);
    }

    /// Set maximum string length.
    #[napi]
    pub fn set_max(&mut self, length: f64) {
        self.max = Some(length);
    }

    /// Set validation pattern (built-in name or custom registered pattern).
    #[napi]
    pub fn set_pattern(&mut self, name: String) {
        self.pattern = Some(name);
    }

    /// Restrict to allowed values.
    #[napi]
    pub fn set_enum(&mut self, values: Vec<String>) {
        self.enum_values = Some(values);
    }

    /// Compile to CompiledField directly (zero-copy, no JSON).
    pub(crate) fn compile(&self, registry: Option<&PatternRegistry>) -> CompiledField {
        CompiledField::String {
            required: self.required,
            min: self.min,
            max: self.max,
            pattern: self
                .pattern
                .as_deref()
                .and_then(|p| compile_pattern(p, registry)),
            enum_values: self
                .enum_values
                .as_ref()
                .map(|v| v.iter().map(|s| s.as_str().into()).collect()),
        }
    }
}

/// Number field builder with fluent API.
#[napi]
pub struct NumberField {
    pub(crate) is_integer: bool,
    pub(crate) required: bool,
    pub(crate) min: Option<f64>,
    pub(crate) max: Option<f64>,
}

impl Default for NumberField {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl NumberField {
    #[napi(constructor)]
    pub fn new() -> Self {
        NumberField {
            is_integer: false,
            required: false,
            min: None,
            max: None,
        }
    }

    /// Mark field as required.
    #[napi]
    pub fn required(&mut self) {
        self.required = true;
    }

    /// Restrict to integer values.
    #[napi]
    pub fn integer(&mut self) {
        self.is_integer = true;
    }

    /// Set minimum value.
    #[napi]
    pub fn set_min(&mut self, value: f64) {
        self.min = Some(value);
    }

    /// Set maximum value.
    #[napi]
    pub fn set_max(&mut self, value: f64) {
        self.max = Some(value);
    }

    /// Compile to CompiledField directly (zero-copy, no JSON).
    pub(crate) fn compile(&self) -> CompiledField {
        if self.is_integer {
            CompiledField::Integer {
                required: self.required,
                min: self.min,
                max: self.max,
            }
        } else {
            CompiledField::Number {
                required: self.required,
                min: self.min,
                max: self.max,
                int: false,
            }
        }
    }
}

/// Boolean field builder with fluent API.
#[napi]
pub struct BooleanField {
    pub(crate) required: bool,
}

impl Default for BooleanField {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl BooleanField {
    #[napi(constructor)]
    pub fn new() -> Self {
        BooleanField { required: false }
    }

    /// Mark field as required.
    #[napi]
    pub fn required(&mut self) {
        self.required = true;
    }

    /// Compile to CompiledField directly (zero-copy, no JSON).
    pub(crate) fn compile(&self) -> CompiledField {
        CompiledField::Boolean {
            required: self.required,
        }
    }
}

/// Object field builder with fluent API.
#[napi]
pub struct ObjectField {
    pub(crate) required: bool,
    pub(crate) properties: Vec<(String, CompiledField)>,
}

impl Default for ObjectField {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl ObjectField {
    #[napi(constructor)]
    pub fn new() -> Self {
        ObjectField {
            required: false,
            properties: Vec::new(),
        }
    }

    /// Mark field as required.
    #[napi]
    pub fn required(&mut self) {
        self.required = true;
    }

    /// Add a string property.
    #[napi]
    pub fn add_string(&mut self, key: String, field: &StringField, registry: &PatternRegistry) {
        self.properties
            .push((key, field.compile(Some(registry))));
    }

    /// Add a number property.
    #[napi]
    pub fn add_number(&mut self, key: String, field: &NumberField) {
        self.properties.push((key, field.compile()));
    }

    /// Add a boolean property.
    #[napi]
    pub fn add_boolean(&mut self, key: String, field: &BooleanField) {
        self.properties.push((key, field.compile()));
    }

    /// Add an object property.
    #[napi]
    pub fn add_object(&mut self, key: String, field: &ObjectField) {
        self.properties.push((key, field.compile()));
    }

    /// Add an array property.
    #[napi]
    pub fn add_array(&mut self, key: String, field: &ArrayField) {
        self.properties.push((key, field.compile()));
    }

    /// Compile to CompiledField directly (zero-copy, no JSON).
    pub(crate) fn compile(&self) -> CompiledField {
        let mut props: Vec<(Box<str>, CompiledField)> = self
            .properties
            .iter()
            .map(|(k, v)| (k.as_str().into(), v.clone()))
            .collect();
        props.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        CompiledField::Object {
            required: self.required,
            properties: Some(props.into_boxed_slice()),
        }
    }
}

/// Array field builder with fluent API.
#[napi]
pub struct ArrayField {
    pub(crate) required: bool,
    pub(crate) items: Option<Box<CompiledField>>,
    pub(crate) min: Option<f64>,
    pub(crate) max: Option<f64>,
}

impl Default for ArrayField {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl ArrayField {
    #[napi(constructor)]
    pub fn new() -> Self {
        ArrayField {
            required: false,
            items: None,
            min: None,
            max: None,
        }
    }

    /// Mark field as required.
    #[napi]
    pub fn required(&mut self) {
        self.required = true;
    }

    /// Set minimum array length.
    #[napi]
    pub fn set_min(&mut self, length: f64) {
        self.min = Some(length);
    }

    /// Set maximum array length.
    #[napi]
    pub fn set_max(&mut self, length: f64) {
        self.max = Some(length);
    }

    /// Set item type as string.
    #[napi]
    pub fn of_string(&mut self, field: &StringField, registry: &PatternRegistry) {
        self.items = Some(Box::new(field.compile(Some(registry))));
    }

    /// Set item type as number.
    #[napi]
    pub fn of_number(&mut self, field: &NumberField) {
        self.items = Some(Box::new(field.compile()));
    }

    /// Set item type as boolean.
    #[napi]
    pub fn of_boolean(&mut self, field: &BooleanField) {
        self.items = Some(Box::new(field.compile()));
    }

    /// Set item type as object.
    #[napi]
    pub fn of_object(&mut self, field: &ObjectField) {
        self.items = Some(Box::new(field.compile()));
    }

    /// Set item type as array (nested).
    #[napi]
    pub fn of_array(&mut self, field: &ArrayField) {
        self.items = Some(Box::new(field.compile()));
    }

    /// Compile to CompiledField directly (zero-copy, no JSON).
    pub(crate) fn compile(&self) -> CompiledField {
        CompiledField::Array {
            required: self.required,
            items: self.items.clone(),
            min: self.min,
            max: self.max,
        }
    }
}

// ─── Schema Builder (zero-copy, compiles directly to CompiledRouteSchema)

/// Schema builder for defining validation rules for a route.
/// Compiles directly to Rust — no JSON serialization.
///
/// @example
/// ```ts
/// const schema = new SchemaBuilder()
/// schema.addBodyString("name", new StringField().tap(f => { f.required(); f.setMin(2) }))
/// schema.addBodyString("email", new StringField().tap(f => { f.required(); f.setPattern("email") }))
/// schema.addQueryNumber("page", new NumberField().tap(f => { f.integer(); f.setMin(1) }))
///
/// validator.addSchemaFromBuilder("POST:/users", schema)
/// ```
#[napi]
pub struct SchemaBuilder {
    body: Vec<(String, CompiledField)>,
    query: Vec<(String, CompiledField)>,
    params: Vec<(String, CompiledField)>,
    registry: Option<PatternRegistry>,
}

impl Default for SchemaBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl SchemaBuilder {
    #[napi(constructor)]
    pub fn new() -> Self {
        SchemaBuilder {
            body: Vec::new(),
            query: Vec::new(),
            params: Vec::new(),
            registry: None,
        }
    }

    /// Set the pattern registry for custom pattern compilation.
    #[napi]
    pub fn set_pattern_registry(&mut self, registry: &PatternRegistry) {
        self.registry = Some(registry.clone());
    }

    /// Add a body field with a string schema.
    #[napi]
    pub fn add_body_string(&mut self, key: String, field: &StringField) {
        self.body
            .push((key, field.compile(self.registry.as_ref())));
    }

    /// Add a body field with a number schema.
    #[napi]
    pub fn add_body_number(&mut self, key: String, field: &NumberField) {
        self.body.push((key, field.compile()));
    }

    /// Add a body field with a boolean schema.
    #[napi]
    pub fn add_body_boolean(&mut self, key: String, field: &BooleanField) {
        self.body.push((key, field.compile()));
    }

    /// Add a body field with an object schema.
    #[napi]
    pub fn add_body_object(&mut self, key: String, field: &ObjectField) {
        self.body.push((key, field.compile()));
    }

    /// Add a body field with an array schema.
    #[napi]
    pub fn add_body_array(&mut self, key: String, field: &ArrayField) {
        self.body.push((key, field.compile()));
    }

    /// Add a query parameter field with a string schema.
    #[napi]
    pub fn add_query_string(&mut self, key: String, field: &StringField) {
        self.query
            .push((key, field.compile(self.registry.as_ref())));
    }

    /// Add a query parameter field with a number schema.
    #[napi]
    pub fn add_query_number(&mut self, key: String, field: &NumberField) {
        self.query.push((key, field.compile()));
    }

    /// Add a path parameter field with a string schema.
    #[napi]
    pub fn add_param_string(&mut self, key: String, field: &StringField) {
        self.params
            .push((key, field.compile(self.registry.as_ref())));
    }

    /// Add a path parameter field with a number schema.
    #[napi]
    pub fn add_param_number(&mut self, key: String, field: &NumberField) {
        self.params.push((key, field.compile()));
    }

    /// Compile directly to CompiledRouteSchema (zero-copy, no JSON).
    pub(crate) fn compile(&self) -> CompiledRouteSchema {
        let compile_vec =
            |v: &[(String, CompiledField)]| -> Option<CompiledProperties> {
                if v.is_empty() {
                    return None;
                }
                let mut props: Vec<(Box<str>, CompiledField)> = v
                    .iter()
                    .map(|(k, v)| (k.as_str().into(), v.clone()))
                    .collect();
                props.sort_unstable_by(|a, b| a.0.cmp(&b.0));
                Some(props.into_boxed_slice())
            };

        CompiledRouteSchema {
            body: compile_vec(&self.body),
            query: compile_vec(&self.query),
            params: compile_vec(&self.params),
        }
    }
}

// ─── Pattern compilation helper ──────────────────────────────────────

fn compile_pattern(s: &str, registry: Option<&PatternRegistry>) -> Option<CompiledPattern> {
    match s {
        "email" => Some(CompiledPattern::Email),
        "url" => Some(CompiledPattern::Url),
        "uuid" => Some(CompiledPattern::Uuid),
        "alpha" => Some(CompiledPattern::Alpha),
        "alphanumeric" => Some(CompiledPattern::Alphanumeric),
        "numeric" => Some(CompiledPattern::Numeric),
        name => registry.and_then(|reg| {
            if reg.contains_key(name) {
                Some(CompiledPattern::Custom(name.to_string()))
            } else {
                None
            }
        }),
    }
}
