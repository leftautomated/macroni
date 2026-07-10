#![cfg(not(target_os = "windows"))]
use render_core::decode::Mp4FrameSource;
use render_core::doc::{Background, Rgba};
use render_core::engine::{Engine, EngineError};
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures");
    p.push(name);
    p
}

fn px(buf: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * w + x) * 4) as usize;
    [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
}

/// Engine renders a framed frame: padding band = bg color, center = decoded frame content.
///
/// Fixture: solid.mp4 (64×48), frame 0 is approximately red.
/// Doc: padding_px=16, bg=solid blue [0,0,255,255].
/// Expected output dims: 64×48 (Phase 1: output = source dims).
#[test]
fn engine_renders_framed_frame() {
    let src = Mp4FrameSource::open(&fixture("solid.mp4")).expect("open solid.mp4");
    let mut engine = Engine::new(Box::new(src)).expect("Engine::new");

    let (out_w, out_h) = engine.output_size();
    assert_eq!(
        (out_w, out_h),
        (64, 48),
        "output size must match source dims"
    );

    let mut doc = render_core::doc::ProjectDoc::new_default("solid.mp4".into());
    doc.framing.padding_px = 16.0;
    doc.framing.background = Background::Solid {
        color: Rgba([0, 0, 255, 255]),
    };
    // Disable shadow so the padding band is definitely pure bg color.
    doc.framing.shadow.opacity = 0.0;

    let buf = engine
        .render_to_texture(&mut doc, 0)
        .expect("render_to_texture");

    assert_eq!(
        buf.len(),
        (out_w * out_h * 4) as usize,
        "output buffer must be out_w * out_h * 4 bytes"
    );

    // Corner pixel (2, 2) is inside the 16 px padding band → must be blue background.
    let corner = px(&buf, out_w, 2, 2);
    assert_eq!(
        corner[2], 255,
        "corner pixel (2,2) should be blue bg, got {:?}",
        corner
    );
    assert!(
        corner[0] < 50,
        "corner R should be near-zero (blue bg), got {:?}",
        corner
    );

    // Center pixel (32, 24) is inside the video area → should NOT be blue background.
    // (Frame 0 of solid.mp4 is approximately red so R channel should dominate.)
    let center = px(&buf, out_w, 32, 24);
    assert_ne!(
        center[2], 255,
        "center pixel (32,24) should NOT be pure blue (it is video content), got {:?}",
        center
    );
}

/// Engine::new returns EngineError (not a panic) when no GPU is unavailable.
/// This test just verifies the error type exists and From impls compile.
#[test]
fn engine_error_from_impls_compile() {
    use render_core::decode::DecodeError;
    use render_core::gpu::GpuError;

    let _: EngineError = EngineError::from(DecodeError::NoFrame);
    let _: EngineError = EngineError::from(GpuError::NoAdapter);
    let _: EngineError = EngineError::Image("test".into());
}

/// Engine::render_to_texture with Background::Wallpaper pointing at a nonexistent
/// path returns Err(EngineError::Image(_)), not a GPU error or a panic.
#[test]
fn render_to_texture_bad_wallpaper_path_returns_image_error() {
    let src =
        render_core::decode::Mp4FrameSource::open(&fixture("solid.mp4")).expect("open solid.mp4");
    let mut engine = Engine::new(Box::new(src)).expect("Engine::new");

    let mut doc = render_core::doc::ProjectDoc::new_default("solid.mp4".into());
    doc.framing.background = render_core::doc::Background::Wallpaper {
        path: "/nonexistent/none.png".into(),
    };

    let err = engine
        .render_to_texture(&mut doc, 0)
        .expect_err("expected Err for bad wallpaper path");

    assert!(
        matches!(err, EngineError::Image(_)),
        "expected EngineError::Image, got: {err}"
    );
}
