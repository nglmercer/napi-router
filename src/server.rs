use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use dashmap::DashMap;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{HeaderMap, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use napi::bindgen_prelude::{Buffer, Error, Result};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Status, Unknown};
use napi_derive::napi;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::{AbortHandle, JoinHandle};

use crate::native_response::NativeResponse;
use crate::types::*;
use crate::validator::ValidatorSchemas;
use crate::websocket;

type RequestTsfn =
    ThreadsafeFunction<RequestData, Unknown<'static>, RequestData, Status, false, false, 0>;
type WsEventTsfn = ThreadsafeFunction<WsEvent, Unknown<'static>, WsEvent, Status, false, false, 0>;

struct ServerInner {
    on_request: RwLock<Option<Arc<RequestTsfn>>>,
    on_ws_event: RwLock<Option<Arc<WsEventTsfn>>>,
    pending: DashMap<u32, oneshot::Sender<ResponseData>>,
    request_addrs: DashMap<u32, String>,
    upgraded_requests: DashMap<u32, (String, String)>,
    ws_senders: websocket::WsSenders,
    ws_subscriptions: DashMap<String, HashSet<String>>,
    ws_topics: DashMap<String, HashSet<String>>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    accept_task: Mutex<Option<JoinHandle<()>>>,
    conn_counter: AtomicU64,
    conn_abort_handles: DashMap<u64, AbortHandle>,
    listen_port: AtomicU16,
    listen_addr: RwLock<Option<String>>,
    validator_schemas: RwLock<Option<ValidatorSchemas>>,
    auto_validate: std::sync::atomic::AtomicBool,
}

type Mutex<T> = parking_lot::Mutex<T>;
type RwLock<T> = parking_lot::RwLock<T>;

const MAX_BODY_SIZE: usize = 10 * 1024 * 1024; // 10 MB

#[napi]
pub struct HttpServer {
    inner: Arc<ServerInner>,
}

impl Default for HttpServer {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl HttpServer {
    #[napi(constructor)]
    pub fn new() -> Self {
        const PENDING_SHARDS: usize = 16;
        HttpServer {
            inner: Arc::new(ServerInner {
                on_request: RwLock::new(None),
                on_ws_event: RwLock::new(None),
                pending: DashMap::with_capacity_and_shard_amount(1024, PENDING_SHARDS),
                request_addrs: DashMap::with_capacity_and_shard_amount(1024, PENDING_SHARDS),
                upgraded_requests: DashMap::new(),
                ws_senders: Arc::new(DashMap::new()),
                ws_subscriptions: DashMap::new(),
                ws_topics: DashMap::new(),
                shutdown_tx: parking_lot::Mutex::new(None),
                accept_task: parking_lot::Mutex::new(None),
                conn_counter: AtomicU64::new(1),
                conn_abort_handles: DashMap::new(),
                listen_port: AtomicU16::new(0),
                listen_addr: RwLock::new(None),
                validator_schemas: RwLock::new(None),
                auto_validate: std::sync::atomic::AtomicBool::new(false),
            }),
        }
    }

    /// Set a Validator instance for automatic request validation.
    /// When set, the server will validate body/query/params before calling JS.
    #[napi]
    pub fn set_validator(&self, validator: &crate::validator::Validator) {
        *self.inner.validator_schemas.write() = Some(validator.get_schemas());
    }

    /// Enable/disable automatic validation before JS callback.
    #[napi]
    pub fn set_auto_validate(&self, enabled: bool) {
        self.inner
            .auto_validate
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
    }

    #[napi(ts_args_type = "callback: (data: RequestData) => void")]
    pub fn on_request(&self, callback: RequestTsfn) -> napi::Result<()> {
        *self.inner.on_request.write() = Some(Arc::new(callback));
        Ok(())
    }

    #[napi(ts_args_type = "callback: (event: WsEvent) => void")]
    pub fn on_ws_event(&self, callback: WsEventTsfn) -> Result<()> {
        *self.inner.on_ws_event.write() = Some(Arc::new(callback));
        Ok(())
    }

