use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::SEC_WEBSOCKET_KEY;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ThreadsafeFunction, ThreadsafeFunctionCallMode, ThreadsafeCallContext,
};
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::types::{RequestCall, RequestData, ResponseData, WsEvent};
use crate::websocket::{
    build_ws_upgrade_response, generate_connection_id, handle_ws_connection, is_ws_upgrade,
    WsEventTsfn, WsSenders,
};

type PendingResponses = Arc<Mutex<HashMap<String, oneshot::Sender<ResponseData>>>>;
type HttpTsfn = Arc<ThreadsafeFunction<RequestCall, (), (RequestCall,), napi::Status, false>>;

fn create_http_tsfn(handler: Function<'_, RequestCall, ()>) -> Result<HttpTsfn> {
    let tsfn = handler
        .build_threadsafe_function::<RequestCall>()
        .build_callback(|ctx: ThreadsafeCallContext<RequestCall>| {
            Ok((ctx.value,))
        })?;
    Ok(Arc::new(tsfn))
}

fn create_ws_tsfn(handler: Function<'_, WsEvent, ()>) -> Result<WsEventTsfn> {
    let tsfn = handler
        .build_threadsafe_function::<WsEvent>()
        .build_callback(|ctx: ThreadsafeCallContext<WsEvent>| {
            Ok((ctx.value,))
        })?;
    Ok(Arc::new(tsfn))
}

#[napi]
pub struct HttpServer {
    shutdown_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    pending: PendingResponses,
    next_id: Arc<Mutex<u64>>,
    ws_senders: WsSenders,
    ws_event_tsfn: Arc<Mutex<Option<WsEventTsfn>>>,
}

