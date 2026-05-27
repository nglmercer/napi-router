use std::collections::HashMap;

use napi_derive::napi;

use crate::schema::{FieldDef, RouteSchema};

// ─── Field Schema Builder (NAPI-exposed) ─────────────────────────────

/// String field builder with fluent API.
#[napi]
pub struct StringField {
    pub(crate) required: bool,
    pub(crate) min: Option<f64>,
    pub(crate) max: Option<f64>,
    pub(crate) pattern: Option<String>,
    pub(crate) enum_values: Option<Vec<String>>,
    pub(crate) default: Option<String>,
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
            default: None,
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

    /// Set default value.
    #[napi]
    pub fn set_default(&mut self, value: String) {
        self.default = Some(value);
    }

    /// Convert to FieldDef (internal).
    pub(crate) fn to_field_def(&self) -> FieldDef {
        FieldDef::String {
            required: self.required,
            min: self.min,
            max: self.max,
            pattern: self.pattern.clone(),
            enum_values: self.enum_values.clone(),
            default: self.default.clone(),
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
    pub(crate) default: Option<f64>,
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
            default: None,
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

    /// Set default value.
    #[napi]
    pub fn set_default(&mut self, value: f64) {
        self.default = Some(value);
    }

    /// Convert to FieldDef (internal).
    pub(crate) fn to_field_def(&self) -> FieldDef {
        if self.is_integer {
            FieldDef::Integer {
                required: self.required,
                min: self.min,
                max: self.max,
                default: self.default,
            }
        } else {
            FieldDef::Number {
                required: self.required,
                min: self.min,
                max: self.max,
                int: false,
                default: self.default,
            }
        }
    }
}

/// Boolean field builder with fluent API.
#[napi]
pub struct BooleanField {
    pub(crate) required: bool,
    pub(crate) default: Option<bool>,
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
        BooleanField {
            required: false,
            default: None,
        }
    }

    /// Mark field as required.
    #[napi]
    pub fn required(&mut self) {
        self.required = true;
    }

    /// Set default value.
    #[napi]
    pub fn set_default(&mut self, value: bool) {
        self.default = Some(value);
    }

    /// Convert to FieldDef (internal).
    pub(crate) fn to_field_def(&self) -> FieldDef {
        FieldDef::Boolean {
            required: self.required,
            default: self.default,
        }
    }
}

/// Object field builder with fluent API.
#[napi]
pub struct ObjectField {
    pub(crate) required: bool,
    pub(crate) properties: HashMap<String, FieldDef>,
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
            properties: HashMap::new(),
        }
    }

    /// Mark field as required.
    #[napi]
    pub fn required(&mut self) {
        self.required = true;
    }

    /// Add a string property.
    #[napi]
    pub fn add_string(&mut self, key: String, field: &StringField) {
        self.properties.insert(key, field.to_field_def());
    }

    /// Add a number property.
    #[napi]
    pub fn add_number(&mut self, key: String, field: &NumberField) {
        self.properties.insert(key, field.to_field_def());
    }

    /// Add a boolean property.
    #[napi]
    pub fn add_boolean(&mut self, key: String, field: &BooleanField) {
        self.properties.insert(key, field.to_field_def());
    }

    /// Add an object property.
    #[napi]
    pub fn add_object(&mut self, key: String, field: &ObjectField) {
        self.properties.insert(key, field.to_field_def());
    }

    /// Add an array property.
    #[napi]
    pub fn add_array(&mut self, key: String, field: &ArrayField) {
        self.properties.insert(key, field.to_field_def());
    }

    /// Convert to FieldDef (internal).
    pub(crate) fn to_field_def(&self) -> FieldDef {
        FieldDef::Object {
            required: self.required,
            properties: Some(self.properties.clone()),
        }
    }
}

/// Array field builder with fluent API.
#[napi]
pub struct ArrayField {
    pub(crate) required: bool,
    pub(crate) items: Option<Box<FieldDef>>,
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
    pub fn of_string(&mut self, field: &StringField) {
        self.items = Some(Box::new(field.to_field_def()));
    }