    #[napi]
    pub async fn listen(&self, port: u16, hostname: Option<String>) -> Result<ServerInfo> {
        let host = hostname.clone().unwrap_or_else(|| "0.0.0.0".into());
        let addr: SocketAddr = match format!("{}:{}", host, port).parse() {
            Ok(a) => a,
            Err(e) => {
                return Err(Error::from_reason(format!("Invalid address: {}", e)));
            }
        };
        let listener = match create_reusable_listener(addr).await {
            Ok(l) => l,
            Err(e) => {
                let err_msg = if e.to_string().contains("Address already in use") {
                    format!(
                        "Port {} is already in use. Please use a different port.",
                        port
                    )
                } else {
                    format!("Failed to bind to {}:{}: {}", host, port, e)
                };
                return Err(Error::from_reason(err_msg));
            }
        };
        let local_addr = listener
            .local_addr()
            .map_err(|e| Error::from_reason(format!("Failed to get local addr: {}", e)))?;

        let state = self.inner.clone();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        *self.inner.shutdown_tx.lock() = Some(shutdown_tx);

        let handle = tokio::spawn(async move {
            accept_loop(listener, state, shutdown_rx).await;
        });
        *self.inner.accept_task.lock() = Some(handle);

        let actual_port = local_addr.port();
        let actual_addr = local_addr.ip().to_string();
        self.inner.listen_port.store(actual_port, Ordering::Relaxed);
        *self.inner.listen_addr.write() = Some(actual_addr.clone());

        Ok(ServerInfo {
            port: actual_port,
            address: actual_addr,
        })
    }

    #[napi]
    pub async fn close(&self, close_active_connections: Option<bool>) {
        if let Some(tx) = self.inner.shutdown_tx.lock().take() {
            let _ = tx.send(());
        }
        let task = self.inner.accept_task.lock().take();
        if let Some(h) = task {
            h.abort();
            let _ = h.await;
        }

        if close_active_connections.unwrap_or(false) {
            for entry in self.inner.conn_abort_handles.iter() {
                entry.value().abort();
            }
            self.inner.conn_abort_handles.clear();
        }

        *self.inner.on_request.write() = None;
        *self.inner.on_ws_event.write() = None;
        self.inner.pending.clear();
        self.inner.request_addrs.clear();
    }

    #[napi]
    pub fn send_response(&self, request_id: u32, response: ResponseData) {
        self.inner.request_addrs.remove(&request_id);
        if let Some((_, tx)) = self.inner.pending.remove(&request_id) {
            let _ = tx.send(response);
        }
    }

    #[napi]
    pub fn send_response_text(
        &self,
        request_id: u32,
        status: u16,
        headers: Vec<String>,
        body: String,
    ) {
        self.inner.request_addrs.remove(&request_id);
        if let Some((_, tx)) = self.inner.pending.remove(&request_id) {
            let response = ResponseData {
                status,
                headers,
                body: Some(body.into_bytes()),
                upgrade: None,
                connection_id: None,
            };
            let _ = tx.send(response);
        }
    }

    #[napi]
    pub fn send_response_buffer(
        &self,
        request_id: u32,
        status: u16,
        headers: Vec<String>,
        body: Vec<u8>,
    ) {
        self.inner.request_addrs.remove(&request_id);
        if let Some((_, tx)) = self.inner.pending.remove(&request_id) {
            let response = ResponseData {
                status,
                headers,
                body: Some(body),
                upgrade: None,
                connection_id: None,
            };
            let _ = tx.send(response);
        }
    }

    /// Direct buffer path — accepts Uint8Array / Buffer (zero-copy bytes from JS).
    #[napi]
    pub fn send_response_buffer_direct(
        &self,
        request_id: u32,
        status: u16,
        headers: Vec<String>,
        body: Option<Buffer>,
    ) {
        self.inner.request_addrs.remove(&request_id);
        if let Some((_, tx)) = self.inner.pending.remove(&request_id) {
            let response = ResponseData {
                status,
                headers,
                body: body.map(|b| b.to_vec()),
                upgrade: None,
                connection_id: None,
            };
            let _ = tx.send(response);
        }
    }

    /// Zero-copy submission of a NativeResponse. Takes data via std::mem::take.
    #[napi]
    pub fn submit_native_response(&self, request_id: u32, response: &NativeResponse) {
        self.inner.request_addrs.remove(&request_id);
        if let Some((_, tx)) = self.inner.pending.remove(&request_id) {
            let mut inner = response.inner.lock();
            let response_data = ResponseData {
                status: inner.status,
                headers: std::mem::take(&mut inner.headers),
                body: if inner.body.is_empty() {
                    None
                } else {
                    Some(std::mem::take(&mut inner.body))
                },
                upgrade: None,
                connection_id: None,
            };
            let _ = tx.send(response_data);
        }
    }

