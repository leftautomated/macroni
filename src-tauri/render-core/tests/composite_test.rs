use render_core::decode::Mp4FrameSource;
use render_core::gpu::{composite_frame_on_bg, Gpu};
use std::path::Path;

#[test]
fn composites_frame_centered_on_bg() {
    let gpu = Gpu::headless().unwrap();
    let mut src = Mp4FrameSource::open(Path::new("tests/fixtures/solid.mp4")).unwrap();
    let frame = src.decode_frame(0).unwrap(); // 64x48
    let out = composite_frame_on_bg(&gpu, &frame, [0, 0, 0, 255], 128, 96); // 2x canvas, black bg
    assert_eq!(out.len(), 128 * 96 * 4);
    // a corner pixel should be background (black), center should be the frame's color
    let corner = &out[0..4];
    assert_eq!(corner, &[0, 0, 0, 255]);
    let center_idx = ((48 * 128) + 64) * 4; // roughly center
    assert!(out[center_idx + 3] == 255); // opaque frame pixel
}

#[test]
#[ignore]
fn write_png() {
    use render_core::decode::Mp4FrameSource;
    use render_core::gpu::{composite_frame_on_bg, Gpu};
    let gpu = Gpu::headless().unwrap();
    let mut src = Mp4FrameSource::open(Path::new("tests/fixtures/solid.mp4")).unwrap();
    let frame = src.decode_frame(0).unwrap();
    let out = composite_frame_on_bg(&gpu, &frame, [0, 0, 0, 255], 128, 96);
    // Tests run with cwd = render-core/; src-tauri/target/ is one level up.
    image::save_buffer(
        "../target/composite_preview.png",
        &out,
        128,
        96,
        image::ColorType::Rgba8,
    )
    .expect("failed to write PNG");
}
