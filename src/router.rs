use napi_derive::napi;
use std::collections::HashMap;

use crate::types::RouteMatchResult;

#[derive(Clone, Debug)]
enum Segment {
    Static(String),
    Param(String),
    Wildcard(String),
}

#[derive(Clone, Debug)]
struct Route {
    method: String,
    segments: Vec<Segment>,
    handler_id: String,
}

fn parse_segments(path: &str) -> Vec<Segment> {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(|s| {
            if let Some(name) = s.strip_prefix(':') {
                Segment::Param(name.to_string())
            } else if let Some(name) = s.strip_prefix('*') {
                let n = if name.is_empty() { "wild" } else { name };
                Segment::Wildcard(n.to_string())
            } else {
                Segment::Static(s.to_string())
            }
        })
        .collect()
}

fn match_segments<'a>(
    route_segs: &[Segment],
    path_segs: &[&'a str],
) -> Option<HashMap<String, String>> {
    // trailing slash adds empty segment — strip it
    let clean: Vec<&'a str> = if path_segs.last() == Some(&"") {
        path_segs[..path_segs.len() - 1].to_vec()
    } else {
        path_segs.to_vec()
    };

    let is_wildcard = matches!(route_segs.last(), Some(Segment::Wildcard(_)));
    if route_segs.len() != clean.len() && !is_wildcard {
        return None;
    }

    let mut params = HashMap::new();
    let mut pi = 0;

    for seg in route_segs {
        match seg {
            Segment::Static(s) => {
                if pi >= clean.len() || clean[pi] != s.as_str() {
                    return None;
                }
                pi += 1;
            }
            Segment::Param(name) => {
                if pi >= clean.len() {
                    return None;
                }
                params.insert(name.clone(), url_decode(clean[pi]));
                pi += 1;
            }
            Segment::Wildcard(name) => {
                let rest = clean[pi..].join("/");
                params.insert(name.clone(), url_decode(&rest));
                return Some(params);
            }
        }
    }

    if pi == clean.len() {
        Some(params)
    } else {
        None
    }
}

fn url_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '%' => {
                let hex: String = chars.by_ref().take(2).collect();
                if hex.len() == 2 {
                    if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                        result.push(byte as char);
                    } else {
                        result.push('%');
                        result.push_str(&hex);
                    }
                } else {
                    result.push('%');
                    result.push_str(&hex);
                }
            }
            '+' => result.push(' '),
            _ => result.push(c),
        }
    }
    result
}

#[napi]
pub struct Router {
    routes: Vec<Route>,
}

#[napi]
impl Router {
    #[napi(constructor)]
    pub fn new() -> Self {
        Router { routes: Vec::new() }
    }

    #[napi]
    pub fn add_route(&mut self, method: String, path: String, handler_id: String) {
        let segments = parse_segments(&path);
        self.routes.push(Route {
            method: method.to_uppercase(),
            segments,
            handler_id,
        });
    }

    #[napi]
    pub fn get(&mut self, path: String, handler_id: String) {
        self.add_route("GET".to_string(), path, handler_id);
    }

    #[napi]
    pub fn post(&mut self, path: String, handler_id: String) {
        self.add_route("POST".to_string(), path, handler_id);
    }

    #[napi]
    pub fn put(&mut self, path: String, handler_id: String) {
        self.add_route("PUT".to_string(), path, handler_id);
    }

    #[napi]
    pub fn delete(&mut self, path: String, handler_id: String) {
        self.add_route("DELETE".to_string(), path, handler_id);
    }

    #[napi]
    pub fn patch(&mut self, path: String, handler_id: String) {
        self.add_route("PATCH".to_string(), path, handler_id);
    }

    #[napi]
    pub fn options(&mut self, path: String, handler_id: String) {
        self.add_route("OPTIONS".to_string(), path, handler_id);
    }

    #[napi]
    pub fn head(&mut self, path: String, handler_id: String) {
        self.add_route("HEAD".to_string(), path, handler_id);
    }