    /// Binary protocol: buffer contains [status:u16 LE][header_section_len:u32 LE] +
    /// [num_strings:u32 LE] + alternating (key_len:u32 LE, key_bytes, val_len:u32 LE, val_bytes) + body
    #[napi]
    pub fn send_response_raw(&self, request_id: u32, buf: Buffer) {
        let data = buf.as_ref();
        if data.len() < 6 {
            return;
        }
        let status = u16::from_le_bytes([data[0], data[1]]);
        let header_size = u32::from_le_bytes([data[2], data[3], data[4], data[5]]) as usize;
        if data.len() < 6 + header_size {
            return;
        }
        let header_data = &data[6..6 + header_size];
        if header_data.len() < 4 {
            return;
        }
        let num_strings = u32::from_le_bytes([
            header_data[0],
            header_data[1],
            header_data[2],
            header_data[3],
        ]) as usize;
        let mut headers = Vec::with_capacity(num_strings);
        let mut pos = 4;
        let mut valid = true;
        for _ in 0..num_strings {
            if pos + 4 > header_data.len() {
                valid = false;
                break;
            }
            let len = u32::from_le_bytes([
                header_data[pos],
                header_data[pos + 1],
                header_data[pos + 2],
                header_data[pos + 3],
            ]) as usize;
            pos += 4;
            if pos + len > header_data.len() {
                valid = false;
                break;
            }
            match std::str::from_utf8(&header_data[pos..pos + len]) {
                Ok(s) => headers.push(s.to_string()),
                Err(_) => {
                    valid = false;
                    break;
                }
            }
            pos += len;
        }
        if !valid {
            return;
        }
        let body_start = 6 + header_size;
        let body = if data.len() > body_start {
            Some(data[body_start..].to_vec())
        } else {
            None
        };
        self.inner.request_addrs.remove(&request_id);
        if let Some((_, tx)) = self.inner.pending.remove(&request_id) {
            let _ = tx.send(ResponseData {
                status,
                headers,
                body,
                upgrade: None,
                connection_id: None,
            });
        }
    }

    #[napi]
    pub fn pending_count(&self) -> u32 {
        self.inner.pending.len() as u32
    }

    #[napi]
    pub fn request_ip(&self, request_id: u32) -> Option<SocketAddress> {
        self.inner.request_addrs.get(&request_id).and_then(|addr| {
            let sock_addr: std::net::SocketAddr = addr.value().parse().ok()?;
            let family = if sock_addr.is_ipv4() {
                "IPv4".to_string()
            } else {
                "IPv6".to_string()
            };
            Some(SocketAddress {
                address: sock_addr.ip().to_string(),
                family,
                port: sock_addr.port(),
            })
        })
    }

    #[napi]
    pub fn ws_send(&self, connection_id: String, message: String) -> i32 {
        let len = message.len() as i32;
        let tx = self
            .inner
            .ws_senders
            .get(&connection_id)
            .map(|e| e.value().clone());
        if let Some(tx) = tx {
            match tx.try_send(tokio_tungstenite::tungstenite::Message::Text(message)) {
                Ok(_) => len,
                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => -1,
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => 0,
            }
        } else {
            0
        }
    }

    #[napi]
    pub fn ws_send_binary(&self, connection_id: String, data: Vec<u8>) -> i32 {
        let len = data.len() as i32;
        let tx = self
            .inner
            .ws_senders
            .get(&connection_id)
            .map(|e| e.value().clone());
        if let Some(tx) = tx {
            match tx.try_send(tokio_tungstenite::tungstenite::Message::Binary(data)) {
                Ok(_) => len,
                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => -1,
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => 0,
            }
        } else {
            0
        }
    }

    #[napi]
    pub fn ws_close(&self, connection_id: String) {
        let tx = self
            .inner
            .ws_senders
            .get(&connection_id)
            .map(|e| e.value().clone());
        if let Some(tx) = tx {
            let _ = tx.try_send(tokio_tungstenite::tungstenite::Message::Close(None));
        }
    }

