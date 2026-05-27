use std::collections::HashMap;

use dashmap::DashMap;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::schema::{validate_json_value, validate_query_string, RouteSchema, ValidationError};

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
    pub fn ok(data: Option<serde_json::Value>) -> Self {
        let data_str = data.and_then(|v| serde_json::to_string(&v).ok());
        ValidationResult {
            success: true,
            errors: None,
            data: data_str,
        }
    }

    pub fn fail(errors: Vec<ValidationError>) -> Self {
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

pub type ValidatorSchemas = std::sync::Arc<DashMap<String, RouteSchema>>;

#[napi]
pub struct Validator {
    schemas: ValidatorSchemas,
}

#[napi]
impl Validator {
    #[napi(constructor)]
    pub fn new() -> Self {
        Validator {
            schemas: std::sync::Arc::new(DashMap::new()),
        }
    }

    /// Register a validation schema for a route.
    /// route_key format: "METHOD:/path" (e.g. "POST:/users")
    /// schema_json: JSON string with { body?, query?, params? } definitions
    #[napi]
    pub fn add_schema(&self, route_key: String, schema_json: String) -> Result<()> {
        let schema: RouteSchema = serde_json::from_str(&schema_json)
            .map_err(|e| Error::from_reason(format!("Invalid schema JSON: {}", e)))?;
        self.schemas.insert(route_key, schema);
        Ok(())
    }

    /// Validate a JSON body string against the registered schema.
    /// Returns validated data as JSON string on success.
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

        let errors = validate_json_value(&body_value, body_schema, "body");
        if errors.is_empty() {
            ValidationResult::ok(Some(body_value))
        } else {
            ValidationResult::fail(errors)
        }
    }

    /// Validate a pre-serialized JSON body value (from Rust body parsing).
    /// body_json: the body as a JSON string (already parsed by Rust)
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

        let errors = validate_query_string(&query, query_schema);
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

        let errors = validate_query_string(&params, params_schema);
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
    pub fn get_schemas(&self) -> ValidatorSchemas {
        self.schemas.clone()
    }
}
