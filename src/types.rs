use napi_derive::napi;
use std::collections::HashMap;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct RequestData {
    pub method: String,
    pub url: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Option<Vec<u8>>,
    pub query: HashMap<String, String>,
    pub remote_addr: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ResponseData {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Option<Vec<u8>>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct RequestCall {
    pub request: RequestData,
    pub request_id: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct WsEvent {
    pub event_type: String,
    pub connection_id: String,
    pub text: Option<String>,
    pub binary: Option<Vec<u8>>,
    pub error: Option<String>,
    pub code: Option<u16>,
    pub reason: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ServerInfo {
    pub port: u16,
    pub address: String,
}
