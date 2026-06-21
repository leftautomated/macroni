//! H.264 encoder + MP4 muxer for the render pipeline.
//!
//! Accepts RGBA8 frames (from [`Engine::render_to_texture`]), converts them to
//! I420, encodes with openh264, and muxes into an MP4 file on [`finish`].
//!
//! This mirrors `src-tauri/src/encoder.rs` (the capture-side encoder) but
//! operates on RGBA input rather than BGRA, and has no Tauri dependency.
//!
//! # AVCC / SPS / PPS handling
//! openh264 emits NAL units in Annex-B format. MP4 (avc1 / AVCC) stores
//! parameter sets in the sample description and coded slices as
//! length-prefixed NAL units. We split them on every encoded access unit,
//! remembering the first SPS+PPS pair, then write all samples in AVCC format
//! at [`finish`] time. Mirrors the capture encoder exactly.

use crate::engine::EngineError;
use std::fs::File;
use std::path::Path;

// ── EncodedFrame ─────────────────────────────────────────────────────────────

/// A single encoded access unit ready to be muxed into the MP4 container.
struct EncodedFrame {
    /// AVCC-format payload (length-prefixed NAL units, parameter sets excluded).
    data: Vec<u8>,
    is_keyframe: bool,
    /// Presentation timestamp in milliseconds from stream start (0-based).
    pts_ms: u64,
}

// ── Mp4Encoder ───────────────────────────────────────────────────────────────

/// Stateful H.264 encoder that accumulates encoded frames and muxes an MP4
/// on [`finish`].
///
/// Create with [`Mp4Encoder::new`], feed RGBA8 frames via [`encode_rgba`],
/// then call [`finish`] to flush and write the container.
pub struct Mp4Encoder {
    width: u32,
    height: u32,
    fps: u32,
    encoder: openh264::encoder::Encoder,
    encoded_frames: Vec<EncodedFrame>,
    /// First SPS NAL body seen (without Annex-B prefix).
    sps: Vec<u8>,
    /// First PPS NAL body seen (without Annex-B prefix).
    pps: Vec<u8>,
    /// Frame counter used to derive 0-based PTS.
    frame_index: u64,
}

impl Mp4Encoder {
    /// Create an encoder for `width × height` video at `fps` frames per second.
    ///
    /// Dimensions must be even (H.264 / I420 requirement).
    ///
    /// # Errors
    /// Returns [`EngineError::Encode`] if the openh264 encoder cannot be
    /// initialised (e.g. missing shared library).
    pub fn new(width: u32, height: u32, fps: u32) -> Result<Self, EngineError> {
        use openh264::encoder::{Encoder, EncoderConfig, SpsPpsStrategy};
        use openh264::OpenH264API;

        let cfg = EncoderConfig::new()
            .sps_pps_strategy(SpsPpsStrategy::ConstantId)
            .max_frame_rate(fps as f32);
        let api = OpenH264API::from_source();
        let encoder = Encoder::with_api_config(api, cfg)
            .map_err(|e| EngineError::Encode(e.to_string()))?;

        Ok(Self {
            width,
            height,
            fps,
            encoder,
            encoded_frames: Vec::new(),
            sps: Vec::new(),
            pps: Vec::new(),
            frame_index: 0,
        })
    }

