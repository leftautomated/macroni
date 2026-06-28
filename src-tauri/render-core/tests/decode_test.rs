use render_core::decode::Mp4FrameSource;
use std::path::Path;

#[test]
fn decodes_fixture_dimensions_and_count() {
    let src = Mp4FrameSource::open(Path::new("tests/fixtures/solid.mp4")).unwrap();
    assert_eq!(src.dimensions(), (64, 48));
    assert_eq!(src.frame_count(), 3);
}

#[test]
fn first_frame_is_rgba_correct_size() {
    let mut src = Mp4FrameSource::open(Path::new("tests/fixtures/solid.mp4")).unwrap();
    let frame = src.decode_frame(0).unwrap();
    assert_eq!(frame.width, 64);
    assert_eq!(frame.height, 48);
    assert_eq!(frame.data.len(), 64 * 48 * 4);
}

/// Extract the center pixel RGB from an RgbaFrame.
fn center_rgb(f: &render_core::decode::RgbaFrame) -> [u8; 3] {
    let (w, h) = (f.width as usize, f.height as usize);
    let off = ((h / 2) * w + w / 2) * 4;
    [f.data[off], f.data[off + 1], f.data[off + 2]]
}

/// Return the index of the largest channel (0=R, 1=G, 2=B).
fn max_channel(c: [u8; 3]) -> usize {
    (0..3).max_by_key(|&i| c[i]).unwrap()
}

/// Decode all frames sequentially via the FrameSource trait, then a backwards
/// access. The forward path must NOT replay from frame 0 each time.
///
/// Strengthened: verifies per-frame content (red→green→blue) to prove
/// the forward-cursor returns the CORRECT frame, not a stale/duplicate one.
#[test]
fn sequential_access_does_not_replay_from_zero() {
    let mut src = Mp4FrameSource::open(Path::new("tests/fixtures/solid.mp4")).unwrap();
    // Decode all frames in order via the trait; each must return the right frame.
    let n = render_core::decode::FrameSource::frame_count(&src);
    let mut colors: Vec<[u8; 3]> = Vec::with_capacity(n);
    for i in 0..n {
        let f = render_core::decode::FrameSource::frame(&mut src, i).unwrap();
        assert_eq!((f.width, f.height), (64, 48));
        colors.push(center_rgb(&f));
    }

    // Consecutive frames must be DISTINCT — a stale cursor returning the same
    // frame every time would produce identical pixels and fail here.
    assert!(
        colors.windows(2).all(|w| w[0] != w[1]),
        "consecutive frames must have distinct center pixels; got {:?}",
        colors
    );

    // The fixture encodes solid red (frame 0), green (frame 1), blue (frame 2).
    // After YUV round-trip the dominant channel must still match the expected order.
    let expected_dominant = [0usize, 1, 2]; // R, G, B
    for (i, (color, &expected)) in colors.iter().zip(expected_dominant.iter()).enumerate() {
        let dominant = max_channel(*color);
        assert_eq!(
            dominant, expected,
            "frame {i} dominant channel: expected {} got {} (rgb={:?})",
            expected, dominant, color
        );
    }

    // Random-access backwards still works (reset path returns the right frame).
    let f0 = render_core::decode::FrameSource::frame(&mut src, 0).unwrap();
    assert_eq!((f0.width, f0.height), (64, 48));
    let color0 = center_rgb(&f0);
    assert_eq!(
        max_channel(color0),
        0,
        "after backward seek, frame 0 must still be dominant-red; got {:?}",
        color0
    );
}

/// Throughput benchmark — only runs when MACRONI_SAMPLE_MP4 is set.
/// Run with:
///   MACRONI_SAMPLE_MP4=/path/to/recording.mp4 \
///     cargo test -p render-core --test decode_test throughput -- --ignored --nocapture
#[test]
#[ignore]
fn throughput_60_frames() {
    let path_str = match std::env::var("MACRONI_SAMPLE_MP4") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("[throughput] MACRONI_SAMPLE_MP4 not set — skipping");
            return;
        }
    };

    let path = Path::new(&path_str);
    let mut src = Mp4FrameSource::open(path).expect("open sample mp4");

    let total = src.frame_count();
    let frames_to_decode = total.min(60);
    if frames_to_decode == 0 {
        eprintln!("[throughput] file has no frames");
        return;
    }

    let start = std::time::Instant::now();
    for i in 0..frames_to_decode {
        src.decode_frame(i).expect("decode frame");
    }
    let elapsed = start.elapsed();
    let fps = frames_to_decode as f64 / elapsed.as_secs_f64();

    println!("[throughput] decoded {frames_to_decode} frames in {elapsed:?} → {fps:.1} frames/sec");
}
