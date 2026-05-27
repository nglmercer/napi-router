use serde::Deserialize;
use std::collections::HashMap;

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

#[derive(Debug, Clone)]
pub struct ValidationError {
    pub field: String,
    pub message: String,
    pub code: String,
}

pub fn validate_json_value(
    value: &serde_json::Value,
    schema: &HashMap<String, FieldDef>,
    prefix: &str,
) -> Vec<ValidationError> {
    let mut errors = Vec::new();

    for (key, field_def) in schema {
        let field_path = format!("{}.{}", prefix, key);
        let field_value = value.get(key);

        match field_value {
            None | Some(serde_json::Value::Null) => {
                if field_def.is_required() {
                    errors.push(ValidationError {
                        field: field_path,
                        message: "Field is required".to_string(),
                        code: "required".to_string(),
                    });
                }
            }
            Some(val) => {
                validate_field(val, field_def, &field_path, &mut errors);
            }
        }
    }

    errors
}

pub fn validate_string_field(
    value: &str,
    min: &Option<f64>,
    max: &Option<f64>,
    pattern: &Option<String>,
    enum_values: &Option<Vec<String>>,
    field_path: &str,
    errors: &mut Vec<ValidationError>,
) {
    let len = value.len() as f64;

    if let Some(min_val) = min {
        if len < *min_val {
            errors.push(ValidationError {
                field: field_path.to_string(),
                message: format!("String length must be >= {}, got {}", min_val, len),
                code: "min_length".to_string(),
            });
        }
    }
    if let Some(max_val) = max {
        if len > *max_val {
            errors.push(ValidationError {
                field: field_path.to_string(),
                message: format!("String length must be <= {}, got {}", max_val, len),
                code: "max_length".to_string(),
            });
        }
    }
    if let Some(ref pat) = pattern {
        if !matches_pattern(value, pat) {
            errors.push(ValidationError {
                field: field_path.to_string(),
                message: format!("Value does not match pattern: {}", pat),
                code: "pattern".to_string(),
            });
        }
    }
    if let Some(ref allowed) = enum_values {
        if !allowed.iter().any(|a| a == value) {
            errors.push(ValidationError {
                field: field_path.to_string(),
                message: format!("Value must be one of: {:?}", allowed),
                code: "enum".to_string(),
            });
        }
    }
}

pub fn validate_number_field(
    value: f64,
    min: &Option<f64>,
    max: &Option<f64>,
    must_be_int: bool,
    field_path: &str,
    errors: &mut Vec<ValidationError>,
) {
    if must_be_int && value.fract() != 0.0 {
        errors.push(ValidationError {
            field: field_path.to_string(),
            message: format!("Expected integer, got {}", value),
            code: "integer".to_string(),
        });
    }
    if let Some(min_val) = min {
        if value < *min_val {
            errors.push(ValidationError {
                field: field_path.to_string(),
                message: format!("Value must be >= {}, got {}", min_val, value),
                code: "min".to_string(),
            });
        }
    }
    if let Some(max_val) = max {
        if value > *max_val {
            errors.push(ValidationError {
                field: field_path.to_string(),
                message: format!("Value must be <= {}, got {}", max_val, value),
                code: "max".to_string(),
            });
        }
    }
}

fn validate_field(
    value: &serde_json::Value,
    field_def: &FieldDef,
    field_path: &str,
    errors: &mut Vec<ValidationError>,
) {
    match field_def {
        FieldDef::String {
            min,
            max,
            pattern,
            enum_values,
            ..
        } => {
            if let Some(s) = value.as_str() {
                validate_string_field(s, min, max, pattern, enum_values, field_path, errors);
            } else {
                errors.push(ValidationError {
                    field: field_path.to_string(),
                    message: "Expected string".to_string(),
                    code: "type".to_string(),
                });
            }
        }
        FieldDef::Number {
            min, max, int, ..
        } => {
            if let Some(n) = value.as_f64() {
                validate_number_field(n, min, max, *int, field_path, errors);
            } else {
                errors.push(ValidationError {
                    field: field_path.to_string(),
                    message: "Expected number".to_string(),
                    code: "type".to_string(),
                });
            }
        }
        FieldDef::Integer { min, max, .. } => {
            if let Some(n) = value.as_f64() {
                validate_number_field(n, min, max, true, field_path, errors);
            } else {
                errors.push(ValidationError {
                    field: field_path.to_string(),
                    message: "Expected integer".to_string(),
                    code: "type".to_string(),
                });
            }
        }
        FieldDef::Boolean { .. } => {
            if !value.is_boolean() {
                errors.push(ValidationError {
                    field: field_path.to_string(),
                    message: "Expected boolean".to_string(),
                    code: "type".to_string(),
                });
            }
        }
        FieldDef::Object { properties, .. } => {
            if !value.is_object() {
                errors.push(ValidationError {
                    field: field_path.to_string(),
                    message: "Expected object".to_string(),
                    code: "type".to_string(),
                });
                return;
            }
            if let Some(props) = properties {
                let nested = validate_json_value(value, props, field_path);
                errors.extend(nested);
            }
        }
        FieldDef::Array {
            items, min, max, ..
        } => {
            if let Some(arr) = value.as_array() {
                let len = arr.len() as f64;
                if let Some(min_len) = min {
                    if len < *min_len {
                        errors.push(ValidationError {
                            field: field_path.to_string(),
                            message: format!("Array length must be >= {}, got {}", min_len, len),
                            code: "min_items".to_string(),
                        });
                    }
                }
                if let Some(max_len) = max {
                    if len > *max_len {
                        errors.push(ValidationError {
                            field: field_path.to_string(),
                            message: format!(
                                "Array length must be <= {}, got {}",
                                max_len, len
                            ),
                            code: "max_items".to_string(),
                        });
                    }
                }
                if let Some(item_schema) = items {
                    for (i, item) in arr.iter().enumerate() {
                        let item_path = format!("{}[{}]", field_path, i);
                        validate_field(item, item_schema, &item_path, errors);
                    }
                }
            } else {
                errors.push(ValidationError {
                    field: field_path.to_string(),
                    message: "Expected array".to_string(),
                    code: "type".to_string(),
                });
            }
        }
    }
}

