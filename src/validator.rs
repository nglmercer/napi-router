use std::collections::HashMap;
use std::sync::Arc;

use dashmap::DashMap;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::schema::{
    validate_json_compiled, validate_query_compiled, CompiledRouteSchema, RouteSchema,
    ValidationError,
};

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ValidationErr {
    pub field: String,
    pub message: String,
    pub code: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ValidationResult {
    pub success: bool,
    pub errors: Option<Vec<ValidationErr>>,
    /// Serialized validated data (JSON string). Null if validation failed or no data.
    pub data: Option<String>,
}

impl ValidationResult {
    #[inline]
    fn ok(data: Option<String>) -> Self {
        ValidationResult {
            success: true,
            errors: None,
            data,
        }
    }

    #[inline]
    fn fail(errors: Vec<ValidationError>) -> Self {
        ValidationResult {
            success: false,
            errors: Some(
                errors
                    .into_iter()
                    .map(|e| ValidationErr {
                        field: e.field,
                        message: e.message,
                        code: e.code,
                    })
                    .collect(),
            ),
            data: None,
        }
    }
}

/// Schema store using DashMap for concurrent access.
/// Schemas are registered once at startup and read many times.
pub type SchemaStore = Arc<DashMap<String, CompiledRouteSchema>>;

#[napi]
pub struct Validator {
    schemas: SchemaStore,
}

#[napi]
impl Validator {
    #[napi(constructor)]
    pub fn new() -> Self {
        Validator {
            schemas: Arc::new(DashMap::new()),
        }
    }

    /// Register a validation schema for a route.
    /// route_key format: "METHOD:/path" (e.g. "POST:/users")
    /// schema_json: JSON string with { body?, query?, params? } definitions
    #[napi]
    pub fn add_schema(&self, route_key: String, schema_json: String) -> Result<()> {
        let raw: RouteSchema = serde_json::from_str(&schema_json)
            .map_err(|e| Error::from_reason(format!("Invalid schema JSON: {}", e)))?;
        let compiled = CompiledRouteSchema::compile(&raw);
        self.schemas.insert(route_key, compiled);
        Ok(())
    }

    /// Validate a JSON body string against the registered schema.
    /// Parses JSON in Rust (from string) and validates against compiled schema.
    #[napi]
    pub fn validate_body(&self, route_key: String, body_json: String) -> ValidationResult {
        let schema_ref = self.schemas.get(&route_key);
        let schema = match schema_ref {
            Some(s) => s,
            None => return ValidationResult::ok(None),
        };
        let body_schema = match &schema.body {
            Some(s) => s,
            None => return ValidationResult::ok(None),
        };

        let body_value: serde_json::Value = match serde_json::from_str(&body_json) {
            Ok(v) => v,
            Err(e) => {
                return ValidationResult::fail(vec![ValidationError {
                    field: "body".to_string(),
                    message: format!("Invalid JSON: {}", e),
                    code: "invalid_json".to_string(),
                }]);
            }
        };

        let errors = validate_json_compiled(&body_value, body_schema, "body");
        if errors.is_empty() {
            ValidationResult::ok(Some(body_json))
        } else {
            ValidationResult::fail(errors)
        }
    }

    /// Validate a JSON body from raw bytes (zero-copy). Avoids string conversion.
    /// This is the fastest path — parses directly from Uint8Array/Buffer.
    #[napi]
    pub fn validate_body_bytes(&self, route_key: String, body: Buffer) -> ValidationResult {
        let schema_ref = self.schemas.get(&route_key);
        let schema = match schema_ref {
            Some(s) => s,
            None => return ValidationResult::ok(None),
        };
        let body_schema = match &schema.body {
            Some(s) => s,
            None => return ValidationResult::ok(None),
        };

        let body_value: serde_json::Value = match serde_json::from_slice(body.as_ref()) {
            Ok(v) => v,
            Err(e) => {
                return ValidationResult::fail(vec![ValidationError {
                    field: "body".to_string(),
                    message: format!("Invalid JSON: {}", e),
                    code: "invalid_json".to_string(),
                }]);
            }
        };

        let errors = validate_json_compiled(&body_value, body_schema, "body");
        if errors.is_empty() {
            // Return the original JSON string for downstream use
            let data = unsafe { String::from_utf8_unchecked(body.to_vec()) };
            ValidationResult::ok(Some(data))
        } else {
            ValidationResult::fail(errors)
        }
    }

    /// Validate a pre-serialized JSON body value (string).
    /// Alias for validate_body — accepts the body as a JSON string.
    #[napi]
    pub fn validate_body_value(&self, route_key: String, body_json: String) -> ValidationResult {
        self.validate_body(route_key, body_json)
    }

    /// Validate query parameters against the registered schema.
    #[napi]
    pub fn validate_query(
        &self,
        route_key: String,
        query: HashMap<String, String>,
    ) -> ValidationResult {
        let schema_ref = self.schemas.get(&route_key);
        let schema = match schema_ref {
            Some(s) => s,
            None => return ValidationResult::ok(None),
        };
        let query_schema = match &schema.query {
            Some(s) => s,
            None => return ValidationResult::ok(None),
        };

        let errors = validate_query_compiled(&query, query_schema);
        if errors.is_empty() {
            ValidationResult::ok(None)
        } else {
            ValidationResult::fail(errors)
        }
    }

    /// Validate path parameters against the registered schema.
    #[napi]
    pub fn validate_params(
        &self,
        route_key: String,
        params: HashMap<String, String>,
    ) -> ValidationResult {
        let schema_ref = self.schemas.get(&route_key);
        let schema = match schema_ref {
            Some(s) => s,
            None => return ValidationResult::ok(None),
        };
        let params_schema = match &schema.params {
            Some(s) => s,
            None => return ValidationResult::ok(None),
        };

        let errors = validate_query_compiled(&params, params_schema);
        if errors.is_empty() {
            ValidationResult::ok(None)
        } else {
            ValidationResult::fail(errors)
        }
    }

    /// Check if a schema exists for a route.
    #[napi]
    pub fn has_schema(&self, route_key: String) -> bool {
        self.schemas.contains_key(&route_key)
    }

    /// Remove a schema for a route.
    #[napi]
    pub fn remove_schema(&self, route_key: String) -> bool {
        self.schemas.remove(&route_key).is_some()
    }

    /// Clear all schemas.
    #[napi]
    pub fn clear(&self) {
        self.schemas.clear();
    }

    /// Get the number of registered schemas.
    #[napi]
    pub fn schema_count(&self) -> u32 {
        self.schemas.len() as u32
    }

    /// Get the internal schemas reference for use by HttpServer.
    pub fn get_schemas(&self) -> SchemaStore {
        self.schemas.clone()
    }
}
