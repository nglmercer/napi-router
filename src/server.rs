//! HTTP + WebSocket server — NAPI bindings.
//!
//! Architecture
//! ============
//! Each incoming HTTP request is forwarded to a JS callback.
//!
//! Two modes coexist:
//!
//! **Raw mode** (backwards compatible)
//! --------------------
//! - `server.onRequest(fn)` registers a handler that receives `{ request, requestId }`.
//! - The handler calls `server.sendResponse(id, data)` to reply.
//! - A oneshot channel bridges the async gap.
//!
//! **Context mode** (Express‑style middleware, new)
//! -------------------
//! - `server.use(fn)` registers a handler that receives a `Context` object.
//! - The Context wraps the request and provides `next()`, `sendResponse()`, `json()`,
//!   `set(key,val)`, `get(key)`, `matchedHandler()`, `params()` …​
//! - `ctx.next()` triggers route matching against an attached `Router` (set via
//!   `server.useRouter(router)`) and stores the matched handler + params in state.
//! - A oneshot channel is used so the Rust accept‑loop can block until the JS
//!   middleware finishes (next / sendResponse / timeout).

use std::cell::UnsafeCell;
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

use crate::context::{Context, ContextInner};
use crate::router::Router;
use crate::types::{RequestCall, RequestData, ResponseData, WsEvent};
use crate::websocket::{build_ws_upgrade_response, generate_connection_id, handle_ws_connection, is_ws_upgrade, WsSenders};

// ── type aliases ─────────────────────────────────────────────────────────────

type Pending = Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<ResponseData>>>>;
type ReqTsfn = Arc<ThreadsafeFunction<RequestCall, (), (RequestCall,), napi::Status, false>>;
type CtxTsfn = Arc<ThreadsafeFunction<Context, (), (Context,), napi::Status, false>>;
type WsTsfn  = Arc<ThreadsafeFunction<WsEvent, (), (WsEvent,), napi::Status, false>>;

// ── helpers ──────────────────────────────────────────────────────────────────

/// Build a `ThreadsafeFunction` for context callbacks.
fn build_ctx_tsfn(handler: &Function<'_, Context, ()>) -> napi::Result<CtxTsfn> {
    let tsfn = handler
        .build_threadsafe_function::<Context>()
        .build_callback(|ctx: ThreadsafeCallContext<Context>| Ok((ctx.value,)))?;
    let cast: CtxTsfn = Arc::new(tsfn);
    Ok(cast)
}

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
    /// In‑flight requests waiting for a ResponseData from JS (raw mode).
    pending:        Pending,
    /// Monotonic request id counter.
    next_id:        Arc<tokio::sync::Mutex<u64>>,
    /// Active WS connection mpsc senders.
    ws_senders:     WsSenders,
    /// TSFN for WebSocket events → JS.
    ws_tsfn:        Arc<tokio::sync::Mutex<Option<WsTsfn>>>,
    /// TSFN for raw RequestCall → JS (backwards‑compatible mode).
    req_tsfn:       Arc<tokio::sync::Mutex<Option<ReqTsfn>>>,
    /// TSFN for Context‑based middleware (context mode).
    ctx_tsfn:       Arc<tokio::sync::Mutex<Option<CtxTsfn>>>,
    /// Optional Router for route dispatch.
    router:         Arc<tokio::sync::Mutex<Option<Router>>>,
}

#[napi]
impl HttpServer {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            shutdown_tx: Arc::new(tokio::sync::Mutex::new(None)),
            pending:     Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            next_id:     Arc::new(tokio::sync::Mutex::new(0)),
            ws_senders:  Arc::new(std::sync::Mutex::new(HashMap::new())),
            ws_tsfn:     Arc::new(tokio::sync::Mutex::new(None)),
            req_tsfn:    Arc::new(tokio::sync::Mutex::new(None)),
            ctx_tsfn:    Arc::new(tokio::sync::Mutex::new(None)),
            router:      Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    // ── registration ─────────────────────────────────────────────────────────

    /// Register a middleware function that receives a `Context`.
    ///
    /// ```ts
    /// server.use((ctx) => {
    ///   ctx.next(); // advance to routing
    /// });
    /// ```
    #[napi]
    pub fn use_middleware(&self, handler: Function<'_, Context, ()>) -> napi::Result<()> {
        let tsfn = build_ctx_tsfn(&handler)?;
        *self.ctx_tsfn.blocking_lock() = Some(tsfn);
        Ok(())
    }

