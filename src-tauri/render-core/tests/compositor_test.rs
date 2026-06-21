use render_core::compositor::Compositor;
use render_core::decode::RgbaFrame;
use render_core::doc::{Background, Rgba};
use render_core::gpu::Gpu;

fn px(buf: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * w + x) * 4) as usize;
    [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
}

#[test]
fn solid_background_fills() {
    let gpu = Gpu::headless().unwrap();
    let c = Compositor::new(&gpu).unwrap();
    let tex = c
        .render_background(&gpu, &Background::Solid { color: Rgba([200, 50, 50, 255]) }, None, 32, 16)
        .unwrap();
    let buf = c.read_texture(&gpu, &tex).unwrap();
    let p = px(&buf, 32, 16, 8);
    assert!(
        (p[0] as i32 - 200).abs() <= 2
            && (p[1] as i32 - 50).abs() <= 2
            && (p[2] as i32 - 50).abs() <= 2,
        "expected ~(200,50,50) got {:?}",
        p
    );
}

#[test]
fn padding_insets_video_over_background() {
    let gpu = Gpu::headless().unwrap();
    let c = Compositor::new(&gpu).unwrap();
    let framing = render_core::doc::Framing {
        background: Background::Solid { color: Rgba([0, 0, 255, 255]) },
        padding_px: 20.0,
        border_radius_px: 0.0,
        shadow: render_core::doc::Shadow { blur_px: 0.0, offset_y_px: 0.0, opacity: 0.0 },
    };
    // Solid red video frame 64×48
    let video = RgbaFrame { width: 64, height: 48, data: vec![255, 0, 0, 255].repeat(64 * 48) };
    let out = c.render_frame(&gpu, &framing, &video, None, 200, 120).unwrap();
    let p = |x: u32, y: u32| {
        let i = ((y * 200 + x) * 4) as usize;
        [out[i], out[i + 1], out[i + 2], out[i + 3]]
    };
    // Corner pixel (2,2) must be blue background — inside the 20px padding band
    assert_eq!(p(2, 2)[2], 255, "corner should be blue bg, got {:?}", p(2, 2));
    // (10, 60) is in the left padding band — must also be blue
    assert_eq!(p(10, 60)[2], 255, "left padding should be blue bg, got {:?}", p(10, 60));
    // Center (100, 60) must be red video
    let center = p(100, 60);
    assert!(
        center[0] > 200 && center[2] < 60,
        "center should be red video, got {:?}",
        center
    );
}

#[test]
fn rounded_corners_show_background_at_corner() {
    let gpu = Gpu::headless().unwrap();
    let c = Compositor::new(&gpu).unwrap();
    let framing = render_core::doc::Framing {
        background: Background::Solid { color: Rgba([0, 0, 255, 255]) },
        padding_px: 0.0,
        border_radius_px: 40.0,
        shadow: render_core::doc::Shadow { blur_px: 0.0, offset_y_px: 0.0, opacity: 0.0 },
    };
    let video = RgbaFrame { width: 200, height: 120, data: vec![255, 0, 0, 255].repeat(200 * 120) };
    let out = c.render_frame(&gpu, &framing, &video, None, 200, 120).unwrap();
    let p = |x: u32, y: u32| {
        let i = ((y * 200 + x) * 4) as usize;
        [out[i], out[i + 1], out[i + 2], out[i + 3]]
    };
    assert_eq!(p(1, 1)[2], 255, "corner should be background (blue) due to radius, got {:?}", p(1, 1));
    let center = p(100, 60);
    assert!(center[0] > 200 && center[2] < 60, "center should be red video, got {:?}", center);
}

#[test]
fn horizontal_gradient_goes_dark_to_light() {
    let gpu = Gpu::headless().unwrap();
    let c = Compositor::new(&gpu).unwrap();
    let bg = Background::LinearGradient {
        from: Rgba([0, 0, 0, 255]),
        to: Rgba([255, 255, 255, 255]),
        angle_deg: 0.0,
    };
    let tex = c.render_background(&gpu, &bg, None, 64, 8).unwrap();
    let buf = c.read_texture(&gpu, &tex).unwrap();
    let left = px(&buf, 64, 1, 4)[0] as i32;
    let right = px(&buf, 64, 62, 4)[0] as i32;
    assert!(
        right - left > 150,
        "expected strong L→R ramp, got {left}->{right}"
    );
}

#[test]
fn drop_shadow_darkens_below_video() {
    let gpu = Gpu::headless().unwrap();
    let c = Compositor::new(&gpu).unwrap();
    let mk = |op: f32| render_core::doc::Framing {
        background: Background::Solid { color: Rgba([255, 255, 255, 255]) },
        padding_px: 30.0,
        border_radius_px: 0.0,
        shadow: render_core::doc::Shadow { blur_px: 16.0, offset_y_px: 12.0, opacity: op },
    };
    let video = RgbaFrame { width: 100, height: 60, data: vec![255, 0, 0, 255].repeat(100 * 60) };
    let with = c.render_frame(&gpu, &mk(0.5), &video, None, 200, 160).unwrap();
    let without = c.render_frame(&gpu, &mk(0.0), &video, None, 200, 160).unwrap();
    // sample a point just below the video rect, within the shadow band
    let idx = ((120u32 * 200 + 100) * 4) as usize; // x=100 (center col), y=120 (below video)
    assert!(
        (with[idx] as i32) < (without[idx] as i32) - 20,
        "shadow should darken below the video: with={}, without={}",
        with[idx],
        without[idx]
    );
}
