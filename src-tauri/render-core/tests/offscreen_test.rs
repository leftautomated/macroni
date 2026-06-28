use render_core::gpu::{render_solid, Gpu};

#[test]
fn offscreen_clear_color_reads_back() {
    let gpu = Gpu::headless().expect("no gpu adapter");
    let out = render_solid(&gpu, 4, 4, [10, 20, 30, 255]).unwrap();
    assert_eq!(out.len(), 4 * 4 * 4);
    // top-left pixel matches clear color (allow small tolerance for format conversion)
    assert!((out[0] as i32 - 10).abs() <= 2);
    assert!((out[1] as i32 - 20).abs() <= 2);
    assert!((out[2] as i32 - 30).abs() <= 2);
    assert_eq!(out[3], 255);
}