    #[napi]
    pub fn ws_connection_count(&self) -> u32 {
        self.inner.ws_senders.len() as u32
    }

    #[napi]
    pub fn ws_connection_ids(&self) -> Vec<String> {
        self.inner
            .ws_senders
            .iter()
            .map(|e| e.key().clone())
            .collect()
    }

    #[napi]
    pub fn ws_subscribe(&self, connection_id: String, topic: String) {
        self.inner
            .ws_subscriptions
            .entry(connection_id.clone())
            .or_default()
            .insert(topic.clone());
        self.inner
            .ws_topics
            .entry(topic)
            .or_default()
            .insert(connection_id);
    }

    #[napi]
    pub fn ws_unsubscribe(&self, connection_id: String, topic: String) {
        if let Some(mut entry) = self.inner.ws_subscriptions.get_mut(&connection_id) {
            entry.remove(&topic);
        }
        if let Some(mut entry) = self.inner.ws_topics.get_mut(&topic) {
            entry.remove(&connection_id);
        }
    }

    #[napi]
    pub fn ws_is_subscribed(&self, connection_id: String, topic: String) -> bool {
        self.inner
            .ws_subscriptions
            .get(&connection_id)
            .map(|e| e.value().contains(&topic))
            .unwrap_or(false)
    }

    #[napi]
    pub fn ws_publish(&self, connection_id: String, topic: String, message: String) -> u32 {
        self.publish_internal(Some(connection_id), topic, message)
    }

    #[napi]
    pub fn server_publish(&self, topic: String, message: String) -> u32 {
        self.publish_internal(None, topic, message)
    }

    fn publish_internal(&self, exclude_id: Option<String>, topic: String, message: String) -> u32 {
        let msg = tokio_tungstenite::tungstenite::Message::Text(message);

        let ids: Vec<String> = match self.inner.ws_topics.get(&topic) {
            Some(entry) => entry
                .value()
                .iter()
                .filter(|id| exclude_id.as_ref().map_or(true, |ex| *id != ex))
                .cloned()
                .collect(),
            None => return 0,
        };

        let mut sent_count = 0;
        for id in &ids {
            if let Some(tx) = self.inner.ws_senders.get(id).map(|e| e.value().clone()) {
                if tx.try_send(msg.clone()).is_ok() {
                    sent_count += 1;
                }
            }
        }
        sent_count
    }

    fn next_id(prefix: &str) -> String {
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        format!("{}_{}_{}", prefix, COUNTER.fetch_add(1, Ordering::Relaxed), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis())
    }

    #[napi(getter)]
    pub fn port(&self) -> u16 {
        self.inner.listen_port.load(Ordering::Relaxed)
    }

    #[napi(getter)]
    pub fn hostname(&self) -> String {
        self.inner.listen_addr.read().clone().unwrap_or_else(|| "0.0.0.0".to_string())
    }

    #[napi(getter)]
    pub fn url(&self) -> String {
        let addr = self.inner.listen_addr.read();
        let port = self.inner.listen_port.load(Ordering::Relaxed);
        match addr.as_ref() {
            Some(host) => format!("http://{}:{}/", host, port),
            None => String::new(),
        }
    }

    #[napi]
    pub fn upgrade(&self, request_id: u32) -> Option<String> {
        if self.inner.upgraded_requests.contains_key(&request_id) {
            return None;
        }
        let connection_id = Self::next_id("ws");
        let remote_addr = self.inner.request_addrs.get(&request_id).map(|r| r.value().clone()).unwrap_or_default();
        self.inner.upgraded_requests.insert(request_id, (connection_id.clone(), remote_addr));
        Some(connection_id)
    }