    /// Convert one RGBA8 frame to I420 and encode it.
    ///
    /// The `rgba` slice must be exactly `width * height * 4` bytes.
    ///
    /// Encoded NAL units are buffered internally. Call [`finish`] to mux them.
    ///
    /// # Errors
    /// Returns [`EngineError::Encode`] on openh264 encode failure.
    pub fn encode_rgba(&mut self, rgba: &[u8]) -> Result<(), EngineError> {
        use openh264::formats::YUVBuffer;

        let yuv = rgba_to_i420(rgba, self.width as usize, self.height as usize);
        let yuv_buf = YUVBuffer::from_vec(yuv, self.width as usize, self.height as usize);
        let bs = self
            .encoder
            .encode(&yuv_buf)
            .map_err(|e| EngineError::Encode(e.to_string()))?;

        // Walk every NAL unit in the encoded access unit, splitting parameter
        // sets from coded slices. Mirrors the capture encoder's logic exactly.
        let mut sample_payload: Vec<u8> = Vec::new();
        let mut is_keyframe = false;

        for i in 0..bs.num_layers() {
            let layer = bs
                .layer(i)
                .ok_or_else(|| EngineError::Encode("missing layer".into()))?;
            for j in 0..layer.nal_count() {
                let raw = layer
                    .nal_unit(j)
                    .ok_or_else(|| EngineError::Encode("missing NAL unit".into()))?;
                let body = strip_annex_b_prefix(raw);
                if body.is_empty() {
                    continue;
                }
                let nal_type = body[0] & 0x1F;
                match nal_type {
                    7 => {
                        // SPS — capture the first one.
                        if self.sps.is_empty() {
                            self.sps = body.to_vec();
                        }
                    }
                    8 => {
                        // PPS — capture the first one.
                        if self.pps.is_empty() {
                            self.pps = body.to_vec();
                        }
                    }
                    nt => {
                        // Coded slice (IDR = 5, non-IDR = 1, …). Write as AVCC
                        // length-prefixed NAL into the sample payload.
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
            let frame_duration_ms = 1000u64 / self.fps.max(1) as u64;
            self.encoded_frames.push(EncodedFrame {
                data: sample_payload,
                is_keyframe,
                pts_ms: self.frame_index * frame_duration_ms,
            });
        }

        self.frame_index += 1;
        Ok(())
    }

    /// Mux all buffered frames into an MP4 file at `out`.
    ///
    /// The file is created (or truncated if it already exists). The encoder is
    /// consumed — call [`Mp4Encoder::new`] for a fresh session.
    ///
    /// # Errors
    /// Returns [`EngineError::Encode`] if no SPS/PPS were produced, if the
    /// output file cannot be created, or if the mp4 writer fails.
    pub fn finish(self, out: &Path) -> Result<(), EngineError> {
        use mp4::{AvcConfig, MediaConfig, Mp4Config, Mp4Writer, TrackConfig, TrackType};

        if self.sps.is_empty() || self.pps.is_empty() {
            return Err(EngineError::Encode(
                "encoder produced no SPS/PPS; cannot mux MP4".into(),
            ));
        }

        let file =
            File::create(out).map_err(|e| EngineError::Encode(format!("create '{out:?}': {e}")))?;

        let cfg = Mp4Config {
            major_brand: (*b"mp42").into(),
            minor_version: 0,
            compatible_brands: vec![(*b"mp42").into(), (*b"isom").into()],
            timescale: 1000,
        };
        let mut writer = Mp4Writer::write_start(file, &cfg)
            .map_err(|e| EngineError::Encode(format!("mp4 write_start: {e}")))?;

        let track = TrackConfig {
            track_type: TrackType::Video,
            timescale: 1000,
            language: String::from("und"),
            media_conf: MediaConfig::AvcConfig(AvcConfig {
                width: self.width as u16,
                height: self.height as u16,
                seq_param_set: self.sps,
                pic_param_set: self.pps,
            }),
        };
        writer
            .add_track(&track)
            .map_err(|e| EngineError::Encode(format!("add_track: {e}")))?;

        let frame_duration_ms = (1000 / self.fps.max(1)).max(1);
        let frames = &self.encoded_frames;
        for (idx, ef) in frames.iter().enumerate() {
            // Use the inter-frame gap when the next frame is available;
            // fall back to the nominal frame duration for the last sample.
            let duration = if idx + 1 < frames.len() {
                (frames[idx + 1].pts_ms - ef.pts_ms).max(1) as u32
            } else {
                frame_duration_ms
            };
            let sample = mp4::Mp4Sample {
                start_time: ef.pts_ms,
                duration,
                rendering_offset: 0,
                is_sync: ef.is_keyframe,
                bytes: ef.data.clone().into(),
            };
            writer
                .write_sample(1, &sample)
                .map_err(|e| EngineError::Encode(format!("write_sample {idx}: {e}")))?;
        }

        writer
            .write_end()
            .map_err(|e| EngineError::Encode(format!("write_end: {e}")))?;

        Ok(())
    }
}

// ── RGBA → I420 conversion ────────────────────────────────────────────────────

/// Convert RGBA8 to I420 planar format using BT.601 coefficients.
///
/// The R, G, B channel layout is RGBA (R first) — the only difference from the
/// capture encoder's `bgra_to_i420` is that R and B are not swapped.
///
/// `width` and `height` must both be even (H.264 requirement).
fn rgba_to_i420(rgba: &[u8], width: usize, height: usize) -> Vec<u8> {
    debug_assert!(
        width % 2 == 0 && height % 2 == 0,
        "rgba_to_i420 requires even dimensions"
    );
    debug_assert_eq!(rgba.len(), width * height * 4, "RGBA buffer size mismatch");

    let y_size = width * height;
    let uv_size = y_size / 4;
    let mut out = vec![0u8; y_size + uv_size * 2];

    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) * 4;
            // RGBA channel order — contrast with BGRA in encoder.rs.
            let r = rgba[i] as f32;
            let g = rgba[i + 1] as f32;
            let b = rgba[i + 2] as f32;

            // BT.601 full-range → limited-range Y (same coefficients as encoder.rs).
            let yv = (0.257 * r + 0.504 * g + 0.098 * b + 16.0).clamp(0.0, 255.0) as u8;
            out[y * width + x] = yv;

            // Subsample chroma at every 2×2 block (top-left pixel).
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

// ── Strip Annex-B prefix ─────────────────────────────────────────────────────

/// Strip Annex-B start-code prefix (`00 00 00 01` or `00 00 01`) from a NAL
/// unit, returning the raw NAL body. If no prefix is present the slice is
/// returned unchanged.
fn strip_annex_b_prefix(nal: &[u8]) -> &[u8] {
    if nal.len() >= 4 && nal[0] == 0 && nal[1] == 0 && nal[2] == 0 && nal[3] == 1 {
        &nal[4..]
    } else if nal.len() >= 3 && nal[0] == 0 && nal[1] == 0 && nal[2] == 1 {
        &nal[3..]
    } else {
        nal
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_to_i420_produces_correct_plane_sizes() {
        // 4×4 I420 = 16 Y + 4 U + 4 V = 24 bytes total.
        let out = rgba_to_i420(&[128u8; 4 * 4 * 4], 4, 4);
        assert_eq!(out.len(), 4 * 4 + 4 + 4);
    }

    #[test]
    fn strip_annex_b_removes_four_byte_prefix() {
        let nal = [0x00, 0x00, 0x00, 0x01, 0x65, 0xAA];
        assert_eq!(strip_annex_b_prefix(&nal), &[0x65, 0xAA]);
    }

    #[test]
    fn strip_annex_b_removes_three_byte_prefix() {
        let nal = [0x00, 0x00, 0x01, 0x41, 0xBB];
        assert_eq!(strip_annex_b_prefix(&nal), &[0x41, 0xBB]);
    }

    #[test]
    fn strip_annex_b_passthrough_when_no_prefix() {
        let nal = [0x65, 0xAA];
        assert_eq!(strip_annex_b_prefix(&nal), &[0x65, 0xAA]);
    }

    #[test]
    fn mp4_encoder_new_succeeds() {
        Mp4Encoder::new(320, 240, 30).unwrap();
    }

    #[test]
    fn mp4_encoder_encodes_and_writes_file() {
        use std::env;
        let out = env::temp_dir().join("encode_unit_test.mp4");
        let mut enc = Mp4Encoder::new(320, 240, 30).unwrap();
        let rgba = vec![128u8; 320 * 240 * 4];
        for _ in 0..10 {
            enc.encode_rgba(&rgba).unwrap();
        }
        enc.finish(&out).unwrap();
        assert!(out.exists());
        assert!(out.metadata().unwrap().len() > 0);
    }
}
