//! Host-agnostic rendering core for the studio editor.
//! MUST NOT depend on `tauri`.

pub mod compositor;
pub mod decode;
pub mod doc;
pub mod encode;
pub mod engine;
pub mod gpu;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_nonempty() {
        assert!(!super::version().is_empty());
    }
}
