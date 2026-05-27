use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;

use dashmap::DashMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum FieldDef {
    String {
        #[serde(default)]
        required: bool,
        min: Option<f64>,
        max: Option<f64>,
        pattern: Option<String>,
        #[serde(rename = "enum")]
        enum_values: Option<Vec<String>>,
        default: Option<String>,
    },
    Number {
        #[serde(default)]
        required: bool,
        min: Option<f64>,
        max: Option<f64>,
        #[serde(default)]
        int: bool,
        default: Option<f64>,
    },
    Integer {
        #[serde(default)]
        required: bool,
        min: Option<f64>,
        max: Option<f64>,
        default: Option<f64>,
    },
    Boolean {
        #[serde(default)]
        required: bool,
        default: Option<bool>,
    },
    Object {
        #[serde(default)]
        required: bool,
        properties: Option<HashMap<String, FieldDef>>,
    },
    Array {
        #[serde(default)]
        required: bool,
        items: Option<Box<FieldDef>>,
        min: Option<f64>,
        max: Option<f64>,
    },
}

/// Type alias for compiled property lists (reduces complexity).
type CompiledProperties = Box<[(Box<str>, CompiledField)]>;

/// Pre-compiled schema for fast validation (avoids repeated string matching).
#[derive(Debug, Clone)]
pub enum CompiledField {
    String {
        required: bool,
        min: Option<f64>,
        max: Option<f64>,
        pattern: Option<CompiledPattern>,
        enum_values: Option<Vec<Box<str>>>,
    },
    Number {
        required: bool,
        min: Option<f64>,
        max: Option<f64>,
        int: bool,
    },
    Integer {
        required: bool,
        min: Option<f64>,
        max: Option<f64>,
    },
    Boolean {
        required: bool,
    },
    Object {
        required: bool,
        properties: Option<CompiledProperties>,
    },
    Array {
        required: bool,
        items: Option<Box<CompiledField>>,
        min: Option<f64>,
        max: Option<f64>,
    },
}

#[derive(Debug, Clone)]
pub enum CompiledPattern {
    Email,
    Url,
    Uuid,
    Alpha,
    Alphanumeric,
    Numeric,
    Custom(String), // Reference to a custom pattern in the registry
}

/// Registry for custom validation patterns (regex-based).
pub type PatternRegistry = Arc<DashMap<String, regex::Regex>>;

/// Create a new empty pattern registry.
pub fn create_pattern_registry() -> PatternRegistry {
    Arc::new(DashMap::new())
}

/// Register a custom pattern in the registry.
pub fn register_pattern(
    registry: &PatternRegistry,
    name: &str,
    regex_pattern: &str,
) -> Result<(), String> {
    let re = regex::Regex::new(regex_pattern)
        .map_err(|e| format!("Invalid regex '{}': {}", regex_pattern, e))?;
    registry.insert(name.to_string(), re);
    Ok(())
}

impl CompiledPattern {
    #[inline]
    fn matches(&self, value: &str, registry: Option<&PatternRegistry>) -> bool {
        match self {
            CompiledPattern::Email => {
                value.len() >= 5
                    && value.as_bytes().contains(&b'@')
                    && value.as_bytes().contains(&b'.')
            }
            CompiledPattern::Url => {
                value.starts_with("http://") || value.starts_with("https://")
            }
            CompiledPattern::Uuid => {
                value.len() == 36
                    && value.as_bytes().iter().enumerate().all(|(i, &b)| {
                        b.is_ascii_digit()
                            || (b'a'..=b'f').contains(&b)
                            || (b'A'..=b'F').contains(&b)
                            || ((i == 8 || i == 13 || i == 18 || i == 23) && b == b'-')
                    })
            }
            CompiledPattern::Alpha => value.bytes().all(|b| b.is_ascii_alphabetic()),
            CompiledPattern::Alphanumeric => value.bytes().all(|b| b.is_ascii_alphanumeric()),
            CompiledPattern::Numeric => value.bytes().all(|b| b.is_ascii_digit()),
            CompiledPattern::Custom(name) => {
                if let Some(reg) = registry {
                    if let Some(re) = reg.get(name.as_str()) {
                        return re.is_match(value);
                    }
                }
                false
            }
        }
    }
}

