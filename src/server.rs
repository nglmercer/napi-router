use std::collections::HashMap;
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

type RequestTsfn = ThreadsafeFunction<RequestCall, Unknown<'static>, RequestCall, Status, false, false, 0>;
type WsEventTsfn = ThreadsafeFunction<WsEvent, Unknown<'static>, WsEvent, Status, false, false, 0>;

struct ServerInner {
    on_request: Mutex<Option<Arc<RequestTsfn>>>,
    on_ws_event: Mutex<Option<Arc<WsEventTsfn>>>,
    pending: Mutex<HashMap<String, oneshot::Sender<ResponseData>>>,
    ws_senders: websocket::WsSenders,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
}

#[napi]
pub struct HttpServer {
    inner: Arc<ServerInner>,
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
        let addr = format!(
            "{}:{}",
            hostname.unwrap_or_else(|| "0.0.0.0".into()),
            port
        );
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
    pub async fn ws_send(&self, connection_id: String, message: String) -> Result<()> {
        let tx = {
            let senders = self.inner.ws_senders.lock().unwrap();
            senders.get(&connection_id).cloned()
        };
        if let Some(tx) = tx {
            tx.send(tokio_tungstenite::tungstenite::Message::Text(message.into()))
                .await
                .map_err(|e| Error::from_reason(format!("ws_send failed: {}", e)))?;
        }
        Ok(())
    }

    #[napi]
    pub async fn ws_send_binary(&self, connection_id: String, data: Vec<u8>) -> Result<()> {
        let tx = {
            let senders = self.inner.ws_senders.lock().unwrap();
            senders.get(&connection_id).cloned()
        };
        if let Some(tx) = tx {
            tx.send(tokio_tungstenite::tungstenite::Message::Binary(data.into()))
                .await
                .map_err(|e| Error::from_reason(format!("ws_send_binary failed: {}", e)))?;
        }
        Ok(())
    }

    #[napi]
    pub async fn ws_close(&self, connection_id: String) -> Result<()> {
        let tx = {
            let senders = self.inner.ws_senders.lock().unwrap();
            senders.get(&connection_id).cloned()
        };
        if let Some(tx) = tx {
            tx.send(tokio_tungstenite::tungstenite::Message::Close(None))
                .await
                .map_err(|e| Error::from_reason(format!("ws_close failed: {}", e)))?;
        }
        Ok(())
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

    if let Err(e) = hyper_util::server::conn::auto::Builder::new(
        hyper_util::rt::TokioExecutor::new(),
    )
    .serve_connection(io, svc)
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
    if websocket::is_ws_upgrade(&req) {
        return handle_ws_upgrade(req, state, remote_addr).await;
    }

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
        .map(|(k, v)| {
            (
                k.as_str().to_lowercase(),
                v.to_str().unwrap_or("").to_string(),
            )
        })
        .collect();

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

    let mut builder = Response::builder().status(
        StatusCode::from_u16(response_data.status)
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
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
) -> std::result::Result<Response<Full<Bytes>>, hyper::Error> {
    let ws_key = req
        .headers()
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let connection_id = websocket::generate_connection_id();
    let upgrade_response = websocket::build_ws_upgrade_response(&ws_key);

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

                websocket::handle_ws_connection(
                    io,
                    connection_id.clone(),
                    senders,
                    event_tsfn,
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

fn generate_id() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    (nanos & 0xFFFF_FFFF_FFFF_FFFF) as u64
}
