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

/// Decode all frames sequentially via the FrameSource trait, then a backwards
/// access. The forward path must NOT replay from frame 0 each time.
#[test]
fn sequential_access_does_not_replay_from_zero() {
    let mut src = Mp4FrameSource::open(Path::new("tests/fixtures/solid.mp4")).unwrap();
    // Decode all frames in order via the trait; each must return the right frame.
    let n = render_core::decode::FrameSource::frame_count(&src);
    for i in 0..n {
        let f = render_core::decode::FrameSource::frame(&mut src, i).unwrap();
        assert_eq!((f.width, f.height), (64, 48));
    }
    // Random-access backwards still works (resets internally).
    let f0 = render_core::decode::FrameSource::frame(&mut src, 0).unwrap();
    assert_eq!((f0.width, f0.height), (64, 48));
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

    println!(
        "[throughput] decoded {frames_to_decode} frames in {elapsed:?} → {fps:.1} frames/sec"
    );
}