    /// Set item type as number.
    #[napi]
    pub fn of_number(&mut self, field: &NumberField) {
        self.items = Some(Box::new(field.to_field_def()));
    }

    /// Set item type as boolean.
    #[napi]
    pub fn of_boolean(&mut self, field: &BooleanField) {
        self.items = Some(Box::new(field.to_field_def()));
    }

    /// Set item type as object.
    #[napi]
    pub fn of_object(&mut self, field: &ObjectField) {
        self.items = Some(Box::new(field.to_field_def()));
    }

    /// Set item type as array (nested).
    #[napi]
    pub fn of_array(&mut self, field: &ArrayField) {
        self.items = Some(Box::new(field.to_field_def()));
    }

    /// Convert to FieldDef (internal).
    pub(crate) fn to_field_def(&self) -> FieldDef {
        FieldDef::Array {
            required: self.required,
            items: self.items.clone(),
            min: self.min,
            max: self.max,
        }
    }
}

// ─── Schema Builder (replaces the `s` factory + schema definition) ───

/// Schema builder for defining validation rules for a route.
/// Rust-native builder — no JSON serialization needed.
///
/// @example
/// ```ts
/// const nameField = new StringField()
/// nameField.required()
/// nameField.setMin(2)
/// nameField.setMax(100)
///
/// const emailField = new StringField()
/// emailField.required()
/// emailField.setPattern("email")
///
/// const schema = new SchemaBuilder()
/// schema.addBodyString("name", nameField)
/// schema.addBodyString("email", emailField)
/// schema.addQueryNumber("page", new NumberField())
///
/// validator.addSchemaFromBuilder("POST:/users", schema)
/// ```
#[napi]
pub struct SchemaBuilder {
    body: HashMap<String, FieldDef>,
    query: HashMap<String, FieldDef>,
    params: HashMap<String, FieldDef>,
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
            body: HashMap::new(),
            query: HashMap::new(),
            params: HashMap::new(),
        }
    }

    /// Add a body field with a string schema.
    #[napi]
    pub fn add_body_string(&mut self, key: String, field: &StringField) {
        self.body.insert(key, field.to_field_def());
    }

    /// Add a body field with a number schema.
    #[napi]
    pub fn add_body_number(&mut self, key: String, field: &NumberField) {
        self.body.insert(key, field.to_field_def());
    }

    /// Add a body field with a boolean schema.
    #[napi]
    pub fn add_body_boolean(&mut self, key: String, field: &BooleanField) {
        self.body.insert(key, field.to_field_def());
    }

    /// Add a body field with an object schema.
    #[napi]
    pub fn add_body_object(&mut self, key: String, field: &ObjectField) {
        self.body.insert(key, field.to_field_def());
    }

    /// Add a body field with an array schema.
    #[napi]
    pub fn add_body_array(&mut self, key: String, field: &ArrayField) {
        self.body.insert(key, field.to_field_def());
    }

    /// Add a query parameter field with a string schema.
    #[napi]
    pub fn add_query_string(&mut self, key: String, field: &StringField) {
        self.query.insert(key, field.to_field_def());
    }

    /// Add a query parameter field with a number schema.
    #[napi]
    pub fn add_query_number(&mut self, key: String, field: &NumberField) {
        self.query.insert(key, field.to_field_def());
    }

    /// Add a path parameter field with a string schema.
    #[napi]
    pub fn add_param_string(&mut self, key: String, field: &StringField) {
        self.params.insert(key, field.to_field_def());
    }

    /// Add a path parameter field with a number schema.
    #[napi]
    pub fn add_param_number(&mut self, key: String, field: &NumberField) {
        self.params.insert(key, field.to_field_def());
    }

    /// Build the RouteSchema (internal).
    pub(crate) fn build(&self) -> RouteSchema {
        RouteSchema {
            body: if self.body.is_empty() {
                None
            } else {
                Some(self.body.clone())
            },
            query: if self.query.is_empty() {
                None
            } else {
                Some(self.query.clone())
            },
            params: if self.params.is_empty() {
                None
            } else {
                Some(self.params.clone())
            },
        }
    }
}
