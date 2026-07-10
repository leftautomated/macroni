#![cfg(not(target_os = "windows"))]
//! Fixture generator: encodes 3 solid-colour BGRA frames (red, green, blue) at
//! 64×48 into `tests/fixtures/solid.mp4` using the same openh264 + mp4 path
//! that `src-tauri/src/encoder.rs` uses in production.
//!
//! Run once by hand, then commit the output:
//!   cd src-tauri && cargo test -p render-core --test gen_fixture -- --ignored
//!
//! The fixture is committed so the normal decode tests never need to re-run it.

/// Solid pure-red BGRA pixel: B=0, G=0, R=255, A=255
fn red_bgra(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n * 4];
    for px in v.chunks_exact_mut(4) {
        px[0] = 0; // B
        px[1] = 0; // G
        px[2] = 255; // R
        px[3] = 255; // A
    }
    v
}

/// Solid pure-green BGRA pixel
fn green_bgra(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n * 4];
    for px in v.chunks_exact_mut(4) {
        px[0] = 0;
        px[1] = 255;
        px[2] = 0;
        px[3] = 255;
    }
    v
}

/// Solid pure-blue BGRA pixel
fn blue_bgra(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n * 4];
    for px in v.chunks_exact_mut(4) {
        px[0] = 255;
        px[1] = 0;
        px[2] = 0;
        px[3] = 255;
    }
    v
}

/// BGRA → I420 planar conversion (mirrors `encoder.rs` exactly).
fn bgra_to_i420(bgra: &[u8], width: usize, height: usize) -> Vec<u8> {
    let y_size = width * height;
    let uv_size = y_size / 4;
    let mut out = vec![0u8; y_size + uv_size * 2];
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) * 4;
            let (b, g, r) = (bgra[i] as f32, bgra[i + 1] as f32, bgra[i + 2] as f32);
            let yv = (0.257 * r + 0.504 * g + 0.098 * b + 16.0).clamp(0.0, 255.0) as u8;
            out[y * width + x] = yv;
            if y % 2 == 0 && x % 2 == 0 {
                let ui = y_size + (y / 2) * (width / 2) + x / 2;
                let vi = ui + uv_size;
                let u = (-0.148 * r - 0.291 * g + 0.439 * b + 128.0).clamp(0.0, 255.0) as u8;
                let v = (0.439 * r - 0.368 * g - 0.071 * b + 128.0).clamp(0.0, 255.0) as u8;
                out[ui] = u;
                out[vi] = v;
            }
        }
    }
    out
}

/// Strip Annex-B start-code prefix from a NAL unit (mirrors `encoder.rs`).
fn strip_annex_b_prefix(nal: &[u8]) -> &[u8] {
    if nal.len() >= 4 && nal[0] == 0 && nal[1] == 0 && nal[2] == 0 && nal[3] == 1 {
        &nal[4..]
    } else if nal.len() >= 3 && nal[0] == 0 && nal[1] == 0 && nal[2] == 1 {
        &nal[3..]
    } else {
        nal
    }
}

