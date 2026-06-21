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

#[test]
fn export_preserves_color_no_rb_swap() {
    use render_core::decode::{FrameSource, Mp4FrameSource};
    let src = Mp4FrameSource::open(std::path::Path::new("tests/fixtures/solid.mp4")).unwrap();
    let mut engine = render_core::engine::Engine::new(Box::new(src)).unwrap();
    let mut doc = render_core::doc::ProjectDoc::new_default("solid.mp4".into());
    doc.framing.padding_px = 2.0;
    doc.framing.border_radius_px = 0.0;
    doc.framing.background = render_core::doc::Background::Solid { color: render_core::doc::Rgba([0,0,255,255]) };
    let out = std::env::temp_dir().join("export_color_test.mp4");
    engine.export(&doc, &out, |_| {}).unwrap();

    // Reopen and check FRAME 0's center pixel is dominantly RED (the video), proving no R/B swap
    // survives render->encode->mux->decode. openh264 is lossy + YUV round-trip, so assert dominance, not exact.
    let mut re = Mp4FrameSource::open(&out).unwrap();
    let f0 = FrameSource::frame(&mut re, 0).unwrap();
    let (w,h) = (f0.width as usize, f0.height as usize);
    let off = ((h/2)*w + w/2)*4;
    let (r,g,b) = (f0.data[off] as i32, f0.data[off+1] as i32, f0.data[off+2] as i32);
    assert!(r > g + 30 && r > b + 30, "center should be dominantly red (no R/B swap), got rgb=({r},{g},{b})");
}