fn compile_pattern(s: &str, registry: Option<&PatternRegistry>) -> Option<CompiledPattern> {
    match s {
        "email" => Some(CompiledPattern::Email),
        "url" => Some(CompiledPattern::Url),
        "uuid" => Some(CompiledPattern::Uuid),
        "alpha" => Some(CompiledPattern::Alpha),
        "alphanumeric" => Some(CompiledPattern::Alphanumeric),
        "numeric" => Some(CompiledPattern::Numeric),
        name => {
            // Check if it's a custom pattern in the registry
            if let Some(reg) = registry {
                if reg.contains_key(name) {
                    return Some(CompiledPattern::Custom(name.to_string()));
                }
            }
            None
        }
    }
}

fn compile_field(def: &FieldDef, registry: Option<&PatternRegistry>) -> CompiledField {
    match def {
        FieldDef::String {
            required,
            min,
            max,
            pattern,
            enum_values,
            ..
        } => CompiledField::String {
            required: *required,
            min: *min,
            max: *max,
            pattern: pattern.as_deref().and_then(|p| compile_pattern(p, registry)),
            enum_values: enum_values
                .as_ref()
                .map(|v| v.iter().map(|s| s.as_str().into()).collect()),
        },
        FieldDef::Number {
            required,
            min,
            max,
            int,
            ..
        } => CompiledField::Number {
            required: *required,
            min: *min,
            max: *max,
            int: *int,
        },
        FieldDef::Integer {
            required, min, max, ..
        } => CompiledField::Integer {
            required: *required,
            min: *min,
            max: *max,
        },
        FieldDef::Boolean { required, .. } => CompiledField::Boolean {
            required: *required,
        },
        FieldDef::Object {
            required,
            properties,
            ..
        } => {
            let props = properties.as_ref().map(|p| {
                let mut v: Vec<(Box<str>, CompiledField)> = p
                    .iter()
                    .map(|(k, v)| (k.as_str().into(), compile_field(v, registry)))
                    .collect();
                v.sort_unstable_by(|a, b| a.0.cmp(&b.0));
                v.into_boxed_slice()
            });
            CompiledField::Object {
                required: *required,
                properties: props,
            }
        }
        FieldDef::Array {
            required,
            items,
            min,
            max,
            ..
        } => CompiledField::Array {
            required: *required,
            items: items
                .as_ref()
                .map(|i| Box::new(compile_field(i, registry))),
            min: *min,
            max: *max,
        },
    }
}

