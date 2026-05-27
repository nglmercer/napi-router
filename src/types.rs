use napi_derive::napi;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct RequestData {
    pub method: String,
    pub url: String,
    pub path: String,
    pub headers: Vec<String>,
    /// Exposed to JS as a zero-copy `Uint8Array`.
    pub body: Option<Vec<u8>>,
    pub remote_addr: String,
    pub request_id: u32,
    /// Pre-parsed JSON body serialized as string. Null if body is not JSON or absent.
    /// JS can do JSON.parse(parsedBody) — faster than req.clone().text() + JSON.parse()
    pub parsed_body: Option<String>,
    /// Query parameters parsed from URL in Rust.
    pub query_params: Option<std::collections::HashMap<String, String>>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ResponseData {
    pub status: u16,
    pub headers: Vec<String>,
    /// Accepted from JS as `Uint8Array` OR `number[]` via the adapter.
    pub body: Option<Vec<u8>>,
    pub upgrade: Option<bool>,
    pub connection_id: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct WsEvent {
    pub event_type: String,
    pub connection_id: String,
    pub text: Option<String>,
    /// Exposed to JS as a zero-copy `Uint8Array`.
    pub binary: Option<Vec<u8>>,
    pub error: Option<String>,
    pub code: Option<u16>,
    pub reason: Option<String>,
    pub remote_addr: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ServerInfo {
    pub port: u16,
    pub address: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SocketAddress {
    pub address: String,
    pub family: String,
    pub port: u16,
}