    #[napi]
    pub async fn stop(&self, close_active_connections: Option<bool>) {
        self.close(close_active_connections).await;
    }
}

async fn accept_loop(
    listener: TcpListener,
    state: Arc<ServerInner>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            result = listener.accept() => {
                match result {
                    Ok((stream, peer)) => {
                        let remote = peer.to_string();
                        let state_for_spawn = state.clone();
                        let conn_id = state.conn_counter.fetch_add(1, Ordering::Relaxed);
                        let cleanup_state = state.clone();
                        let handle = tokio::spawn(async move {
                            handle_connection(stream, state_for_spawn, remote).await;
                            cleanup_state.conn_abort_handles.remove(&conn_id);
                        });
                        state.conn_abort_handles.insert(conn_id, handle.abort_handle());
                    }
                    Err(e) => {
                        eprintln!("accept error: {}", e);
                        break;
                    }
                }
            }
            _ = &mut shutdown_rx => {
                break;
            }
        }
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    state: Arc<ServerInner>,
    remote_addr: String,
) {
    let io = TokioIo::new(stream);
    let svc = hyper::service::service_fn(move |req: Request<Incoming>| {
        handle_request(req, state.clone(), remote_addr.clone())
    });

    let mut builder =
        hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
    builder
        .http1()
        .max_buf_size(65536)
        .pipeline_flush(true)
        .keep_alive(true)
        .max_headers(200);
    builder.http2().max_concurrent_streams(256);
    if let Err(e) = builder.serve_connection_with_upgrades(io, svc).await {
        let is_expected_close = e
            .downcast_ref::<hyper::Error>()
            .is_some_and(|h| h.is_closed() || h.is_canceled());
        if !is_expected_close {
            eprintln!("connection error: {}", e);
        }
    }
}