impl FieldDef {
    pub fn is_required(&self) -> bool {
        match self {
            FieldDef::String { required, .. } => *required,
            FieldDef::Number { required, .. } => *required,
            FieldDef::Integer { required, .. } => *required,
            FieldDef::Boolean { required, .. } => *required,
            FieldDef::Object { required, .. } => *required,
            FieldDef::Array { required, .. } => *required,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RouteSchema {
    pub body: Option<HashMap<String, FieldDef>>,
    pub query: Option<HashMap<String, FieldDef>>,
    pub params: Option<HashMap<String, FieldDef>>,
}

/// Pre-compiled route schema for fast validation.
#[derive(Debug, Clone)]
pub struct CompiledRouteSchema {
    pub body: Option<CompiledProperties>,
    pub query: Option<CompiledProperties>,
    pub params: Option<CompiledProperties>,
}

impl CompiledRouteSchema {
    pub fn compile(schema: &RouteSchema, registry: Option<&PatternRegistry>) -> Self {
        let compile_map =
            |map: &Option<HashMap<String, FieldDef>>| -> Option<CompiledProperties> {
                map.as_ref().map(|m| {
                    let mut v: Vec<(Box<str>, CompiledField)> = m
                        .iter()
                        .map(|(k, v)| (k.as_str().into(), compile_field(v, registry)))
                        .collect();
                    v.sort_unstable_by(|a, b| a.0.cmp(&b.0));
                    v.into_boxed_slice()
                })
            };

        CompiledRouteSchema {
            body: compile_map(&schema.body),
            query: compile_map(&schema.query),
            params: compile_map(&schema.params),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ValidationError {
    pub field: String,
    pub message: String,
    pub code: String,
}

/// Reusable error buffer to avoid allocations per validation.
pub struct ErrorBuffer {
    errors: Vec<ValidationError>,
}

impl ErrorBuffer {
    #[inline]
    pub fn new() -> Self {
        ErrorBuffer {
            errors: Vec::with_capacity(4),
        }
    }

    #[inline]
    pub fn push(&mut self, field: &str, message: String, code: &'static str) {
        self.errors.push(ValidationError {
            field: field.to_string(),
            message,
            code: code.to_string(),
        });
    }

    #[inline]
    pub fn into_vec(self) -> Vec<ValidationError> {
        self.errors
    }
}

// ─── Fast validation using compiled schemas ───────────────────────────

/// Validation context to reduce argument count.
struct ValidationContext<'a> {
    min: &'a Option<f64>,
    max: &'a Option<f64>,
    pattern: &'a Option<CompiledPattern>,
    enum_values: &'a Option<Vec<Box<str>>>,
    registry: Option<&'a PatternRegistry>,
}

#[inline]
fn validate_string_fast(
    value: &[u8],
    ctx: &ValidationContext<'_>,
    err: &mut ErrorBuffer,
    field_path: &str,
) {
    let len = value.len() as f64;

    if let Some(min_val) = ctx.min {
        if len < *min_val {
            err.push(
                field_path,
                format!("String length must be >= {}, got {}", min_val, len),
                "min_length",
            );
        }
    }
    if let Some(max_val) = ctx.max {
        if len > *max_val {
            err.push(
                field_path,
                format!("String length must be <= {}, got {}", max_val, len),
                "max_length",
            );
        }
    }
    if let Some(ref pat) = ctx.pattern {
        // SAFETY: we only check ASCII bytes for patterns
        let s = unsafe { std::str::from_utf8_unchecked(value) };
        if !pat.matches(s, ctx.registry) {
            err.push(
                field_path,
                "Value does not match pattern".to_string(),
                "pattern",
            );
        }
    }
    if let Some(ref allowed) = ctx.enum_values {
        let s = unsafe { std::str::from_utf8_unchecked(value) };
        if !allowed.iter().any(|a| a.as_ref() == s) {
            err.push(
                field_path,
                "Value must be one of enum".to_string(),
                "enum",
            );
        }
    }
}

#[inline]
fn validate_number_fast(
    value: f64,
    min: &Option<f64>,
    max: &Option<f64>,
    must_be_int: bool,
    err: &mut ErrorBuffer,
    field_path: &str,
) {
    if must_be_int && value.fract() != 0.0 {
        err.push(
            field_path,
            format!("Expected integer, got {}", value),
            "integer",
        );
    }
    if let Some(min_val) = min {
        if value < *min_val {
            err.push(
                field_path,
                format!("Value must be >= {}", min_val),
                "min",
            );
        }
    }
    if let Some(max_val) = max {
        if value > *max_val {
            err.push(
                field_path,
                format!("Value must be <= {}", max_val),
                "max",
            );
        }
    }
}

fn validate_compiled_field(
    value: &serde_json::Value,
    field: &CompiledField,
    err: &mut ErrorBuffer,
    field_path: &str,
    registry: Option<&PatternRegistry>,
) {
    match field {
        CompiledField::String {
            min,
            max,
            pattern,
            enum_values,
            ..
        } => {
            if let Some(s) = value.as_str() {
                let ctx = ValidationContext {
                    min,
                    max,
                    pattern,
                    enum_values,
                    registry,
                };
                validate_string_fast(s.as_bytes(), &ctx, err, field_path);
            } else {
                err.push(field_path, "Expected string".into(), "type");
            }
        }
        CompiledField::Number {
            min, max, int, ..
        } => {
            if let Some(n) = value.as_f64() {
                validate_number_fast(n, min, max, *int, err, field_path);
            } else {
                err.push(field_path, "Expected number".into(), "type");
            }
        }
        CompiledField::Integer { min, max, .. } => {
            if let Some(n) = value.as_f64() {
                validate_number_fast(n, min, max, true, err, field_path);
            } else {
                err.push(field_path, "Expected integer".into(), "type");
            }
        }
        CompiledField::Boolean { .. } => {
            if !value.is_boolean() {
                err.push(field_path, "Expected boolean".into(), "type");
            }
        }
        CompiledField::Object { properties, .. } => {
            if !value.is_object() {
                err.push(field_path, "Expected object".into(), "type");
                return;
            }
            if let Some(props) = properties {
                let obj = value.as_object().unwrap();
                for (key, field_def) in props.iter() {
                    let child_path = format!("{}.{}", field_path, key);
                    match obj.get(key.as_ref()) {
                        None | Some(serde_json::Value::Null) => {
                            if is_required(field_def) {
                                err.push(&child_path, "Field is required".into(), "required");
                            }
                        }
                        Some(val) => {
                            validate_compiled_field(val, field_def, err, &child_path, registry);
                        }
                    }
                }
            }
        }
        CompiledField::Array {
            items, min, max, ..
        } => {
            if let Some(arr) = value.as_array() {
                let len = arr.len() as f64;
                if let Some(min_len) = min {
                    if len < *min_len {
                        err.push(
                            field_path,
                            format!("Array length must be >= {}", min_len),
                            "min_items",
                        );
                    }
                }
                if let Some(max_len) = max {
                    if len > *max_len {
                        err.push(
                            field_path,
                            format!("Array length must be <= {}", max_len),
                            "max_items",
                        );
                    }
                }
                if let Some(item_schema) = items {
                    for (i, item) in arr.iter().enumerate() {
                        let item_path = format!("{}[{}]", field_path, i);
                        validate_compiled_field(item, item_schema, err, &item_path, registry);
                    }
                }
            } else {
                err.push(field_path, "Expected array".into(), "type");
            }
        }
    }
}

#[inline]
fn is_required(field: &CompiledField) -> bool {
    match field {
        CompiledField::String { required, .. } => *required,
        CompiledField::Number { required, .. } => *required,
        CompiledField::Integer { required, .. } => *required,
        CompiledField::Boolean { required, .. } => *required,
        CompiledField::Object { required, .. } => *required,
        CompiledField::Array { required, .. } => *required,
    }
}

/// Validate a JSON value against a compiled schema. Returns errors if any.
pub fn validate_json_compiled(
    value: &serde_json::Value,
    schema: &[(Box<str>, CompiledField)],
    prefix: &str,
    registry: Option<&PatternRegistry>,
) -> Vec<ValidationError> {
    let mut err = ErrorBuffer::new();

    for (key, field_def) in schema.iter() {
        let field_path = format!("{}.{}", prefix, key);
        match value.get(key.as_ref()) {
            None | Some(serde_json::Value::Null) => {
                if is_required(field_def) {
                    err.push(&field_path, "Field is required".into(), "required");
                }
            }
            Some(val) => {
                validate_compiled_field(val, field_def, &mut err, &field_path, registry);
            }
        }
    }

    err.into_vec()
}

/// Validate query string params against compiled schema.
pub fn validate_query_compiled(
    params: &HashMap<String, String>,
    schema: &[(Box<str>, CompiledField)],
    registry: Option<&PatternRegistry>,
) -> Vec<ValidationError> {
    let mut err = ErrorBuffer::new();

    for (key, field_def) in schema.iter() {
        let field_path = format!("query.{}", key);
        match params.get(key.as_ref()) {
            None => {
                if is_required(field_def) {
                    err.push(
                        &field_path,
                        "Query parameter is required".into(),
                        "required",
                    );
                }
            }
            Some(val) => {
                validate_string_as_field_fast(val, field_def, &mut err, &field_path, registry);
            }
        }
    }

    err.into_vec()
}

#[inline]
fn validate_string_as_field_fast(
    value: &str,
    field: &CompiledField,
    err: &mut ErrorBuffer,
    field_path: &str,
    registry: Option<&PatternRegistry>,
) {
    match field {
        CompiledField::String {
            min,
            max,
            pattern,
            enum_values,
            ..
        } => {
            let ctx = ValidationContext {
                min,
                max,
                pattern,
                enum_values,
                registry,
            };
            validate_string_fast(value.as_bytes(), &ctx, err, field_path);
        }
        CompiledField::Number {
            min, max, int, ..
        } => {
            if let Ok(n) = fast_float_parse(value) {
                validate_number_fast(n, min, max, *int, err, field_path);
            } else {
                err.push(
                    field_path,
                    format!("Expected number, got '{}'", value),
                    "type",
                );
            }
        }
        CompiledField::Integer { min, max, .. } => {
            if let Ok(n) = fast_float_parse(value) {
                validate_number_fast(n, min, max, true, err, field_path);
            } else {
                err.push(
                    field_path,
                    format!("Expected integer, got '{}'", value),
                    "type",
                );
            }
        }
        CompiledField::Boolean { .. } => {
            if !matches_boolean(value) {
                err.push(
                    field_path,
                    format!("Expected boolean, got '{}'", value),
                    "type",
                );
            }
        }
        CompiledField::Object { .. } => {
            err.push(
                field_path,
                "Cannot validate object from query string".into(),
                "type",
            );
        }
        CompiledField::Array {
            items, min, max, ..
        } => {
            // Count commas to estimate array length without splitting
            let count = value.bytes().filter(|&b| b == b',').count() as f64 + 1.0;
            if let Some(min_len) = min {
                if count < *min_len {
                    err.push(
                        field_path,
                        format!("Array length must be >= {}", min_len),
                        "min_items",
                    );
                }
            }
            if let Some(max_len) = max {
                if count > *max_len {
                    err.push(
                        field_path,
                        format!("Array length must be <= {}", max_len),
                        "max_items",
                    );
                }
            }
            if let Some(item_schema) = items {
                for (i, part) in value.split(',').enumerate() {
                    let item_path = format!("{}[{}]", field_path, i);
                    validate_string_as_field_fast(
                        part.trim(),
                        item_schema,
                        err,
                        &item_path,
                        registry,
                    );
                }
            }
        }
    }
}

/// Fast float parser that avoids full `str::parse` overhead.
#[inline]
fn fast_float_parse(s: &str) -> Result<f64, ()> {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return Err(());
    }

    let mut i = 0;
    let mut negative = false;

    if bytes[0] == b'-' {
        negative = true;
        i = 1;
    } else if bytes[0] == b'+' {
        i = 1;
    }

    if i >= bytes.len() {
        return Err(());
    }

    let mut int_part: f64 = 0.0;
    let mut has_digit = false;

    while i < bytes.len() && bytes[i].is_ascii_digit() {
        int_part = int_part * 10.0 + (bytes[i] - b'0') as f64;
        has_digit = true;
        i += 1;
    }

    if !has_digit {
        return Err(());
    }

    let mut result = int_part;

    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let mut frac_part: f64 = 0.0;
        let mut frac_div: f64 = 1.0;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            frac_part = frac_part * 10.0 + (bytes[i] - b'0') as f64;
            frac_div *= 10.0;
            i += 1;
        }
        result += frac_part / frac_div;
    }

    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        return s.parse::<f64>().map_err(|_| ());
    }

    if negative {
        result = -result;
    }

    Ok(result)
}

/// Fast boolean check without allocation.
#[inline]
fn matches_boolean(s: &str) -> bool {
    matches!(
        s.as_bytes(),
        b"true" | b"false" | b"1" | b"0" | b"yes" | b"no" | b"TRUE" | b"FALSE"
    )
}
