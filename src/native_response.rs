use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::Mutex;

/// Rust-native response builder. Data stays in Rust memory — no JS object overhead.
/// Use with `HttpServer::submit_native_response` for zero-copy submission.
#[napi]
pub struct NativeResponse {
    pub(crate) inner: Mutex<NativeResponseInner>,
}

pub(crate) struct NativeResponseInner {
    pub(crate) status: u16,
    pub(crate) headers: Vec<String>,
    pub(crate) body: Vec<u8>,
}

#[napi]
impl NativeResponse {
    #[napi(constructor)]
    pub fn new() -> Self {
        NativeResponse {
            inner: Mutex::new(NativeResponseInner {
                status: 200,
                headers: Vec::with_capacity(8),
                body: Vec::new(),
            }),
        }
    }

    #[napi]
    pub fn status(&self, code: u16) -> Result<&Self> {
        self.inner.lock().status = code;
        Ok(self)
    }

    #[napi]
    pub fn header(&self, name: String, value: String) -> Result<&Self> {
        let mut inner = self.inner.lock();
        inner.headers.push(name);
        inner.headers.push(value);
        Ok(self)
    }

    #[napi]
    pub fn text(&self, data: String) -> Result<&Self> {
        let mut inner = self.inner.lock();
        inner.body = data.into_bytes();
        inner.headers.push("content-type".to_string());
        inner.headers.push("text/plain; charset=UTF-8".to_string());
        Ok(self)
    }

    #[napi]
    pub fn json(&self, data: String) -> Result<&Self> {
        let mut inner = self.inner.lock();
        inner.body = data.into_bytes();
        inner.headers.push("content-type".to_string());
        inner.headers.push("application/json".to_string());
        Ok(self)
    }

    #[napi]
    pub fn html(&self, data: String) -> Result<&Self> {
        let mut inner = self.inner.lock();
        inner.body = data.into_bytes();
        inner.headers.push("content-type".to_string());
        inner.headers.push("text/html; charset=UTF-8".to_string());
        Ok(self)
    }

    #[napi]
    pub fn set_body_buffer(&self, data: Buffer) -> Result<&Self> {
        self.inner.lock().body = data.to_vec();
        Ok(self)
    }

    #[napi]
    pub fn redirect(&self, url: String, status: Option<u16>) -> Result<&Self> {
        let mut inner = self.inner.lock();
        inner.status = status.unwrap_or(307);
        inner.headers.push("location".to_string());
        inner.headers.push(url);
        Ok(self)
    }

    #[napi]
    pub fn reset(&self) -> Result<&Self> {
        let mut inner = self.inner.lock();
        inner.status = 200;
        inner.headers.clear();
        inner.body.clear();
        Ok(self)
    }
}