#[test]
#[ignore]
fn generate_solid_mp4() {
    use openh264::encoder::{Encoder, EncoderConfig, SpsPpsStrategy};
    use openh264::formats::YUVBuffer;
    use openh264::OpenH264API;

    const W: usize = 64;
    const H: usize = 48;
    const FPS: u32 = 30;
    const FRAME_DURATION_MS: u64 = 1000 / FPS as u64;

    // --- openh264 encoder ---
    let cfg = EncoderConfig::new()
        .sps_pps_strategy(SpsPpsStrategy::ConstantId)
        .max_frame_rate(FPS as f32);
    let api = OpenH264API::from_source();
    let mut encoder = Encoder::with_api_config(api, cfg).expect("create encoder");

    // Three solid BGRA frames: red, green, blue.
    let frame_data: &[(&str, Vec<u8>)] = &[
        ("red", red_bgra(W * H)),
        ("green", green_bgra(W * H)),
        ("blue", blue_bgra(W * H)),
    ];

    struct EncodedFrame {
        data: Vec<u8>,
        is_keyframe: bool,
        pts_ms: u64,
    }

    let mut encoded_frames: Vec<EncodedFrame> = Vec::new();
    let mut sps: Vec<u8> = Vec::new();
    let mut pps: Vec<u8> = Vec::new();

    for (idx, (_name, bgra)) in frame_data.iter().enumerate() {
        let yuv = bgra_to_i420(bgra, W, H);
        let yuv_buf = YUVBuffer::from_vec(yuv, W, H);
        let bs = encoder.encode(&yuv_buf).expect("encode frame");

        let mut sample_payload: Vec<u8> = Vec::new();
        let mut is_keyframe = false;

        for i in 0..bs.num_layers() {
            let layer = bs.layer(i).expect("layer");
            for j in 0..layer.nal_count() {
                let raw = layer.nal_unit(j).expect("nal");
                let body = strip_annex_b_prefix(raw);
                if body.is_empty() {
                    continue;
                }
                let nal_type = body[0] & 0x1F;
                match nal_type {
                    7 => {
                        if sps.is_empty() {
                            sps = body.to_vec();
                        }
                    }
                    8 => {
                        if pps.is_empty() {
                            pps = body.to_vec();
                        }
                    }
                    nt => {
                        if nt == 5 {
                            is_keyframe = true;
                        }
                        let len = body.len() as u32;
                        sample_payload.extend_from_slice(&len.to_be_bytes());
                        sample_payload.extend_from_slice(body);
                    }
                }
            }
        }

        if !sample_payload.is_empty() {
            encoded_frames.push(EncodedFrame {
                data: sample_payload,
                is_keyframe,
                pts_ms: idx as u64 * FRAME_DURATION_MS,
            });
        }
    }

    assert!(
        !sps.is_empty() && !pps.is_empty(),
        "encoder must emit SPS/PPS"
    );
    assert_eq!(encoded_frames.len(), 3, "expected 3 encoded frames");

    // --- mp4 muxer (mirrors encoder.rs finalize) ---
    use mp4::{AvcConfig, MediaConfig, Mp4Config, Mp4Writer, TrackConfig, TrackType};
    use std::fs::File;

    // Output path is relative to the crate root (where `cargo test` runs).
    let out_path = std::path::Path::new("tests/fixtures/solid.mp4");
    std::fs::create_dir_all(out_path.parent().unwrap()).unwrap();
    let file = File::create(out_path).expect("create solid.mp4");

    let mp4_cfg = Mp4Config {
        major_brand: (*b"mp42").into(),
        minor_version: 0,
        compatible_brands: vec![(*b"mp42").into(), (*b"isom").into()],
        timescale: 1000,
    };
    let mut writer = Mp4Writer::write_start(file, &mp4_cfg).expect("mp4 write_start");

    let track_cfg = TrackConfig {
        track_type: TrackType::Video,
        timescale: 1000,
        language: String::from("und"),
        media_conf: MediaConfig::AvcConfig(AvcConfig {
            width: W as u16,
            height: H as u16,
            seq_param_set: sps,
            pic_param_set: pps,
        }),
    };
    writer.add_track(&track_cfg).expect("add track");

    for (idx, ef) in encoded_frames.iter().enumerate() {
        let duration = if idx + 1 < encoded_frames.len() {
            (encoded_frames[idx + 1].pts_ms - ef.pts_ms).max(1) as u32
        } else {
            FRAME_DURATION_MS as u32
        };
        let sample = mp4::Mp4Sample {
            start_time: ef.pts_ms,
            duration,
            rendering_offset: 0,
            is_sync: ef.is_keyframe,
            bytes: ef.data.clone().into(),
        };
        writer.write_sample(1, &sample).expect("write sample");
    }
    writer.write_end().expect("mp4 write_end");

    let meta = std::fs::metadata(out_path).expect("fixture metadata");
    assert!(meta.len() > 0, "solid.mp4 must be non-empty");
    println!("Generated {out_path:?} ({} bytes)", meta.len());
}