async fn handle_request(
    req: Request<Incoming>,
    state: Arc<ServerInner>,
    remote_addr: String,
) -> std::result::Result<Response<Full<Bytes>>, hyper::Error> {
    let is_upgrade = websocket::is_ws_upgrade(&req);
    let mut req_opt = Some(req);

    let (method, url, path, headers, body_bytes) = if is_upgrade {
        let req_ref = req_opt.as_ref().unwrap();
        (
            req_ref.method().to_string(),
            req_ref.uri().to_string(),
            req_ref.uri().path().to_string(),
            extract_headers(req_ref.headers()),
            None,
        )
    } else {
        let req = req_opt.take().unwrap();
        let (parts, body) = req.into_parts();
        let method_str = parts.method.to_string();
        let is_get_head = parts.method == hyper::Method::GET
            || parts.method == hyper::Method::HEAD
            || parts.method == hyper::Method::OPTIONS;
        let body_bytes = if is_get_head {
            None
        } else {
            if let Some(cl) = parts.headers.get("content-length") {
                if let Ok(len_str) = cl.to_str() {
                    if let Ok(len) = len_str.parse::<usize>() {
                        if len > MAX_BODY_SIZE {
                            return Ok(Response::builder()
                                .status(StatusCode::PAYLOAD_TOO_LARGE)
                                .body(Full::new(Bytes::from("Request body too large")))
                                .unwrap());
                        }
                    }
                }
            }
            let body_bytes = match body.collect().await {
                Ok(collected) => {
                    let bytes = collected.to_bytes();
                    if bytes.len() > MAX_BODY_SIZE {
                        return Ok(Response::builder()
                            .status(StatusCode::PAYLOAD_TOO_LARGE)
                            .body(Full::new(Bytes::from("Request body too large")))
                            .unwrap());
                    }
                    bytes
                }
                Err(e) => {
                    return Ok(Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .body(Full::new(Bytes::from(format!("body error: {}", e))))
                        .unwrap());
                }
            };
            if body_bytes.is_empty() {
                None
            } else {
                Some(Vec::from(body_bytes))
            }
        };
        (
            method_str,
            parts.uri.to_string(),
            parts.uri.path().to_string(),
            extract_headers(&parts.headers),
            body_bytes,
        )
    };

    // Parse JSON body in Rust (zero-copy from bytes) — avoids JS req.clone().text() + JSON.parse()
    let parsed_body_value: Option<serde_json::Value> = if let Some(ref body_bytes) = body_bytes {
        if is_json_content_type(&headers) {
            serde_json::from_slice(body_bytes).ok()
        } else {
            None
        }
    } else {
        None
    };
    // Serialize to string for JS (fast JSON.stringify in Rust, avoids UTF-8 decode in JS)
    let parsed_body: Option<String> = parsed_body_value
        .as_ref()
        .and_then(|v| serde_json::to_string(v).ok());

    // Parse query params in Rust (avoids JS new URL().searchParams iteration)
    let query_params = parse_query_from_url(&url);

    // Auto-validate against registered schemas before calling JS
    if state.auto_validate.load(std::sync::atomic::Ordering::Relaxed) {
        let schemas_guard = state.validator_schemas.read();
        if let Some(ref schemas) = *schemas_guard {
            let route_key = format!("{}:{}", method, path);
            if let Some(schema) = schemas.get(&route_key) {
                // Validate body
                if let (Some(ref body_schema), Some(ref parsed)) = (&schema.body, &parsed_body_value) {
                    let errors =
                        crate::schema::validate_json_value(parsed, body_schema, "body");
                    if !errors.is_empty() {
                        let error_json = serde_json::json!({
                            "errors": errors.iter().map(|e| {
                                serde_json::json!({
                                    "field": e.field,
                                    "message": e.message,
                                    "code": e.code
                                })
                            }).collect::<Vec<_>>()
                        });
                        let body = serde_json::to_vec(&error_json).unwrap_or_default();
                        return Ok(Response::builder()
                            .status(StatusCode::BAD_REQUEST)
                            .header("content-type", "application/json")
                            .body(Full::new(Bytes::from(body)))
                            .unwrap());
                    }
                }

                // Validate query params
                if let Some(ref query_schema) = schema.query {
                    if let Some(ref params) = query_params {
                        let errors = crate::schema::validate_query_string(params, query_schema);
                        if !errors.is_empty() {
                            let error_json = serde_json::json!({
                                "errors": errors.iter().map(|e| {
                                    serde_json::json!({
                                        "field": e.field,
                                        "message": e.message,
                                        "code": e.code
                                    })
                                }).collect::<Vec<_>>()
                            });
                            let body = serde_json::to_vec(&error_json).unwrap_or_default();
                            return Ok(Response::builder()
                                .status(StatusCode::BAD_REQUEST)
                                .header("content-type", "application/json")
                                .body(Full::new(Bytes::from(body)))
                                .unwrap());
                        }
                    }
                }

                // Validate path params
                if let Some(ref params_schema) = schema.params {
                    // Path params are extracted in JS after route matching,
                    // so we can only validate if they're in the URL path segments.
                    // For now, skip path param validation in auto mode.
                    // Users can validate path params in JS using validator.validateParams()
                    let _ = params_schema;
                }
            }
        }
    }

    let request_id = next_request_id();

    let request_data = RequestData {
        method,
        url,
        path,
        headers,
        body: body_bytes,
        remote_addr: remote_addr.clone(),
        request_id,
        parsed_body,
        query_params,
    };

    state.request_addrs.insert(request_id, remote_addr.clone());

    let (tx, rx) = oneshot::channel::<ResponseData>();
    state.pending.insert(request_id, tx);

    let tsfn = state.on_request.read().as_ref().map(Arc::clone);

    if let Some(tsfn) = tsfn {
        if tsfn.call(request_data, ThreadsafeFunctionCallMode::NonBlocking) != Status::Ok {
            eprintln!("on_request call failed");
        }
    } else {
        state.request_addrs.remove(&request_id);
        state.pending.remove(&request_id);
        return Ok(Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Full::new(Bytes::from("no fetch handler registered")))
            .unwrap());
    }

    let response_data = match rx.await {
        Ok(r) => r,
        Err(_) => {
            state.request_addrs.remove(&request_id);
            return Ok(Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Full::new(Bytes::from("request cancelled")))
                .unwrap());
        }
    };

    if is_upgrade {
        if let Some((_, (connection_id, addr))) = state.upgraded_requests.remove(&request_id) {
            if let Some(req) = req_opt.take() {
                return handle_ws_upgrade(req, state, addr, connection_id, response_data.headers).await;
            }
        }
        if response_data.upgrade.unwrap_or(false) {
            if let (Some(req), Some(connection_id)) = (req_opt.take(), response_data.connection_id.clone()) {
                return handle_ws_upgrade(req, state, remote_addr.clone(), connection_id, response_data.headers).await;
            }
        }
    }

    let mut builder = Response::builder().status(
        StatusCode::from_u16(response_data.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
    );

    for chunk in response_data.headers.chunks(2) {
        if let [name, value] = chunk {
            builder = builder.header(name.as_str(), value.as_str());
        }
    }

    let body = response_data.body.unwrap_or_default();
    Ok(builder.body(Full::new(Bytes::from(body))).unwrap())
}

