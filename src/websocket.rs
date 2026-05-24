use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Status, Unknown};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite;

use crate::types::WsEvent;

pub type WsSenders = Arc<Mutex<HashMap<String, mpsc::Sender<tungstenite::Message>>>>;
pub type WsEventTsfn =
    Arc<ThreadsafeFunction<WsEvent, Unknown<'static>, WsEvent, Status, false, false, 0>>;

pub fn is_ws_upgrade(req: &Request<Incoming>) -> bool {
    req.headers()
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
        && req
            .headers()
            .get("connection")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_lowercase().contains("upgrade"))
            .unwrap_or(false)
}

pub fn compute_accept_key(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    STANDARD.encode(hasher.finalize())
}

pub fn build_ws_upgrade_response(key: &str) -> Response<Full<Bytes>> {
    let accept_key = compute_accept_key(key);
    Response::builder()
        .status(101)
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Accept", accept_key)
        .body(Full::new(Bytes::new()))
        .unwrap()
}

pub fn generate_connection_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("ws_{}", ts)
}

pub async fn handle_ws_connection(
    upgraded: TokioIo<hyper::upgrade::Upgraded>,
    connection_id: String,
    senders: WsSenders,
    event_tsfn: Option<WsEventTsfn>,
) {
    use tokio_tungstenite::WebSocketStream;
    use tungstenite::protocol::Role;

    let ws_stream = WebSocketStream::from_raw_socket(upgraded, Role::Server, None).await;
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    let (tx, mut rx) = mpsc::channel::<tungstenite::Message>(256);

    {
        let mut map = senders.lock().unwrap();
        map.insert(connection_id.clone(), tx);
    }

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    let conn_id_recv = connection_id.clone();
    let senders_recv = senders.clone();
    let event_tsfn_for_recv = event_tsfn.clone();
    let event_tsfn_for_disconnect = event_tsfn;
    let recv_task = tokio::spawn(async move {
        while let Some(msg_result) = ws_receiver.next().await {
            match msg_result {
                Ok(msg) => {
                    let is_close = matches!(msg, tungstenite::Message::Close(_));

                    if let Some(ref tsfn) = event_tsfn_for_recv {
                        let event = match msg {
                            tungstenite::Message::Text(text) => WsEvent {
                                event_type: "message".to_string(),
                                connection_id: conn_id_recv.clone(),
                                text: Some(text.to_string()),
                                binary: None,
                                error: None,
                                code: None,
                                reason: None,
                            },
                            tungstenite::Message::Binary(data) => WsEvent {
                                event_type: "message".to_string(),
                                connection_id: conn_id_recv.clone(),
                                text: None,
                                binary: Some(data.to_vec()),
                                error: None,
                                code: None,
                                reason: None,
                            },
                            tungstenite::Message::Close(frame) => {
                                let (code, reason) = frame
                                    .map(|f| (Some(f.code.into()), Some(f.reason.to_string())))
                                    .unwrap_or((None, None));
                                WsEvent {
                                    event_type: "close".to_string(),
                                    connection_id: conn_id_recv.clone(),
                                    text: None,
                                    binary: None,
                                    error: None,
                                    code,
                                    reason,
                                }
                            }
                            tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_) => {
                                continue;
                            }
                            _ => continue,
                        };
                        tsfn.call(event, ThreadsafeFunctionCallMode::NonBlocking);
                    }

                    if is_close {
                        break;
                    }
                }
                Err(e) => {
                    if let Some(ref tsfn) = event_tsfn_for_recv {
                        let event = WsEvent {
                            event_type: "error".to_string(),
                            connection_id: conn_id_recv.clone(),
                            text: None,
                            binary: None,
                            error: Some(e.to_string()),
                            code: None,
                            reason: None,
                        };
                        tsfn.call(event, ThreadsafeFunctionCallMode::NonBlocking);
                    }
                    break;
                }
            }
        }
    });

    let _ = tokio::join!(send_task, recv_task);

    {
        let mut map = senders_recv.lock().unwrap();
        map.remove(&connection_id);
    }

    if let Some(ref tsfn) = event_tsfn_for_disconnect {
        let event = WsEvent {
            event_type: "disconnect".to_string(),
            connection_id,
            text: None,
            binary: None,
            error: None,
            code: Some(1000),
            reason: Some("Connection closed".to_string()),
        };
        tsfn.call(event, ThreadsafeFunctionCallMode::NonBlocking);
    }
}
