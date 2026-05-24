//! HTTP + WebSocket server — NAPI bindings.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::SEC_WEBSOCKET_KEY;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, ThreadsafeCallContext};
use napi_derive::napi;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite;

use crate::types::{RequestCall, RequestData, ResponseData, WsEvent};
use crate::websocket::{build_ws_upgrade_response, generate_connection_id, handle_ws_connection, is_ws_upgrade, WsSenders};

// ── type aliases ─────────────────────────────────────────────────────────────

type Pending = Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<ResponseData>>>>;
type ReqTsfn = Arc<ThreadsafeFunction<RequestCall, (), (RequestCall,), napi::Status, false>>;
type WsTsfn  = Arc<ThreadsafeFunction<WsEvent, (), (WsEvent,), napi::Status, false>>;

// ── helpers ──────────────────────────────────────────────────────────────────

/// Build a `ThreadsafeFunction` for raw request callbacks.
fn build_req_tsfn(handler: &Function<'_, RequestCall, ()>) -> napi::Result<ReqTsfn> {
    let tsfn = handler
        .build_threadsafe_function::<RequestCall>()
        .build_callback(|ctx: ThreadsafeCallContext<RequestCall>| Ok((ctx.value,)))?;
    let cast: ReqTsfn = Arc::new(tsfn);
    Ok(cast)
}

/// Build a `ThreadsafeFunction` for WS event callbacks.
fn build_ws_tsfn(handler: &Function<'_, WsEvent, ()>) -> napi::Result<WsTsfn> {
    let tsfn = handler
        .build_threadsafe_function::<WsEvent>()
        .build_callback(|ctx: ThreadsafeCallContext<WsEvent>| Ok((ctx.value,)))?;
    let cast: WsTsfn = Arc::new(tsfn);
    Ok(cast)
}

fn urldecode(s: &str) -> String {
    let mut r = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        match c {
            '%' => {
                let h: String = it.by_ref().take(2).collect();
                if h.len() == 2 {
                    if let Ok(b) = u8::from_str_radix(&h, 16) { r.push(b as char); }
                    else { r.push('%'); r.push_str(&h); }
                } else { r.push('%'); r.push_str(&h); }
            }
            '+' => r.push(' '),
            _ => r.push(c),
        }
    }
    r
}

// ── HttpServer ───────────────────────────────────────────────────────────────

#[napi]
pub struct HttpServer {
    /// One‑shot channel used to stop the accept loop.
    shutdown_tx:    Arc<tokio::sync::Mutex<Option<oneshot::Sender<()>>>>,
    /// One-shot receiver to wait for shutdown to complete.
    shutdown_done:  Arc<tokio::sync::Mutex<Option<oneshot::Receiver<()>>>>,
    /// In‑flight requests waiting for a ResponseData from JS (raw mode).
    pending:        Pending,
    /// Monotonic request id counter.
    next_id:        Arc<tokio::sync::Mutex<u64>>,
    /// Active WS connection mpsc senders.
    ws_senders:     WsSenders,
    /// TSFN for WebSocket events → JS.
    ws_tsfn:        Arc<tokio::sync::Mutex<Option<WsTsfn>>>,
    /// TSFN for raw RequestCall → JS.
    req_tsfn:       Arc<tokio::sync::Mutex<Option<ReqTsfn>>>,
}

#[napi]
impl HttpServer {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            shutdown_tx:   Arc::new(tokio::sync::Mutex::new(None)),
            shutdown_done: Arc::new(tokio::sync::Mutex::new(None)),
            pending:       Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            next_id:       Arc::new(tokio::sync::Mutex::new(0)),
            ws_senders:    Arc::new(std::sync::Mutex::new(HashMap::new())),
            ws_tsfn:       Arc::new(tokio::sync::Mutex::new(None)),
            req_tsfn:      Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    /// Registers a handler that receives `{ request, requestId }`.
    #[napi]
    pub fn on_request(&self, handler: Function<'_, RequestCall, ()>) -> napi::Result<()> {
        let tsfn = build_req_tsfn(&handler)?;
        *self.req_tsfn.blocking_lock() = Some(tsfn);
        Ok(())
    }

