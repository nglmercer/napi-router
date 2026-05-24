use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Status, Unknown};
use napi_derive::napi;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::types::*;
use crate::websocket;

type RequestTsfn =
    ThreadsafeFunction<RequestCall, Unknown<'static>, RequestCall, Status, false, false, 0>;
type WsEventTsfn = ThreadsafeFunction<WsEvent, Unknown<'static>, WsEvent, Status, false, false, 0>;

struct ServerInner {
    on_request: Mutex<Option<Arc<RequestTsfn>>>,
    on_ws_event: Mutex<Option<Arc<WsEventTsfn>>>,
    pending: Mutex<HashMap<String, oneshot::Sender<ResponseData>>>,
    ws_senders: websocket::WsSenders,
    ws_subscriptions: Mutex<HashMap<String, HashSet<String>>>,
    ws_topics: Mutex<HashMap<String, HashSet<String>>>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
}

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
        HttpServer {
            inner: Arc::new(ServerInner {
                on_request: Mutex::new(None),
                on_ws_event: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                ws_senders: Arc::new(Mutex::new(HashMap::new())),
                ws_subscriptions: Mutex::new(HashMap::new()),
                ws_topics: Mutex::new(HashMap::new()),
                shutdown_tx: Mutex::new(None),
            }),
        }
    }

    #[napi]
    pub fn on_request(&self, callback: RequestTsfn) -> Result<()> {
        *self.inner.on_request.lock().unwrap() = Some(Arc::new(callback));
        Ok(())
    }

    #[napi]
    pub fn on_ws_event(&self, callback: WsEventTsfn) -> Result<()> {
        *self.inner.on_ws_event.lock().unwrap() = Some(Arc::new(callback));
        Ok(())
    }

    #[napi]
    pub async fn listen(&self, port: u16, hostname: Option<String>) -> Result<ServerInfo> {
        let addr = format!("{}:{}", hostname.unwrap_or_else(|| "0.0.0.0".into()), port);
        let listener = TcpListener::bind(&addr)
            .await
            .map_err(|e| Error::from_reason(format!("Failed to bind: {}", e)))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| Error::from_reason(format!("Failed to get local addr: {}", e)))?;

        let state = self.inner.clone();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        *self.inner.shutdown_tx.lock().unwrap() = Some(shutdown_tx);

        tokio::spawn(async move {
            accept_loop(listener, state, shutdown_rx).await;
        });

        Ok(ServerInfo {
            port: local_addr.port(),
            address: local_addr.ip().to_string(),
        })
    }

    #[napi]
    pub async fn close(&self) {
        if let Some(tx) = self.inner.shutdown_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }

    #[napi]
    pub fn send_response(&self, request_id: String, response: ResponseData) {
        let mut pending = self.inner.pending.lock().unwrap();
        if let Some(tx) = pending.remove(&request_id) {
            let _ = tx.send(response);
        }
    }

    #[napi]
    pub fn pending_count(&self) -> u32 {
        self.inner.pending.lock().unwrap().len() as u32
    }

    #[napi]
    pub fn ws_send(&self, connection_id: String, message: String) -> i32 {
        let len = message.len() as i32;
        let tx = {
            let senders = self.inner.ws_senders.lock().unwrap();
            senders.get(&connection_id).cloned()
        };
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
        let tx = {
            let senders = self.inner.ws_senders.lock().unwrap();
            senders.get(&connection_id).cloned()
        };
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
        let tx = {
            let senders = self.inner.ws_senders.lock().unwrap();
            senders.get(&connection_id).cloned()
        };
        if let Some(tx) = tx {
            let _ = tx.try_send(tokio_tungstenite::tungstenite::Message::Close(None));
        }
    }

    #[napi]
    pub fn ws_connection_count(&self) -> u32 {
        self.inner.ws_senders.lock().unwrap().len() as u32
    }

    #[napi]
    pub fn ws_connection_ids(&self) -> Vec<String> {
        self.inner
            .ws_senders
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    }

    #[napi]
    pub fn ws_subscribe(&self, connection_id: String, topic: String) {
        let mut subs = self.inner.ws_subscriptions.lock().unwrap();
        let mut topics = self.inner.ws_topics.lock().unwrap();
        subs.entry(connection_id.clone()).or_default().insert(topic.clone());
        topics.entry(topic).or_default().insert(connection_id);
    }

    #[napi]
    pub fn ws_unsubscribe(&self, connection_id: String, topic: String) {
        let mut subs = self.inner.ws_subscriptions.lock().unwrap();
        let mut topics = self.inner.ws_topics.lock().unwrap();
        if let Some(s) = subs.get_mut(&connection_id) {
            s.remove(&topic);
        }
        if let Some(t) = topics.get_mut(&topic) {
            t.remove(&connection_id);
        }
    }

    #[napi]
    pub fn ws_is_subscribed(&self, connection_id: String, topic: String) -> bool {
        let subs = self.inner.ws_subscriptions.lock().unwrap();
        subs.get(&connection_id).map(|s| s.contains(&topic)).unwrap_or(false)
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
            let topics = self.inner.ws_topics.lock().unwrap();
            if let Some(subs) = topics.get(&topic) {
                subs.iter()
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
            let tx = {
                let senders = self.inner.ws_senders.lock().unwrap();
                senders.get(&id).cloned()
            };
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
                        let state = state.clone();
                        let remote = peer.to_string();
                        tokio::spawn(async move {
                            handle_connection(stream, state, remote).await;
                        });
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

    if let Err(e) =
        hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new())
            .serve_connection_with_upgrades(io, svc)
            .await
    {
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

    let (method, url, path, query, headers, body_str) = if is_upgrade {
        let req_ref = req_opt.as_ref().unwrap();
        let method = req_ref.method().to_string();
        let url = req_ref.uri().to_string();
        let path = req_ref.uri().path().to_string();
        let query: HashMap<String, String> = req_ref
            .uri()
            .query()
            .map(|q| {
                url::form_urlencoded::parse(q.as_bytes())
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect()
            })
            .unwrap_or_default();
        let headers: HashMap<String, String> = req_ref
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_lowercase(), v.to_str().unwrap_or("").to_string()))
            .collect();
        (method, url, path, query, headers, None)
    } else {
        let req = req_opt.take().unwrap();
        let (parts, body) = req.into_parts();
        let body_bytes = match body.collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(e) => {
                return Ok(Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Full::new(Bytes::from(format!("body error: {}", e))))
                    .unwrap());
            }
        };
        let body_str = String::from_utf8(body_bytes.to_vec()).ok();
        let method = parts.method.to_string();
        let url = parts.uri.to_string();
        let path = parts.uri.path().to_string();
        let query: HashMap<String, String> = parts
            .uri
            .query()
            .map(|q| {
                url::form_urlencoded::parse(q.as_bytes())
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect()
            })
            .unwrap_or_default();
        let headers: HashMap<String, String> = parts
            .headers
            .iter()
            .map(|(k, v)| (k.as_str().to_lowercase(), v.to_str().unwrap_or("").to_string()))
            .collect();
        (method, url, path, query, headers, body_str)
    };

    let request_id = format!("req_{}", generate_id());

    let request_data = RequestData {
        method,
        url,
        path,
        headers,
        body: body_str,
        query,
        remote_addr,
    };

    let (tx, rx) = oneshot::channel::<ResponseData>();
    {
        let mut pending = state.pending.lock().unwrap();
        pending.insert(request_id.clone(), tx);
    }

    let tsfn = {
        let lock = state.on_request.lock().unwrap();
        lock.clone()
    };

    if let Some(tsfn) = tsfn {
        let call = RequestCall {
            request: request_data,
            request_id: request_id.clone(),
        };
        tsfn.call(call, ThreadsafeFunctionCallMode::NonBlocking);
    } else {
        state.pending.lock().unwrap().remove(&request_id);
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
            return handle_ws_upgrade(req, state, remote_addr, connection_id, response_data.headers).await;
        }
    }

    let mut builder = Response::builder().status(
        StatusCode::from_u16(response_data.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
    );

    for (k, v) in &response_data.headers {
        builder = builder.header(k.as_str(), v.as_str());
    }

    let body = response_data.body.unwrap_or_default();
    Ok(builder.body(Full::new(Bytes::from(body))).unwrap())
}

