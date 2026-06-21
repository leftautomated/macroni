use render_core::compositor::Compositor;
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
        .render_background(&gpu, &Background::Solid { color: Rgba([200, 50, 50, 255]) }, 32, 16)
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
fn horizontal_gradient_goes_dark_to_light() {
    let gpu = Gpu::headless().unwrap();
    let c = Compositor::new(&gpu).unwrap();
    let bg = Background::LinearGradient {
        from: Rgba([0, 0, 0, 255]),
        to: Rgba([255, 255, 255, 255]),
        angle_deg: 0.0,
    };
    let tex = c.render_background(&gpu, &bg, 64, 8).unwrap();
    let buf = c.read_texture(&gpu, &tex).unwrap();
    let left = px(&buf, 64, 1, 4)[0] as i32;
    let right = px(&buf, 64, 62, 4)[0] as i32;
    assert!(
        right - left > 150,
        "expected strong L→R ramp, got {left}->{right}"
    );
}
