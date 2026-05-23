//! Per‑request context for middleware / route handlers.
//!
//! Provides the `Context` NAPI object (Express‑style) and its mutable
//! inner state `ContextInner`.  The inner state is stored behind
//! `Arc<UnsafeCell<…>>` so we can hand out `&mut Self` from multiple
//! closures without fighting Rust's borrow‑checker at the FFI boundary.
//! All access goes through `Context` which safely wraps the raw pointer.

use std::cell::UnsafeCell;
use std::collections::HashMap;
use std::sync::Arc;

use napi_derive::napi;
use tokio::sync::oneshot;

use crate::types::{RequestData, ResponseData};

// ── ContextInner ─────────────────────────────────────────────────────────────

/// The actual mutable state behind a `Context`.
/// Stored in `Arc<UnsafeCell<…>>` so we can hand out `&mut Self` from
/// multiple closures without fighting Rust's borrow-checker at the FFI
/// boundary.  All access goes through `Context` which safely wraps the
/// raw pointer.
pub struct ContextInner {
    pub request:  RequestData,
    pub response: Option<ResponseData>,
    pub state:    HashMap<String, String>,
    pub handled:  bool,
    /// One‑shot sender that is taken and sent every time `advance()`,
    /// `send_response()`, `send_response_data()` or `json()` is called.
    /// The consumer (middleware loop) waits on the corresponding receiver.
    pub signal:   Option<oneshot::Sender<()>>,
}

impl ContextInner {
    #[inline]
    pub fn set(&mut self, k: String, v: String) {
        self.state.insert(k, v);
    }
    #[inline]
    pub fn get(&self, k: &str) -> Option<&String> {
        self.state.get(k)
    }
    #[inline]
    pub fn is_handled(&self) -> bool {
        self.handled
    }

    /// Called when `ctx.next()` is invoked from JS.  Clears `handled` and
    /// signals the middleware loop to continue.
    pub fn advance(&mut self) {
        self.handled = false;
        if let Some(tx) = self.signal.take() {
            let _ = tx.send(());
        }
    }

    /// Short‑circuit with a plain‑text response.
    pub fn send_response(&mut self, status: u16, body: String) {
        self.response = Some(ResponseData { status, headers: HashMap::new(), body: Some(body) });
        self.handled = true;
        if let Some(tx) = self.signal.take() {
            let _ = tx.send(());
        }
    }

    /// Short‑circuit with a pre‑built `ResponseData`.
    pub fn send_response_data(&mut self, data: ResponseData) {
        self.response = Some(data);
        self.handled = true;
        if let Some(tx) = self.signal.take() {
            let _ = tx.send(());
        }
    }

    /// Short‑circuit with a JSON body.
    pub fn json(&mut self, status: u16, body: String) {
        let mut h = HashMap::new();
        h.insert("content-type".into(), "application/json".into());
        self.response = Some(ResponseData { status, headers: h, body: Some(body) });
        self.handled = true;
        if let Some(tx) = self.signal.take() {
            let _ = tx.send(());
        }
    }

    pub fn matched_handler(&self) -> Option<&String> {
        self.state.get("_handler")
    }
    pub fn params(&self) -> HashMap<String, String> {
        self.state
            .iter()
            .filter(|(k, _)| *k != "_handler")
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

// ── Context NAPI struct ──────────────────────────────────────────────────────

/// Per-request context passed to middleware and route handlers.
///
/// ```ts
/// server.use((ctx) => {
///   const method = ctx.getRequest().method;
///   ctx.set("startTime", Date.now().toString());
///   // advance to next middleware / route
///   ctx.next();
/// });
/// ```
#[napi]
pub struct Context {
    pub(crate) inner: Arc<UnsafeCell<ContextInner>>,
}

// Safety: Context is only used within a single `handle_http_ctx` async function
// and the signal mechanism provides proper synchronization.
unsafe impl Send for Context {}
unsafe impl Sync for Context {}

impl Clone for Context {
    fn clone(&self) -> Self {
        Context { inner: self.inner.clone() }
    }
}

#[napi]
impl Context {
    #[napi]
    pub fn get_request(&self) -> RequestData {
        unsafe { (&*self.inner.get()).request.clone() }
    }

    #[napi]
    pub fn set(&self, key: String, value: String) {
        unsafe { (&mut *self.inner.get()).set(key, value) }
    }

    #[napi]
    pub fn get(&self, key: String) -> Option<String> {
        unsafe { (&*self.inner.get()).get(&key).cloned() }
    }

    /// Advance to the next middleware or matched route handler.
    /// Returns `true` to indicate the chain is still flowing.
    #[napi]
    pub fn next(&self) -> bool {
        unsafe { (&mut *self.inner.get()).advance() }
        true
    }

    /// Immediately short-circuit and send a plain-text response.
    #[napi]
    pub fn send_response(&self, status: u16, body: String) {
        unsafe { (&mut *self.inner.get()).send_response(status, body) }
    }

    /// Immediately short-circuit with a pre-built `ResponseData` object.
    #[napi]
    pub fn send_response_data(&self, response: ResponseData) {
        unsafe { (&mut *self.inner.get()).send_response_data(response) }
    }

    /// Short-circuit with a JSON body and `application/json` content-type.
    #[napi]
    pub fn json(&self, status: u16, body: String) {
        unsafe { (&mut *self.inner.get()).json(status, body) }
    }

    /// Returns the handler id resolved by the Router (after `next()` has
    /// run through the whole middleware stack).
    #[napi]
    pub fn matched_handler(&self) -> Option<String> {
        unsafe { (&*self.inner.get()).matched_handler().cloned() }
    }

    /// Returns all path parameters resolved by the Router.
    #[napi]
    pub fn params(&self) -> HashMap<String, String> {
        unsafe { (&*self.inner.get()).params() }
    }

    /// Whether `next()` or `send_response()` / `json()` has been called.
    #[napi]
    pub fn is_handled(&self) -> bool {
        unsafe { (&*self.inner.get()).is_handled() }
    }
}
