use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use dashmap::DashMap;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use napi::bindgen_prelude::{Error, Result};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Status, Unknown};
use napi_derive::napi;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::{AbortHandle, JoinHandle};

use crate::types::*;
use crate::websocket;

type RequestTsfn =
    ThreadsafeFunction<RequestData, Unknown<'static>, RequestData, Status, false, false, 0>;
type WsEventTsfn = ThreadsafeFunction<WsEvent, Unknown<'static>, WsEvent, Status, false, false, 0>;

struct ServerInner {
    on_request: Mutex<Option<Arc<RequestTsfn>>>,
    on_ws_event: Mutex<Option<Arc<WsEventTsfn>>>,
    pending: DashMap<u32, oneshot::Sender<ResponseData>>,
    ws_senders: websocket::WsSenders,
    ws_subscriptions: DashMap<String, HashSet<String>>,
    ws_topics: DashMap<String, HashSet<String>>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    accept_task: Mutex<Option<JoinHandle<()>>>,
    conn_abort_handles: Mutex<Vec<AbortHandle>>,
}

type Mutex<T> = parking_lot::Mutex<T>;

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
                on_request: parking_lot::Mutex::new(None),
                on_ws_event: parking_lot::Mutex::new(None),
                pending: DashMap::with_capacity_and_shard_amount(1024, PENDING_SHARDS),
                ws_senders: Arc::new(DashMap::new()),
                ws_subscriptions: DashMap::new(),
                ws_topics: DashMap::new(),
                shutdown_tx: parking_lot::Mutex::new(None),
                accept_task: parking_lot::Mutex::new(None),
                conn_abort_handles: parking_lot::Mutex::new(Vec::new()),
            }),
        }
    }

    #[napi(ts_args_type = "callback: (data: { request: RequestData, requestId: number }) => void")]
    pub fn on_request(&self, callback: RequestTsfn) -> napi::Result<()> {
        let mut guard = self.inner.on_request.lock();

        *guard = Some(Arc::new(callback));
        Ok(())
    }

    #[napi(ts_args_type = "callback: (event: WsEvent) => void")]
    pub fn on_ws_event(&self, callback: WsEventTsfn) -> Result<()> {
        *self.inner.on_ws_event.lock() = Some(Arc::new(callback));
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
                    format!("Port {} is already in use. Please use a different port.", port)
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

        Ok(ServerInfo {
            port: local_addr.port(),
            address: local_addr.ip().to_string(),
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
            let handles = self
                .inner
                .conn_abort_handles
                .lock()
                .drain(..)
                .collect::<Vec<_>>();
            for h in handles {
                h.abort();
            }
        }

        *self.inner.on_request.lock() = None;
        *self.inner.on_ws_event.lock() = None;
        self.inner.pending.clear();
    }

    #[napi]
    pub fn send_response(&self, request_id: u32, response: ResponseData) {
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

    #[napi]
    pub fn pending_count(&self) -> u32 {
        self.inner.pending.len() as u32
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
        let target_ids: Vec<String> = {
            if let Some(entry) = self.inner.ws_topics.get(&topic) {
                entry
                    .value()
                    .iter()
                    .filter(|id| Some(*id) != exclude_id.as_ref())
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            }
        };

        let mut sent_count = 0;
        let msg = tokio_tungstenite::tungstenite::Message::Text(message);

        for id in target_ids {
            let tx = self.inner.ws_senders.get(&id).map(|e| e.value().clone());
            if let Some(tx) = tx {
                if tx.try_send(msg.clone()).is_ok() {
                    sent_count += 1;
                }
            }
        }
        sent_count
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
                        let handle = tokio::spawn(async move {
                            handle_connection(stream, state_for_spawn, remote).await;
                        });
                        state.conn_abort_handles.lock().push(handle.abort_handle());
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
        eprintln!("connection error: {}", e);
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
        let method = req_ref.method().to_string();
        let url = req_ref.uri().to_string();
        let path = req_ref.uri().path().to_string();
        let headers: Vec<String> = {
            let mut v = Vec::with_capacity(req_ref.headers().len() * 2);
            for (k, val) in req_ref.headers().iter() {
                v.push(k.as_str().to_lowercase());
                v.push(val.to_str().unwrap_or("").to_string());
            }
            v
        };
        (method, url, path, headers, None)
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
            let body_bytes = match body.collect().await {
                Ok(collected) => collected.to_bytes(),
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
                Some(body_bytes.to_vec())
            }
        };
        let url = parts.uri.to_string();
        let path = parts.uri.path().to_string();
        let headers: Vec<String> = {
            let mut v = Vec::with_capacity(parts.headers.len() * 2);
            for (k, val) in parts.headers.iter() {
                v.push(k.as_str().to_lowercase());
                v.push(val.to_str().unwrap_or("").to_string());
            }
            v
        };
        (method_str, url, path, headers, body_bytes)
    };

    let request_id = next_request_id();

    let request_data = RequestData {
        method,
        url,
        path,
        headers,
        body: body_bytes,
        remote_addr: remote_addr.clone(),
        request_id,
    };

    let (tx, rx) = oneshot::channel::<ResponseData>();
    state.pending.insert(request_id, tx);

    let tsfn = {
        let lock = state.on_request.lock();
        lock.clone()
    };

    if let Some(tsfn) = tsfn {
        if tsfn.call(request_data, ThreadsafeFunctionCallMode::NonBlocking) != Status::Ok {
            eprintln!("on_request call failed");
        }
    } else {
        state.pending.remove(&request_id);
        return Ok(Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Full::new(Bytes::from("no fetch handler registered")))
            .unwrap());
    }

    let response_data = match rx.await {
        Ok(r) => r,
        Err(_) => {
            return Ok(Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Full::new(Bytes::from("request cancelled")))
                .unwrap());
        }
    };

    if response_data.upgrade.unwrap_or(false) && is_upgrade {
        if let (Some(req), Some(connection_id)) = (req_opt.take(), response_data.connection_id) {
            return handle_ws_upgrade(
                req,
                state,
                remote_addr.clone(),
                connection_id,
                response_data.headers,
            )
            .await;
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

    let event_tsfn = {
        let lock = state.on_ws_event.lock();
        lock.clone()
    };

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
    static COUNTER: AtomicU32 = AtomicU32::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

async fn create_reusable_listener(addr: SocketAddr) -> std::io::Result<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};

    let domain = if addr.is_ipv4() { Domain::IPV4 } else { Domain::IPV6 };
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