    /// Start serving.
    #[napi]
    pub async fn listen(&self, port: u16) -> napi::Result<()> {
        let addr = format!("0.0.0.0:{}", port);
        let listener = TcpListener::bind(&addr)
            .await
            .map_err(|e| Error::from_reason(format!("bind {}: {}", addr, e)))?;

        {
            let req = self.req_tsfn.lock().await;
            if req.is_none() {
                return Err(Error::from_reason("No handler registered. Call server.onRequest(fn) first."));
            }
        }

        let (tx, mut rx) = oneshot::channel();
        let (done_tx, done_rx) = oneshot::channel();
        *self.shutdown_tx.lock().await = Some(tx);
        *self.shutdown_done.lock().await = Some(done_rx);

        let pending    = self.pending.clone();
        let next_id    = self.next_id.clone();
        let ws_senders = self.ws_senders.clone();
        let ws_tsfn    = self.ws_tsfn.clone();
        let req_tsfn   = self.req_tsfn.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    result = listener.accept() => {
                        match result {
                            Ok((stream, remote_addr)) => {
                                let pending    = pending.clone();
                                let next_id    = next_id.clone();
                                let ws_senders = ws_senders.clone();
                                let ws_tsfn    = ws_tsfn.clone();
                                let req_tsfn   = req_tsfn.clone();
                                let remote     = remote_addr.to_string();
                                tokio::spawn(async move {
                                    let io = TokioIo::new(stream);
                                    let svc = hyper::service::service_fn(move |req: Request<Incoming>| {
                                        let pending    = pending.clone();
                                        let next_id    = next_id.clone();
                                        let ws_senders = ws_senders.clone();
                                        let ws_tsfn    = ws_tsfn.clone();
                                        let req_tsfn   = req_tsfn.clone();
                                        let remote     = remote.clone();
                                        async move {
                                            handle_http(
                                                req, req_tsfn, pending, next_id,
                                                ws_senders, ws_tsfn, remote,
                                            )
                                            .await
                                        }
                                    });
                                    let _ = hyper::server::conn::http1::Builder::new()
                                        .serve_connection(io, svc)
                                        .with_upgrades()
                                        .await;
                                });
                            }
                            Err(_) => continue,
                        }
                    }
                }
            }
            let _ = done_tx.send(());
        });

        Ok(())
    }

    /// Stop the server and wait for it to actually close.
    #[napi]
    pub async fn close(&self) -> napi::Result<()> {
        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }
        if let Some(rx) = self.shutdown_done.lock().await.take() {
            let _ = rx.await;
        }
        Ok(())
    }

    /// Resolve a pending request with a `ResponseData`.
    #[napi]
    pub fn send_response(&self, request_id: String, response: ResponseData) -> napi::Result<()> {
        let mut map = self.pending.blocking_lock();
        if let Some(tx) = map.remove(&request_id) {
            tx.send(response)
                .map_err(|_| Error::from_reason("response channel closed"))?;
        }
        Ok(())
    }

    /// Register a WebSocket event handler.
    #[napi]
    pub fn on_ws_event(&self, handler: Function<'_, WsEvent, ()>) -> napi::Result<()> {
        let tsfn = build_ws_tsfn(&handler)?;
        *self.ws_tsfn.blocking_lock() = Some(tsfn);
        Ok(())
    }

    #[napi]
    pub async fn ws_send(&self, connection_id: String, message: String) -> napi::Result<()> {
        let tx = { self.ws_senders.lock().unwrap().get(&connection_id).cloned() };
        tx.ok_or_else(|| Error::from_reason("WS connection not found"))?
            .send(tungstenite::Message::Text(message.into()))
            .await
            .map_err(|_| Error::from_reason("WS send failed"))?;
        Ok(())
    }

    #[napi]
    pub async fn ws_send_binary(&self, connection_id: String, data: Vec<u8>) -> napi::Result<()> {
        let tx = { self.ws_senders.lock().unwrap().get(&connection_id).cloned() };
        tx.ok_or_else(|| Error::from_reason("WS connection not found"))?
            .send(tungstenite::Message::Binary(data.into()))
            .await
            .map_err(|_| Error::from_reason("WS binary send failed"))?;
        Ok(())
    }

    #[napi]
    pub async fn ws_close(&self, connection_id: String) -> napi::Result<()> {
        let tx = { self.ws_senders.lock().unwrap().get(&connection_id).cloned() };
        if let Some(tx) = tx { let _ = tx.send(tungstenite::Message::Close(None)).await; }
        Ok(())
    }

    #[napi]
    pub fn ws_connection_count(&self) -> u32 {
        self.ws_senders.lock().unwrap().len() as u32
    }

    #[napi]
    pub fn ws_connection_ids(&self) -> Vec<String> {
        self.ws_senders.lock().unwrap().keys().cloned().collect()
    }

    #[napi]
    pub fn pending_count(&self) -> u32 {
        self.pending.blocking_lock().len() as u32
    }
}

// ── HTTP request handler ─────────────────────────────────────────────────────