    /// Shorthand alias for `use_middleware` (Express‑style).
    #[napi]
    pub fn use_(&self, handler: Function<'_, Context, ()>) -> napi::Result<()> {
        self.use_middleware(handler)
    }

    /// Backwards‑compatible raw request callback.
    /// Registers a handler that receives `{ request, requestId }`.
    #[napi]
    pub fn on_request(&self, handler: Function<'_, RequestCall, ()>) -> napi::Result<()> {
        let tsfn = build_req_tsfn(&handler)?;
        *self.req_tsfn.blocking_lock() = Some(tsfn);
        Ok(())
    }

    /// Register a context callback — same as `use_middleware`.
    ///
    /// ```ts
    /// server.onContext((ctx) => { ... });
    /// ```
    #[napi]
    pub fn on_context(&self, handler: Function<'_, Context, ()>) -> napi::Result<()> {
        self.use_middleware(handler)
    }

    /// Attach a Router for context‑mode `ctx.next()` calls.
    /// When Context‑mode middleware calls `ctx.next()`, the router is
    /// consulted and the matched handler id is stored in
    /// `ctx.matchedHandler()`.
    #[napi]
    pub fn use_router(&self, router: &Router) {
        *self.router.blocking_lock() = Some(router.clone());
    }

    /// Alias for `use_router`.
    #[napi]
    pub fn set_router(&self, router: &Router) {
        self.use_router(router);
    }

    // ── lifecycle ────────────────────────────────────────────────────────────