    #[napi]
    pub fn any(&mut self, path: String, handler_id: String) {
        self.add_route("*".to_string(), path, handler_id);
    }

    #[napi]
    pub fn match_route(&self, method: String, path: String) -> Option<RouteMatchResult> {
        let clean_path = path.split('?').next().unwrap_or(&path);
        let path_segs: Vec<&str> = clean_path.split('/').filter(|s| !s.is_empty()).collect();
        let method_upper = method.to_uppercase();

        for route in &self.routes {
            if route.method != method_upper && route.method != "*" {
                continue;
            }
            if let Some(params) = match_segments(&route.segments, &path_segs) {
                return Some(RouteMatchResult {
                    handler_id: route.handler_id.clone(),
                    params,
                });
            }
        }
        None
    }

    #[napi]
    pub fn match_all(&self, method: String, path: String) -> Vec<RouteMatchResult> {
        let clean_path = path.split('?').next().unwrap_or(&path);
        let path_segs: Vec<&str> = clean_path.split('/').filter(|s| !s.is_empty()).collect();
        let method_upper = method.to_uppercase();
        let mut results = Vec::new();

        for route in &self.routes {
            if route.method != method_upper && route.method != "*" {
                continue;
            }
            if let Some(params) = match_segments(&route.segments, &path_segs) {
                results.push(RouteMatchResult {
                    handler_id: route.handler_id.clone(),
                    params,
                });
            }
        }
        results
    }

    #[napi]
    pub fn route_count(&self) -> u32 {
        self.routes.len() as u32
    }

    #[napi]
    pub fn clear(&mut self) {
        self.routes.clear();
    }

    #[napi]
    pub fn remove_route(&mut self, method: String, path: String) -> bool {
        let segments = parse_segments(&path);
        let method_upper = method.to_uppercase();
        let before = self.routes.len();
        self.routes.retain(|r| {
            !(r.method == method_upper && format!("{:?}", r.segments) == format!("{:?}", segments))
        });
        self.routes.len() < before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_static_route() {
        let mut router = Router::new();
        router.get("/users".to_string(), "listUsers".to_string());

        let m = router.match_route("GET".to_string(), "/users".to_string());
        assert!(m.is_some());
        assert_eq!(m.unwrap().handler_id, "listUsers");

        let m = router.match_route("GET".to_string(), "/other".to_string());
        assert!(m.is_none());
    }

    #[test]
    fn test_param_route() {
        let mut router = Router::new();
        router.get("/users/:id".to_string(), "getUser".to_string());

        let m = router.match_route("GET".to_string(), "/users/123".to_string());
        assert!(m.is_some());
        let m = m.unwrap();
        assert_eq!(m.handler_id, "getUser");
        assert_eq!(m.params.get("id").unwrap(), "123");
    }

    #[test]
    fn test_wildcard_route() {
        let mut router = Router::new();
        router.get("/files/*path".to_string(), "serveFile".to_string());

        let m = router.match_route("GET".to_string(), "/files/a/b/c.txt".to_string());
        assert!(m.is_some());
        let m = m.unwrap();
        assert_eq!(m.handler_id, "serveFile");
        assert_eq!(m.params.get("path").unwrap(), "a/b/c.txt");
    }

    #[test]
    fn test_method_filtering() {
        let mut router = Router::new();
        router.get("/test".to_string(), "getHandler".to_string());
        router.post("/test".to_string(), "postHandler".to_string());

        let m = router.match_route("GET".to_string(), "/test".to_string());
        assert_eq!(m.unwrap().handler_id, "getHandler");

        let m = router.match_route("POST".to_string(), "/test".to_string());
        assert_eq!(m.unwrap().handler_id, "postHandler");
    }

    #[test]
    fn test_any_method() {
        let mut router = Router::new();
        router.any("/all".to_string(), "anyHandler".to_string());

        assert!(router.match_route("GET".to_string(), "/all".to_string()).is_some());
        assert!(router.match_route("POST".to_string(), "/all".to_string()).is_some());
        assert!(router.match_route("DELETE".to_string(), "/all".to_string()).is_some());
    }
}