#[napi]
impl HttpServer {
    #[napi(constructor)]
    pub fn new() -> Self {
        HttpServer {
            shutdown_tx: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(0)),
            ws_senders: Arc::new(Mutex::new(HashMap::new())),
            ws_event_tsfn: Arc::new(Mutex::new(None)),
        }
    }

    #[napi]
    pub fn listen(&self, port: u16, handler: Function<'_, RequestCall, ()>) -> Result<()> {
        let tsfn: HttpTsfn = create_http_tsfn(handler)?;

        let addr = format!("0.0.0.0:{}", port);
        let pending = self.pending.clone();
        let next_id = self.next_id.clone();
        let ws_senders = self.ws_senders.clone();
        let ws_event_tsfn = self.ws_event_tsfn.clone();
        let shutdown_tx = self.shutdown_tx.clone();

        tokio::spawn(async move {
            let listener = match TcpListener::bind(&addr).await {
                Ok(l) => l,
                Err(_) => return,
            };

            let (tx, mut rx) = oneshot::channel::<()>();
            {
                let mut shutdown = shutdown_tx.lock().unwrap();
                *shutdown = Some(tx);
            }

            loop {
                tokio::select! {
                    _ = &mut rx => {
                        break;
                    }
                    result = listener.accept() => {
                        match result {
                            Ok((stream, remote_addr)) => {
                                let tsfn = tsfn.clone();
                                let pending = pending.clone();
                                let next_id = next_id.clone();
                                let ws_senders = ws_senders.clone();
                                let ws_event_tsfn = ws_event_tsfn.clone();
                                let remote = remote_addr.to_string();

                                tokio::spawn(async move {
                                    let io = TokioIo::new(stream);
                                    let service = hyper::service::service_fn(move |req: Request<Incoming>| {
                                        let tsfn = tsfn.clone();
                                        let pending = pending.clone();
                                        let next_id = next_id.clone();
                                        let ws_senders = ws_senders.clone();
                                        let ws_event_tsfn = ws_event_tsfn.clone();
                                        let remote = remote.clone();
                                        async move {
                                            handle_request(
                                                req, tsfn, pending, next_id, ws_senders, ws_event_tsfn, remote,
                                            )
                                            .await
                                        }
                                    });

                                    let _ = hyper::server::conn::http1::Builder::new()
                                        .serve_connection(io, service)
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

    #[napi]
    pub fn close(&self) -> Result<()> {
        if let Some(tx) = self.shutdown_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
        Ok(())
    }

    #[napi]
    pub fn send_response(&self, request_id: String, response: ResponseData) -> Result<()> {
        let mut map = self.pending.lock().unwrap();
        if let Some(tx) = map.remove(&request_id) {
            tx.send(response)
                .map_err(|_| Error::from_reason("Failed to send response"))?;
        }
        Ok(())
    }

    #[napi]
    pub fn on_ws_event(&self, handler: Function<'_, WsEvent, ()>) -> Result<()> {
        let tsfn: WsEventTsfn = create_ws_tsfn(handler)?;

        let mut tsfn_lock = self.ws_event_tsfn.lock().unwrap();
        *tsfn_lock = Some(tsfn);
        Ok(())
    }

    #[napi]
    pub async fn ws_send(&self, connection_id: String, message: String) -> Result<()> {
        let tx = {
            let senders = self.ws_senders.lock().unwrap();
            senders.get(&connection_id).cloned()
        };
        if let Some(tx) = tx {
            tx.send(tokio_tungstenite::tungstenite::Message::Text(message.into()))
                .await
                .map_err(|_| Error::from_reason("Failed to send WebSocket message"))?;
        } else {
            return Err(Error::from_reason("WebSocket connection not found"));
        }
        Ok(())
    }

    #[napi]
    pub async fn ws_send_binary(&self, connection_id: String, data: Vec<u8>) -> Result<()> {
        let tx = {
            let senders = self.ws_senders.lock().unwrap();
            senders.get(&connection_id).cloned()
        };
        if let Some(tx) = tx {
            tx.send(tokio_tungstenite::tungstenite::Message::Binary(data.into()))
                .await
                .map_err(|_| Error::from_reason("Failed to send WebSocket binary"))?;
        } else {
            return Err(Error::from_reason("WebSocket connection not found"));
        }
        Ok(())
    }

    #[napi]
    pub async fn ws_close(&self, connection_id: String) -> Result<()> {
        let tx = {
            let senders = self.ws_senders.lock().unwrap();
            senders.get(&connection_id).cloned()
        };
        if let Some(tx) = tx {
            let _ = tx
                .send(tokio_tungstenite::tungstenite::Message::Close(None))
                .await;
        }
        Ok(())
    }

    #[napi]
    pub fn ws_connection_count(&self) -> u32 {
        self.ws_senders.lock().unwrap().len() as u32
    }

    #[napi]
    pub fn ws_connection_ids(&self) -> Vec<String> {
        self.ws_senders
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    }

    #[napi]
    pub fn pending_count(&self) -> u32 {
        self.pending.lock().unwrap().len() as u32
    }
}

async fn handle_request(
    req: Request<Incoming>,
    tsfn: HttpTsfn,
    pending: PendingResponses,
    next_id: Arc<Mutex<u64>>,
    ws_senders: WsSenders,
    ws_event_tsfn: Arc<Mutex<Option<WsEventTsfn>>>,
    remote_addr: String,
) -> std::result::Result<Response<Full<Bytes>>, std::convert::Infallible> {
    if is_ws_upgrade(&req) {
        let ws_key = req
            .headers()
            .get(SEC_WEBSOCKET_KEY)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        let response = build_ws_upgrade_response(&ws_key);
        let conn_id = generate_connection_id();

        let tsfn_clone = {
            let lock = ws_event_tsfn.lock().unwrap();
            lock.clone()
        };

        let conn_id_open = conn_id.clone();
        if let Some(ref tsfn) = tsfn_clone {
            let open_event = WsEvent {
                event_type: "open".to_string(),
                connection_id: conn_id_open,
                text: None,
                binary: None,
                error: None,
                code: None,
                reason: None,
            };
            tsfn.call(open_event, ThreadsafeFunctionCallMode::NonBlocking);
        }

        tokio::spawn(async move {
            match hyper::upgrade::on(req).await {
                Ok(upgraded) => {
                    let io = TokioIo::new(upgraded);
                    handle_ws_connection(io, conn_id, ws_senders, tsfn_clone).await;
                }
                Err(_) => {}
            }
        });

        return Ok(response);
    }

    let method = req.method().to_string();
    let url = req.uri().to_string();
    let path = req.uri().path().to_string();

    let mut headers = HashMap::new();
    for (key, value) in req.headers() {
        if let Ok(v) = value.to_str() {
            headers.insert(key.to_string(), v.to_string());
        }
    }

    let mut query = HashMap::new();
    if let Some(qs) = req.uri().query() {
        for pair in qs.split('&') {
            let mut parts = pair.splitn(2, '=');
            if let (Some(key), Some(value)) = (parts.next(), parts.next()) {
                query.insert(url_decode(key), url_decode(value));
            } else if let Some(key) = parts.next() {
                query.insert(url_decode(key), String::new());
            }
        }
    }

    let body = match req.collect().await {
        Ok(collected) => {
            let bytes = collected.to_bytes();
            if bytes.is_empty() {
                None
            } else {
                Some(String::from_utf8_lossy(&bytes).to_string())
            }
        }
        Err(_) => None,
    };

    let request_data = RequestData {
        method,
        url,
        path,
        headers,
        body,
        query,
        remote_addr,
    };

    let request_id = {
        let mut id = next_id.lock().unwrap();
        *id += 1;
        id.to_string()
    };

    let (resp_tx, resp_rx) = oneshot::channel();
    {
        let mut map = pending.lock().unwrap();
        map.insert(request_id.clone(), resp_tx);
    }

    let call = RequestCall {
        request: request_data,
        request_id: request_id.clone(),
    };
    tsfn.call(call, ThreadsafeFunctionCallMode::NonBlocking);

    let response_data = match tokio::time::timeout(Duration::from_secs(30), resp_rx).await {
        Ok(Ok(data)) => data,
        Ok(Err(_)) => ResponseData {
            status: 502,
            headers: HashMap::new(),
            body: Some("Bad Gateway: Response channel closed".to_string()),
        },
        Err(_) => {
            let mut map = pending.lock().unwrap();
            map.remove(&request_id);
            ResponseData {
                status: 504,
                headers: HashMap::new(),
                body: Some("Gateway Timeout: Handler did not respond in 30s".to_string()),
            }
        }
    };

    let mut builder = Response::builder().status(response_data.status);
    for (key, value) in &response_data.headers {
        builder = builder.header(key.as_str(), value.as_str());
    }

    let body_bytes = response_data.body.unwrap_or_default().into_bytes();

    Ok(builder
        .body(Full::new(Bytes::from(body_bytes)))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(500)
                .body(Full::new(Bytes::from("Internal Server Error")))
                .unwrap()
        }))
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