    /// Start serving.  Binds the port and spawns the accept loop in the
    /// background.  The returned Promise resolves as soon as the server
    /// is ready (or errors on bind failure).
    ///
    /// ```ts
    /// await server.listen(3000);
    /// ```
    #[napi]
    pub async fn listen(&self, port: u16) -> napi::Result<()> {
        let addr = format!("0.0.0.0:{}", port);
        let listener = TcpListener::bind(&addr)
            .await
            .map_err(|e| Error::from_reason(format!("bind {}: {}", addr, e)))?;

        // Validate that at least one handler is registered
        {
            let req = self.req_tsfn.lock().await;
            let ctx = self.ctx_tsfn.lock().await;
            if req.is_none() && ctx.is_none() {
                return Err(Error::from_reason(
                    "No handler registered. Call server.onRequest(fn) or server.use(fn) first.",
                ));
            }
        }

        let (tx, mut rx) = oneshot::channel();
        *self.shutdown_tx.lock().await = Some(tx);

        let pending    = self.pending.clone();
        let next_id    = self.next_id.clone();
        let ws_senders = self.ws_senders.clone();
        let ws_tsfn    = self.ws_tsfn.clone();
        let req_tsfn   = self.req_tsfn.clone();
        let ctx_tsfn   = self.ctx_tsfn.clone();
        let router_opt = self.router.clone();

        // Spawn the accept loop in background so the caller's Promise
        // resolves immediately (server is ready).
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
                                let ctx_tsfn   = ctx_tsfn.clone();
                                let router_opt = router_opt.clone();
                                let remote     = remote_addr.to_string();
                                tokio::spawn(async move {
                                    let io = TokioIo::new(stream);
                                    let svc = hyper::service::service_fn(move |req: Request<Incoming>| {
                                        let pending    = pending.clone();
                                        let next_id    = next_id.clone();
                                        let ws_senders = ws_senders.clone();
                                        let ws_tsfn    = ws_tsfn.clone();
                                        let req_tsfn   = req_tsfn.clone();
                                        let ctx_tsfn   = ctx_tsfn.clone();
                                        let router_opt = router_opt.clone();
                                        let remote     = remote.clone();
                                        async move {
                                            handle_http(
                                                req, req_tsfn, ctx_tsfn, pending, next_id,
                                                ws_senders, ws_tsfn, router_opt, remote,
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
        });

        Ok(())
    }

    /// Stop the server and release the listening port.
    #[napi]
    pub async fn close(&self) -> napi::Result<()> {
        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }
        Ok(())
    }

    // ── response / WS helpers ─────────────────────────────────────────────────

    /// Resolve a pending request with a `ResponseData`.
    /// Called from the JS request handler / middleware.
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
    ///
    /// ```ts
    /// server.onWsEvent((event) => {
    ///   if (event.eventType === "message" && event.text) {
    ///     server.wsSend(event.connectionId, `echo:${event.text}`);
    ///   }
    /// });
    /// ```
    #[napi]
    pub fn on_ws_event(&self, handler: Function<'_, WsEvent, ()>) -> napi::Result<()> {
        let tsfn = build_ws_tsfn(&handler)?;
        *self.ws_tsfn.blocking_lock() = Some(tsfn);
        Ok(())
    }

    /// Send a text WebSocket message to a connected client.
    #[napi]
    pub async fn ws_send(&self, connection_id: String, message: String) -> napi::Result<()> {
        let tx = { self.ws_senders.lock().unwrap().get(&connection_id).cloned() };
        tx.ok_or_else(|| Error::from_reason("WS connection not found"))?
            .send(tungstenite::Message::Text(message.into()))
            .await
            .map_err(|_| Error::from_reason("WS send failed"))?;
        Ok(())
    }

    /// Send a binary WebSocket message to a connected client.
    #[napi]
    pub async fn ws_send_binary(&self, connection_id: String, data: Vec<u8>) -> napi::Result<()> {
        let tx = { self.ws_senders.lock().unwrap().get(&connection_id).cloned() };
        tx.ok_or_else(|| Error::from_reason("WS connection not found"))?
            .send(tungstenite::Message::Binary(data.into()))
            .await
            .map_err(|_| Error::from_reason("WS binary send failed"))?;
        Ok(())
    }

    /// Close a WebSocket connection.
    #[napi]
    pub async fn ws_close(&self, connection_id: String) -> napi::Result<()> {
        let tx = { self.ws_senders.lock().unwrap().get(&connection_id).cloned() };
        if let Some(tx) = tx { let _ = tx.send(tungstenite::Message::Close(None)).await; }
        Ok(())
    }

    /// Number of active WebSocket connections.
    #[napi]
    pub fn ws_connection_count(&self) -> u32 {
        self.ws_senders.lock().unwrap().len() as u32
    }

    /// IDs of all active WebSocket connections.
    #[napi]
    pub fn ws_connection_ids(&self) -> Vec<String> {
        self.ws_senders.lock().unwrap().keys().cloned().collect()
    }

    /// Number of in-flight requests that haven't been answered yet.
    #[napi]
    pub fn pending_count(&self) -> u32 {
        self.pending.blocking_lock().len() as u32
    }
}

// ── HTTP request handler ─────────────────────────────────────────────────────

async fn handle_http(
    req: Request<Incoming>,
    req_tsfn: Arc<tokio::sync::Mutex<Option<ReqTsfn>>>,
    ctx_tsfn: Arc<tokio::sync::Mutex<Option<CtxTsfn>>>,
    pending: Pending,
    next_id: Arc<tokio::sync::Mutex<u64>>,
    ws_senders: WsSenders,
    ws_tsfn: Arc<tokio::sync::Mutex<Option<WsTsfn>>>,
    router_opt: Arc<tokio::sync::Mutex<Option<Router>>>,
    remote_addr: String,
) -> std::result::Result<Response<Full<Bytes>>, std::convert::Infallible> {
    // ── WebSocket upgrade check ──────────────────────────────────────────────
    if is_ws_upgrade(&req) {
        return handle_ws(req, ws_senders, ws_tsfn).await;
    }

    let request_data = build_request_data(req, remote_addr).await;

    // ── Context mode (server.use) takes priority ─────────────────────────────
    {
        let ctx_lock = ctx_tsfn.lock().await;
        if let Some(ref ctx_tsfn) = *ctx_lock {
            return handle_http_ctx(ctx_tsfn, request_data, &router_opt, &pending, &next_id).await;
        }
    }

    // ── Raw mode (server.onRequest) ──────────────────────────────────────────
    {
        let req_lock = req_tsfn.lock().await;
        if let Some(ref req_tsfn) = *req_lock {
            return handle_http_req(req_tsfn, request_data, &pending, &next_id).await;
        }
    }

    // No handler — fallback (shouldn't happen because `listen` validates)
    build_response(ResponseData {
        status: 500,
        headers: HashMap::new(),
        body: Some("No handler configured".into()),
    })
}

/// Process a request through the **context mode** pipeline:
///   1. Build a `ContextInner` with the parsed request.
///   2. Call the JS middleware (via TSFN in Blocking mode).
///   3. After it returns, if the handler called `next()`, consult the Router.
///   4. Send the HTTP response.
async fn handle_http_ctx(
    tsfn: &CtxTsfn,
    request_data: RequestData,
    router_opt: &Arc<tokio::sync::Mutex<Option<Router>>>,
    _pending: &Pending,
    _next_id: &Arc<tokio::sync::Mutex<u64>>,
) -> std::result::Result<Response<Full<Bytes>>, std::convert::Infallible> {
    // ── Create shared state ──────────────────────────────────────────────────
    let (signal_tx, signal_rx) = oneshot::channel::<()>();
    let inner = ContextInner {
        request: request_data,
        response: None,
        state: HashMap::new(),
        handled: false,
        signal: Some(signal_tx),
    };
    let ctx = Context {
        inner: Arc::new(UnsafeCell::new(inner)),
    };

    // ── Call middleware (NonBlocking) ────────────────────────────────────────
    // We use NonBlocking + a oneshot signal channel because Blocking mode
    // would deadlock: the tokio worker thread IS the main JS thread (Bun),
    // and blocking it prevents the JS event loop from processing the TSFN.
    tsfn.call(ctx.clone(), ThreadsafeFunctionCallMode::NonBlocking);

    // ── Wait for signal or timeout ───────────────────────────────────────────
    let _ = tokio::time::timeout(Duration::from_secs(30), signal_rx).await;

    // ── Read final state ─────────────────────────────────────────────────────
    let inner_ref = unsafe { &*ctx.inner.get() };

    // If middleware sent a response, use it.
    if let Some(ref data) = inner_ref.response {
        return build_response(data.clone());
    }

    // If middleware called next(), consult the router.
    if !inner_ref.handled {
        if let Some(ref router) = *router_opt.lock().await {
            let method = &inner_ref.request.method;
            let path = &inner_ref.request.path;
            if let Some(match_result) = router.match_route(method.clone(), path.clone()) {
                unsafe {
                    let inner_mut = &mut *ctx.inner.get();
                    inner_mut
                        .state
                        .insert("_handler".into(), match_result.handler_id.clone());
                    for (k, v) in &match_result.params {
                        inner_mut.state.insert(k.clone(), v.clone());
                    }
                    inner_mut.handled = true;
                }
            }
        }
    }

    // ── Default: 502 if no response was provided ─────────────────────────────
    build_response(ResponseData {
        status: 502,
        headers: HashMap::new(),
        body: Some("Middleware did not send a response".into()),
    })
}

/// Process a request in **raw mode**: pass a `RequestCall` and wait for
/// `server.sendResponse()` to be called from JS.
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
    ws_tsfn: Arc<tokio::sync::Mutex<Option<WsTsfn>>>,
) -> std::result::Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let key  = req.headers().get(SEC_WEBSOCKET_KEY).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let resp = build_ws_upgrade_response(&key);
    let cid  = generate_connection_id();

    if let Some(tsfn) = ws_tsfn.lock().await.clone() {
        tsfn.call(WsEvent { event_type: "open".into(), connection_id: cid.clone(), text: None, binary: None, error: None, code: None, reason: None }, ThreadsafeFunctionCallMode::NonBlocking);
    }

    tokio::spawn(async move {
        if let Ok(up) = hyper::upgrade::on(req).await {
            let io = TokioIo::new(up);
            handle_ws_connection(io, cid, senders, ws_tsfn.lock().await.clone()).await;
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
        Ok(Err(_)) => ResponseData { status: 502, headers: HashMap::new(), body: Some("Bad Gateway".into()) },
        Err(_)     => { let _ = pending.lock().await.remove(request_id);
                       ResponseData { status: 504, headers: HashMap::new(), body: Some("Gateway Timeout".into()) } },
    }
}

async fn build_request_data(
    req: Request<Incoming>,
    remote_addr: String,
) -> RequestData {
    let method = req.method().to_string();
    let url    = req.uri().to_string();
    let path   = req.uri().path().to_string();

    let mut headers = HashMap::new();
    for (k, v) in req.headers() { if let Ok(s) = v.to_str() { headers.insert(k.to_string(), s.to_string()); } }

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
                Some(String::from_utf8_lossy(&bytes).to_string())
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
    let body = data.body.unwrap_or_default().into_bytes();
    Ok(builder.body(Full::new(Bytes::from(body)))
        .unwrap_or_else(|_| Response::builder().status(500).body(Full::new(Bytes::from("ISE"))).unwrap()))
}