async fn handle_ws_upgrade(
    req: Request<Incoming>,
    state: Arc<ServerInner>,
    _remote_addr: String,
    connection_id: String,
    extra_headers: HashMap<String, String>,
) -> std::result::Result<Response<Full<Bytes>>, hyper::Error> {
    let ws_key = req
        .headers()
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let mut upgrade_response = websocket::build_ws_upgrade_response(&ws_key);
    for (k, v) in extra_headers {
        upgrade_response.headers_mut().append(
            hyper::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            hyper::header::HeaderValue::from_str(&v).unwrap()
        );
    }

    let event_tsfn = {
        let lock = state.on_ws_event.lock().unwrap();
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
                };
                if let Some(ref tsfn) = event_tsfn {
                    tsfn.call(event, ThreadsafeFunctionCallMode::NonBlocking);
                }

                let state_clone = state.clone();
                let cid_clone = connection_id.clone();
                let cleanup = move || {
                    let mut subs = state_clone.ws_subscriptions.lock().unwrap();
                    let mut topics = state_clone.ws_topics.lock().unwrap();
                    if let Some(user_topics) = subs.remove(&cid_clone) {
                        for topic in user_topics {
                            if let Some(t) = topics.get_mut(&topic) {
                                t.remove(&cid_clone);
                            }
                        }
                    }
                };

                websocket::handle_ws_connection(io, connection_id.clone(), senders, event_tsfn, Box::new(cleanup))
                    .await;
            }
            Err(e) => {
                eprintln!("websocket upgrade error: {}", e);
            }
        }
    });

    Ok(upgrade_response)
}

fn generate_id() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    (nanos & 0xFFFF_FFFF_FFFF_FFFF) as u64
}
