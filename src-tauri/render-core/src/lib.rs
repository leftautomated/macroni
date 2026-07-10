//! Host-agnostic rendering core for the studio editor.
//! MUST NOT depend on `tauri`.

pub mod doc;
pub mod frame;

#[cfg(not(target_os = "windows"))]
pub mod compositor;
#[cfg(not(target_os = "windows"))]
pub mod decode;
#[cfg(not(target_os = "windows"))]
pub mod encode;
#[cfg(not(target_os = "windows"))]
pub mod engine;
#[cfg(not(target_os = "windows"))]
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
