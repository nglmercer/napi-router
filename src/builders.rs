use napi_derive::napi;

use crate::schema::{CompiledField, CompiledPattern, CompiledRouteSchema, PatternRegistry};

// ─── Pattern compilation helper ──────────────────────────────────────

/// Compile a pattern name to a CompiledPattern.
/// Built-in patterns are resolved immediately.
/// Unknown patterns are stored as Custom (resolved at validation time via registry).
fn compile_pattern(s: &str) -> CompiledPattern {
    match s {
        "email" => CompiledPattern::Email,
        "url" => CompiledPattern::Url,
        "uuid" => CompiledPattern::Uuid,
        "alpha" => CompiledPattern::Alpha,
        "alphanumeric" => CompiledPattern::Alphanumeric,
        "numeric" => CompiledPattern::Numeric,
        name => CompiledPattern::Custom(name.to_string()),
    }
}

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

    /// Compile to CompiledField (patterns resolved immediately for built-ins, deferred for custom).
    pub(crate) fn compile(&self) -> CompiledField {
        CompiledField::String {
            required: self.required,
            min: self.min,
            max: self.max,
            pattern: self.pattern.as_deref().map(compile_pattern),
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

    #[napi]
    pub fn required(&mut self) {
        self.required = true;
    }

    #[napi]
    pub fn integer(&mut self) {
        self.is_integer = true;
    }

    #[napi]
    pub fn set_min(&mut self, value: f64) {
        self.min = Some(value);
    }

    #[napi]
    pub fn set_max(&mut self, value: f64) {
        self.max = Some(value);
    }

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

    #[napi]
    pub fn required(&mut self) {
        self.required = true;
    }

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

    #[napi]
    pub fn required(&mut self) {
        self.required = true;
    }

    #[napi]
    pub fn add_string(&mut self, key: String, field: &StringField) {
        self.properties
            .push((key, field.compile()));
    }

    #[napi]
    pub fn add_number(&mut self, key: String, field: &NumberField) {
        self.properties.push((key, field.compile()));
    }

    #[napi]
    pub fn add_boolean(&mut self, key: String, field: &BooleanField) {
        self.properties.push((key, field.compile()));
    }

    #[napi]
    pub fn add_object(&mut self, key: String, field: &ObjectField) {
        self.properties.push((key, field.compile()));
    }

    #[napi]
    pub fn add_array(&mut self, key: String, field: &ArrayField) {
        self.properties.push((key, field.compile()));
    }

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

    #[napi]
    pub fn required(&mut self) {
        self.required = true;
    }

    #[napi]
    pub fn set_min(&mut self, length: f64) {
        self.min = Some(length);
    }

    #[napi]
    pub fn set_max(&mut self, length: f64) {
        self.max = Some(length);
    }

    #[napi]
    pub fn of_string(&mut self, field: &StringField) {
        self.items = Some(Box::new(field.compile()));
    }

    #[napi]
    pub fn of_number(&mut self, field: &NumberField) {
        self.items = Some(Box::new(field.compile()));
    }

    #[napi]
    pub fn of_boolean(&mut self, field: &BooleanField) {
        self.items = Some(Box::new(field.compile()));
    }

    #[napi]
    pub fn of_object(&mut self, field: &ObjectField) {
        self.items = Some(Box::new(field.compile()));
    }

    #[napi]
    pub fn of_array(&mut self, field: &ArrayField) {
        self.items = Some(Box::new(field.compile()));
    }

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
/// schema.addBodyString("name", new StringField().tap(f => f.required()))
/// schema.addBodyString("email", new StringField().tap(f => f.setPattern("email")))
/// validator.addSchemaFromBuilder("POST:/users", schema)
/// ```
#[napi]
pub struct SchemaBuilder {
    body: Vec<(String, CompiledField)>,
    query: Vec<(String, CompiledField)>,
    params: Vec<(String, CompiledField)>,
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
        }
    }

    /// Add a body field with a string schema.
    #[napi]
    pub fn add_body_string(&mut self, key: String, field: &StringField) {
        self.body.push((key, field.compile()));
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
        self.query.push((key, field.compile()));
    }

    /// Add a query parameter field with a number schema.
    #[napi]
    pub fn add_query_number(&mut self, key: String, field: &NumberField) {
        self.query.push((key, field.compile()));
    }

    /// Add a path parameter field with a string schema.
    #[napi]
    pub fn add_param_string(&mut self, key: String, field: &StringField) {
        self.params.push((key, field.compile()));
    }

    /// Add a path parameter field with a number schema.
    #[napi]
    pub fn add_param_number(&mut self, key: String, field: &NumberField) {
        self.params.push((key, field.compile()));
    }

    /// Compile to CompiledRouteSchema with pattern resolution.
    /// Called internally by Validator.addSchemaFromBuilder().
    #[allow(clippy::type_complexity)]
    pub(crate) fn compile_with_registry(
        &self,
        _registry: Option<&PatternRegistry>,
    ) -> CompiledRouteSchema {
        let compile_vec = |v: &[(String, CompiledField)]| -> Option<Box<[(Box<str>, CompiledField)]>> {
            if v.is_empty() {
                return None;
            }
            let mut props: Vec<(Box<str>, CompiledField)> = v
                .iter()
                .map(|(k, field)| (k.as_str().into(), field.clone()))
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