async fn handle_ws_upgrade(
    req: Request<Incoming>,
    state: Arc<ServerInner>,
    _remote_addr: String,
    connection_id: String,
    extra_headers: Vec<String>,
) -> std::result::Result<Response<Full<Bytes>>, hyper::Error> {
    let ws_key = req
        .headers()
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let mut upgrade_response = websocket::build_ws_upgrade_response(&ws_key);
    for chunk in extra_headers.chunks(2) {
        if let [name, value] = chunk {
            upgrade_response.headers_mut().append(
                hyper::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                hyper::header::HeaderValue::from_str(value).unwrap(),
            );
        }
    }

    let event_tsfn = state.on_ws_event.read().as_ref().map(Arc::clone);

    let senders = state.ws_senders.clone();

    tokio::spawn(async move {
        match hyper::upgrade::on(req).await {
            Ok(upgraded) => {
                let io = TokioIo::new(upgraded);

                let event = WsEvent {
                    event_type: "open".to_string(),
                    connection_id: connection_id.clone(),
                    text: None,
                    binary: None,
                    error: None,
                    code: None,
                    reason: None,
                    remote_addr: Some(_remote_addr.clone()),
                };
                if let Some(ref tsfn) = event_tsfn {
                    if tsfn.call(event, ThreadsafeFunctionCallMode::NonBlocking) != Status::Ok {
                        eprintln!("ws open event call failed");
                    }
                }

                let state_clone = state.clone();
                let cid_clone = connection_id.clone();
                let cleanup = move || {
                    if let Some((_, user_topics)) = state_clone.ws_subscriptions.remove(&cid_clone)
                    {
                        for topic in user_topics {
                            if let Some(mut entry) = state_clone.ws_topics.get_mut(&topic) {
                                entry.remove(&cid_clone);
                            }
                        }
                    }
                };

                websocket::handle_ws_connection(
                    io,
                    connection_id.clone(),
                    senders,
                    event_tsfn,
                    Box::new(cleanup),
                )
                .await;
            }
            Err(e) => {
                eprintln!("websocket upgrade error: {}", e);
            }
        }
    });

    Ok(upgrade_response)
}

fn next_request_id() -> u32 {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed) as u32
}

fn extract_headers(headers: &HeaderMap) -> Vec<String> {
    let mut v = Vec::with_capacity(headers.len() * 2);
    for (k, val) in headers.iter() {
        v.push(k.as_str().to_string());
        v.push(String::from_utf8_lossy(val.as_bytes()).into_owned());
    }
    v
}

async fn create_reusable_listener(addr: SocketAddr) -> std::io::Result<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};

    let domain = if addr.is_ipv4() {
        Domain::IPV4
    } else {
        Domain::IPV6
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;

    socket.set_reuse_address(true)?;
    #[cfg(all(unix, not(target_os = "solaris"), not(target_os = "illumos")))]
    socket.set_reuse_port(true)?;

    socket.set_nonblocking(true)?;
    socket.bind(&addr.into())?;
    socket.listen(1024)?;

    let std_listener: std::net::TcpListener = socket.into();
    TcpListener::from_std(std_listener)
}

fn is_json_content_type(headers: &[String]) -> bool {
    for i in (0..headers.len()).step_by(2) {
        if headers[i].eq_ignore_ascii_case("content-type") {
            return headers[i + 1].contains("application/json");
        }
    }
    false
}

fn parse_query_from_url(url: &str) -> Option<HashMap<String, String>> {
    let query_start = url.find('?')?;
    let query_str = &url[query_start + 1..];
    if query_str.is_empty() {
        return None;
    }
    let mut params = HashMap::new();
    for pair in query_str.split('&') {
        if let Some(eq_pos) = pair.find('=') {
            let key = &pair[..eq_pos];
            let value = &pair[eq_pos + 1..];
            params.insert(
                urldecode(key),
                urldecode(value),
            );
        } else if !pair.is_empty() {
            params.insert(urldecode(pair), String::new());
        }
    }
    if params.is_empty() {
        None
    } else {
        Some(params)
    }
}

fn urldecode(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                result.push(byte as char);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            result.push(' ');
        } else {
            result.push(bytes[i] as char);
        }
        i += 1;
    }
    result
}