async fn handle_http(
    req: Request<Incoming>,
    req_tsfn_mutex: Arc<tokio::sync::Mutex<Option<ReqTsfn>>>,
    pending: Pending,
    next_id: Arc<tokio::sync::Mutex<u64>>,
    ws_senders: WsSenders,
    ws_tsfn: Arc<tokio::sync::Mutex<Option<WsTsfn>>>,
    remote_addr: String,
) -> std::result::Result<Response<Full<Bytes>>, std::convert::Infallible> {
    if is_ws_upgrade(&req) {
        return handle_ws(req, ws_senders, ws_tsfn).await;
    }

    let request_data = build_request_data(req, remote_addr).await;

    let req_tsfn = {
        let req_lock = req_tsfn_mutex.lock().await;
        req_lock.clone()
    };

    if let Some(tsfn) = req_tsfn {
        return handle_http_req(&tsfn, request_data, &pending, &next_id).await;
    }

    build_response(ResponseData {
        status: 500,
        headers: HashMap::new(),
        body: Some(b"No handler configured".to_vec()),
    })
}

async fn handle_http_req(
    tsfn: &ReqTsfn,
    request_data: RequestData,
    pending: &Pending,
    next_id: &Arc<tokio::sync::Mutex<u64>>,
) -> std::result::Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let request_id = next_request_id(next_id).await;

    let resp_rx = {
        let mut m = pending.lock().await;
        let (tx, rx) = oneshot::channel();
        m.insert(request_id.clone(), tx);
        rx
    };

    tsfn.call(
        RequestCall {
            request: request_data,
            request_id: request_id.clone(),
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );

    let resp_data = wait_response(resp_rx, pending, &request_id).await;
    build_response(resp_data)
}

async fn handle_ws(
    req: Request<Incoming>,
    senders: WsSenders,
    ws_tsfn_mutex: Arc<tokio::sync::Mutex<Option<WsTsfn>>>,
) -> std::result::Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let key  = req.headers().get(SEC_WEBSOCKET_KEY).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let resp = build_ws_upgrade_response(&key);
    let cid  = generate_connection_id();

    let ws_tsfn = {
        let lock = ws_tsfn_mutex.lock().await;
        lock.clone()
    };

    if let Some(tsfn) = ws_tsfn {
        tsfn.call(WsEvent { event_type: "open".into(), connection_id: cid.clone(), text: None, binary: None, error: None, code: None, reason: None }, ThreadsafeFunctionCallMode::NonBlocking);
    }

    tokio::spawn(async move {
        if let Ok(up) = hyper::upgrade::on(req).await {
            let io = TokioIo::new(up);
            let tsfn = {
                let lock = ws_tsfn_mutex.lock().await;
                lock.clone()
            };
            handle_ws_connection(io, cid, senders, tsfn).await;
        }
    });
    Ok(resp)
}

// ── Async helpers ────────────────────────────────────────────────────────────

async fn next_request_id(next_id: &Arc<tokio::sync::Mutex<u64>>) -> String {
    let mut n = next_id.lock().await;
    *n += 1;
    n.to_string()
}

async fn wait_response(
    rx: oneshot::Receiver<ResponseData>,
    pending: &Pending,
    request_id: &str,
) -> ResponseData {
    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(d))  => d,
        Ok(Err(_)) => ResponseData { status: 502, headers: HashMap::new(), body: Some(b"Bad Gateway".to_vec()) },
        Err(_)     => { let _ = pending.lock().await.remove(request_id);
                       ResponseData { status: 504, headers: HashMap::new(), body: Some(b"Gateway Timeout".to_vec()) } },
    }
}

async fn build_request_data(
    req: Request<Incoming>,
    remote_addr: String,
) -> RequestData {
    let method = req.method().to_string();
    let path   = req.uri().path().to_string();

    let mut headers = HashMap::new();
    for (k, v) in req.headers() { if let Ok(s) = v.to_str() { headers.insert(k.to_string().to_lowercase(), s.to_string()); } }

    let host = headers.get("host").cloned().unwrap_or_else(|| "localhost".to_string());
    let scheme = if req.uri().scheme_str() == Some("https") { "https" } else { "http" };
    let url = format!("{}://{}{}", scheme, host, req.uri());

    let mut query = HashMap::new();
    if let Some(qs) = req.uri().query() {
        for pair in qs.split('&') {
            let mut parts = pair.splitn(2, '=');
            if let (Some(k), Some(v)) = (parts.next(), parts.next()) {
                query.insert(urldecode(k), urldecode(v));
            } else if let Some(k) = parts.next() {
                query.insert(urldecode(k), String::new());
            }
        }
    }

    let body = match req.collect().await {
        Ok(c) => {
            let bytes = c.to_bytes();
            if bytes.is_empty() {
                None
            } else {
                Some(bytes.to_vec())
            }
        }
        Err(_) => None,
    };

    RequestData { method, url, path, headers, body, query, remote_addr }
}

fn build_response(
    data: ResponseData,
) -> std::result::Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let mut builder = Response::builder().status(data.status);
    for (k, v) in &data.headers { builder = builder.header(k.as_str(), v.as_str()); }
    let body = data.body.unwrap_or_default();
    Ok(builder.body(Full::new(Bytes::from(body)))
        .unwrap_or_else(|_| Response::builder().status(500).body(Full::new(Bytes::from("ISE"))).unwrap()))
}