pub fn validate_query_string(
    params: &HashMap<String, String>,
    schema: &HashMap<String, FieldDef>,
) -> Vec<ValidationError> {
    let mut errors = Vec::new();

    for (key, field_def) in schema {
        let field_path = format!("query.{}", key);
        let param_value = params.get(key);

        match param_value {
            None => {
                if field_def.is_required() {
                    errors.push(ValidationError {
                        field: field_path,
                        message: "Query parameter is required".to_string(),
                        code: "required".to_string(),
                    });
                }
            }
            Some(val) => {
                validate_string_as_field(val, field_def, &field_path, &mut errors);
            }
        }
    }

    errors
}

fn validate_string_as_field(
    value: &str,
    field_def: &FieldDef,
    field_path: &str,
    errors: &mut Vec<ValidationError>,
) {
    match field_def {
        FieldDef::String {
            min,
            max,
            pattern,
            enum_values,
            ..
        } => {
            validate_string_field(value, min, max, pattern, enum_values, field_path, errors);
        }
        FieldDef::Number {
            min, max, int, ..
        } => {
            match value.parse::<f64>() {
                Ok(n) => validate_number_field(n, min, max, *int, field_path, errors),
                Err(_) => errors.push(ValidationError {
                    field: field_path.to_string(),
                    message: format!("Expected number, got '{}'", value),
                    code: "type".to_string(),
                }),
            }
        }
        FieldDef::Integer { min, max, .. } => {
            match value.parse::<f64>() {
                Ok(n) => validate_number_field(n, min, max, true, field_path, errors),
                Err(_) => errors.push(ValidationError {
                    field: field_path.to_string(),
                    message: format!("Expected integer, got '{}'", value),
                    code: "type".to_string(),
                }),
            }
        }
        FieldDef::Boolean { .. } => {
            let lower = value.to_lowercase();
            if lower != "true"
                && lower != "false"
                && lower != "1"
                && lower != "0"
                && lower != "yes"
                && lower != "no"
            {
                errors.push(ValidationError {
                    field: field_path.to_string(),
                    message: format!("Expected boolean, got '{}'", value),
                    code: "type".to_string(),
                });
            }
        }
        FieldDef::Object { .. } => {
            errors.push(ValidationError {
                field: field_path.to_string(),
                message: "Cannot validate object from query string".to_string(),
                code: "type".to_string(),
            });
        }
        FieldDef::Array {
            items, min, max, ..
        } => {
            let parts: Vec<&str> = value.split(',').collect();
            let len = parts.len() as f64;
            if let Some(min_len) = min {
                if len < *min_len {
                    errors.push(ValidationError {
                        field: field_path.to_string(),
                        message: format!("Array length must be >= {}, got {}", min_len, len),
                        code: "min_items".to_string(),
                    });
                }
            }
            if let Some(max_len) = max {
                if len > *max_len {
                    errors.push(ValidationError {
                        field: field_path.to_string(),
                        message: format!("Array length must be <= {}, got {}", max_len, len),
                        code: "max_items".to_string(),
                    });
                }
            }
            if let Some(item_schema) = items {
                for (i, part) in parts.iter().enumerate() {
                    let item_path = format!("{}[{}]", field_path, i);
                    validate_string_as_field(part.trim(), item_schema, &item_path, errors);
                }
            }
        }
    }
}

fn matches_pattern(value: &str, pattern: &str) -> bool {
    match pattern.as_ref() {
        "email" => {
            value.contains('@') && value.contains('.') && value.len() >= 5
        }
        "url" => value.starts_with("http://") || value.starts_with("https://"),
        "uuid" => {
            value.len() == 36
                && value.chars().enumerate().all(|(i, c)| {
                    matches!(c, '0'..='9' | 'a'..='f' | 'A'..='F')
                        || (i == 8 || i == 13 || i == 18 || i == 23) && c == '-'
                })
        }
        "alpha" => value.chars().all(|c| c.is_ascii_alphabetic()),
        "alphanumeric" => value.chars().all(|c| c.is_ascii_alphanumeric()),
        "numeric" => value.chars().all(|c| c.is_ascii_digit()),
        _ => true,
    }
}
