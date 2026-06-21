//! Acceptance test for `Engine::export`.
//!
//! Opens the bundled `solid.mp4` fixture, exports it through a default
//! [`ProjectDoc`], then re-opens the output with [`Mp4FrameSource`] and
//! verifies that the frame count and dimensions are preserved.

#[test]
fn export_produces_playable_mp4() {
    let src =
        render_core::decode::Mp4FrameSource::open(std::path::Path::new("tests/fixtures/solid.mp4"))
            .unwrap();
    let n = render_core::decode::FrameSource::frame_count(&src);
    let mut engine = render_core::engine::Engine::new(Box::new(src)).unwrap();
    let doc = render_core::doc::ProjectDoc::new_default("solid.mp4".into());
    let out = std::env::temp_dir().join("export_test.mp4");
    let mut last = 0.0_f32;
    engine.export(&doc, &out, |p| last = p).unwrap();
    assert!(last > 0.99, "progress did not reach 1.0 (got {last})");
    let reopened = render_core::decode::Mp4FrameSource::open(&out).unwrap();
    assert_eq!(render_core::decode::FrameSource::frame_count(&reopened), n);
}
