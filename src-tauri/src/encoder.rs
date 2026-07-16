//! H.264 encoder + MP4 muxer. Wraps `openh264` for frame encoding and `mp4` for
//! container muxing. Accepts BGRA frames, converts to I420, encodes, writes to a
//! seekable MP4 file on finalize.

use crate::capture::{CaptureSink, Frame};
use crate::types::{CaptureQuality, VideoMetadata};
use std::fs::File;
use std::path::PathBuf;

/// Owns the openh264 encoder + pending encoded data for a single session.
/// The encoder is created once on `new()` and reused across frames — H.264
/// needs persistent state (SPS/PPS, reference frames).
pub struct Mp4EncoderSink {
    output_path: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
    #[allow(dead_code)]
    quality: CaptureQuality,
    has_audio: bool,
    /// Wall-clock recording start; passed through to VideoMetadata. Not used for
    /// frame timing — that's a fixed fps grid built at mux time.
    start_ms: i64,
    encoder: openh264::encoder::Encoder,
    /// Encoded access units (one per input frame, already AVCC length-prefixed,
    /// with parameter-set NAL units stripped off into `sps` / `pps`).
    encoded_frames: Vec<EncodedFrame>,
    sps: Vec<u8>,
    pps: Vec<u8>,
    /// I420 of the most recent real frame, cached so static gaps can be filled
    /// by re-emitting it (ScreenCaptureKit only delivers frames on content
    /// change, so without this a static screen produces a 1-frame video).
    last_i420: Option<Vec<u8>>,
}

struct EncodedFrame {
    data: Vec<u8>,
    is_keyframe: bool,
}

impl Mp4EncoderSink {
    pub fn new(
        output_path: PathBuf,
        width: u32,
        height: u32,
        fps: u32,
        quality: CaptureQuality,
        has_audio: bool,
        start_ms: i64,
    ) -> Result<Self, String> {
        use openh264::encoder::{Encoder, EncoderConfig, RateControlMode, SpsPpsStrategy};
        use openh264::OpenH264API;
        // openh264 defaults its target bitrate to 120 kbps — far too low for
        // sharp screen content (text/edges), which is the main reason recordings
        // look soft. Budget ~0.2 bits per pixel per frame (generous for a local
        // reference video) with a 4 Mbps floor so small captures still look
        // clean. Quality mode spends up to this budget where detail demands it
        // and stays small on static screens.
        let target_bps = (width as u64 * height as u64 * fps as u64 / 5)
            .max(4_000_000)
            .min(u32::MAX as u64) as u32;
        let cfg = EncoderConfig::new()
            .sps_pps_strategy(SpsPpsStrategy::ConstantId)
            .max_frame_rate(fps as f32)
            .rate_control_mode(RateControlMode::Quality)
            .set_bitrate_bps(target_bps);
        let api = OpenH264API::from_source();
        let encoder = Encoder::with_api_config(api, cfg).map_err(|e| e.to_string())?;
        let _ = quality; // CRF mapping used by future platform-native encoder; openh264 tuning deferred.
        Ok(Self {
            output_path,
            width,
            height,
            fps,
            quality,
            has_audio,
            start_ms,
            encoder,
            encoded_frames: Vec::new(),
            sps: Vec::new(),
            pps: Vec::new(),
            last_i420: None,
        })
    }

    fn encode_frame(&mut self, frame: &Frame) -> Result<(), String> {
        // The frame is native resolution; scale it to the encode size while
        // converting to I420 in a single fused parallel pass (no intermediate
        // resize buffer). self.width/height are the (smaller) encode dimensions.
        let yuv = bgra_to_i420_scaled(
            &frame.data,
            frame.width as usize,
            frame.height as usize,
            self.width as usize,
            self.height as usize,
        );
        self.last_i420 = Some(yuv.clone());
        self.encode_yuv(yuv)
    }

    /// Encode one I420 buffer and buffer the resulting access unit. Frame timing
    /// is assigned at mux time (fixed fps grid), so no timestamp is needed here.
    /// Shared by `encode_frame` and `repeat_last`.
    fn encode_yuv(&mut self, yuv: Vec<u8>) -> Result<(), String> {
        use openh264::formats::YUVBuffer;

        let yuv_buf = YUVBuffer::from_vec(yuv, self.width as usize, self.height as usize);
        let bs = self.encoder.encode(&yuv_buf).map_err(|e| e.to_string())?;

        // openh264 emits NAL units in Annex-B format (start-code prefixed). MP4
        // (AVCC / avc1) requires length-prefixed NAL units with SPS/PPS stored
        // separately in the sample description. Walk every NAL in the access
        // unit, splitting parameter sets from coded slices.
        let mut sample_payload: Vec<u8> = Vec::new();
        let mut is_keyframe = false;
        for i in 0..bs.num_layers() {
            let layer = bs.layer(i).ok_or("missing layer")?;
            for j in 0..layer.nal_count() {
                let raw = layer.nal_unit(j).ok_or("missing nal")?;
                let body = strip_annex_b_prefix(raw);
                if body.is_empty() {
                    continue;
                }
                let nal_type = body[0] & 0x1F;
                match nal_type {
                    7 => {
                        // SPS — remember the first one we see.
                        if self.sps.is_empty() {
                            self.sps = body.to_vec();
                        }
                    }
                    8 => {
                        // PPS — remember the first one we see.
                        if self.pps.is_empty() {
                            self.pps = body.to_vec();
                        }
                    }
                    nt => {
                        // Coded slice (IDR=5, non-IDR=1, etc). Append to the sample
                        // payload as an AVCC length-prefixed NAL.
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
            self.encoded_frames.push(EncodedFrame {
                data: sample_payload,
                is_keyframe,
            });
        }
        Ok(())
    }
}

impl CaptureSink for Mp4EncoderSink {
    fn on_frame(&mut self, frame: &Frame) -> Result<(), String> {
        self.encode_frame(frame)
    }

    /// Re-emit the last real frame at `timestamp_ms` to fill a static gap.
    /// No-op until the first real frame has been encoded.
    fn repeat_last(&mut self, _timestamp_ms: i64) -> Result<(), String> {
        let Some(yuv) = self.last_i420.clone() else {
            return Ok(());
        };
        self.encode_yuv(yuv)
    }

    fn finalize(mut self: Box<Self>) -> Result<VideoMetadata, String> {
        use mp4::{AvcConfig, MediaConfig, Mp4Config, Mp4Writer, TrackConfig, TrackType};

        if self.sps.is_empty() || self.pps.is_empty() {
            return Err("encoder produced no SPS/PPS; cannot mux MP4".into());
        }
        // Re-time onto an even fps grid (below): duration is frame_count / fps.
        let frame_duration = (1000 / self.fps).max(1);
        let duration_ms = self.encoded_frames.len() as i64 * frame_duration as i64;

        let file = File::create(&self.output_path).map_err(|e| e.to_string())?;
        let cfg = Mp4Config {
            major_brand: (*b"mp42").into(),
            minor_version: 0,
            compatible_brands: vec![(*b"mp42").into(), (*b"isom").into()],
            timescale: 1000,
        };
        let mut writer = Mp4Writer::write_start(file, &cfg).map_err(|e| e.to_string())?;
        let track = TrackConfig {
            track_type: TrackType::Video,
            timescale: 1000,
            language: String::from("und"),
            media_conf: MediaConfig::AvcConfig(AvcConfig {
                width: self.width as u16,
                height: self.height as u16,
                seq_param_set: self.sps.clone(),
                pic_param_set: self.pps.clone(),
            }),
        };
        writer.add_track(&track).map_err(|e| e.to_string())?;

        // Constant frame rate: every frame gets the same duration and sits on an
        // even time grid. Captured timestamps jitter (SCK delivery isn't evenly
        // spaced), which made playback stutter under variable-duration muxing;
        // the steady-rate encoder already emits ~one frame per interval, so a
        // fixed cadence preserves the right length and plays back smoothly.
        // Consume each access unit as it is muxed. Cloning here temporarily
        // doubled the buffered video memory at stop time, which is especially
        // painful on Windows after longer/high-resolution recordings.
        for (idx, ef) in self.encoded_frames.drain(..).enumerate() {
            let sample = mp4::Mp4Sample {
                start_time: idx as u64 * frame_duration as u64,
                duration: frame_duration,
                rendering_offset: 0,
                is_sync: ef.is_keyframe,
                bytes: ef.data.into(),
            };
            writer.write_sample(1, &sample).map_err(|e| e.to_string())?;
        }
        writer.write_end().map_err(|e| e.to_string())?;

        Ok(VideoMetadata {
            path: self
                .output_path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            start_ms: self.start_ms,
            duration_ms,
            width: self.width,
            height: self.height,
            fps: self.fps,
            has_audio: self.has_audio,
        })
    }
}

/// Strip Annex-B start-code prefix (`0x00 0x00 0x00 0x01` or `0x00 0x00 0x01`)
/// from a NAL unit, returning just the NAL body. If no prefix is present the
/// slice is returned as-is.
fn strip_annex_b_prefix(nal: &[u8]) -> &[u8] {
    if nal.len() >= 4 && nal[0] == 0 && nal[1] == 0 && nal[2] == 0 && nal[3] == 1 {
        &nal[4..]
    } else if nal.len() >= 3 && nal[0] == 0 && nal[1] == 0 && nal[2] == 1 {
        &nal[3..]
    } else {
        nal
    }
}

/// Fused area-averaging (box-filter) downscale + BGRA→I420 conversion (BT.601,
/// fixed-point), parallelized across rows with rayon. Each destination pixel is
/// the mean of the source-pixel block it covers, so fine detail and text stay
/// crisp instead of aliasing the way nearest-neighbor does on a 2×+ reduction.
/// Writes I420 at `(dst_w, dst_h)` directly — no intermediate resize buffer, no
/// image crate. `dst_w`/`dst_h` must be even and `<= src`. Each source pixel is
/// touched a small constant number of times, so this stays real-time at 1080p
/// from a 4K/5K source.
fn bgra_to_i420_scaled(
    src: &[u8],
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
) -> Vec<u8> {
    use rayon::prelude::*;

    debug_assert!(dst_w.is_multiple_of(2) && dst_h.is_multiple_of(2));
    debug_assert_eq!(src.len(), src_w * src_h * 4, "bgra buffer size mismatch");

    let y_size = dst_w * dst_h;
    let uv_w = dst_w / 2;
    let uv_h = dst_h / 2;
    let uv_size = uv_w * uv_h;
    let mut out = vec![0u8; y_size + uv_size * 2];

    // Source-pixel span [start, end) covering each destination column/row. The
    // box that maps to a destination pixel is the rectangle of these spans.
    let col_span = |d: usize, dst: usize, span: usize| {
        let s0 = d * span / dst;
        let s1 = ((d + 1) * span / dst).max(s0 + 1).min(span);
        (s0, s1)
    };
    let xspans: Vec<(usize, usize)> = (0..dst_w).map(|dx| col_span(dx, dst_w, src_w)).collect();
    let yspans: Vec<(usize, usize)> = (0..dst_h).map(|dy| col_span(dy, dst_h, src_h)).collect();

    // Mean B,G,R over the source rectangle [x0,x1)×[y0,y1).
    let block_mean = |x0: usize, x1: usize, y0: usize, y1: usize| -> (i32, i32, i32) {
        let (mut sb, mut sg, mut sr) = (0u32, 0u32, 0u32);
        for sy in y0..y1 {
            let base = sy * src_w * 4;
            for sx in x0..x1 {
                let i = base + sx * 4;
                sb += src[i] as u32;
                sg += src[i + 1] as u32;
                sr += src[i + 2] as u32;
            }
        }
        let n = ((x1 - x0) * (y1 - y0)) as u32;
        ((sb / n) as i32, (sg / n) as i32, (sr / n) as i32)
    };

    let (y_plane, uv_planes) = out.split_at_mut(y_size);
    let (u_plane, v_plane) = uv_planes.split_at_mut(uv_size);

    y_plane
        .par_chunks_mut(dst_w)
        .enumerate()
        .for_each(|(dy, row)| {
            let (y0, y1) = yspans[dy];
            for (dx, yv) in row.iter_mut().enumerate() {
                let (x0, x1) = xspans[dx];
                let (b, g, r) = block_mean(x0, x1, y0, y1);
                *yv = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16).clamp(0, 255) as u8;
            }
        });

    // Chroma is subsampled 2×, so each U/V pixel averages the source block under
    // the corresponding 2×2 destination-pixel quad.
    u_plane
        .par_chunks_mut(uv_w)
        .zip(v_plane.par_chunks_mut(uv_w))
        .enumerate()
        .for_each(|(uy, (urow, vrow))| {
            let y0 = yspans[uy * 2].0;
            let y1 = yspans[uy * 2 + 1].1;
            for ux in 0..uv_w {
                let x0 = xspans[ux * 2].0;
                let x1 = xspans[ux * 2 + 1].1;
                let (b, g, r) = block_mean(x0, x1, y0, y1);
                urow[ux] = (((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
                vrow[ux] = (((112 * r - 94 * g - 18 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
            }
        });

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn synthetic_frame(width: u32, height: u32, ts: i64) -> Frame {
        Frame {
            width,
            height,
            data: vec![128; (width * height * 4) as usize],
            timestamp_ms: ts,
        }
    }

    #[test]
    fn bgra_to_i420_produces_correct_plane_sizes() {
        // 4x4 I420 = 16 Y + 4 U + 4 V = 24 bytes (no scaling: src == dst).
        let out = bgra_to_i420_scaled(&[128u8; 4 * 4 * 4], 4, 4, 4, 4);
        assert_eq!(out.len(), 4 * 4 + 4 + 4);
    }

    #[test]
    fn bgra_to_i420_scaled_downscales_to_target_size() {
        // 8x8 source -> 4x4 target: output is the 4x4 I420 size (24 bytes).
        let out = bgra_to_i420_scaled(&[200u8; 8 * 8 * 4], 8, 8, 4, 4);
        assert_eq!(out.len(), 4 * 4 + 4 + 4);
    }

    #[test]
    fn bgra_to_i420_scaled_area_averages_source_blocks() {
        // 4x4 grayscale source -> 2x2 target. The top-left target pixel covers
        // the 2x2 source block {(0,0),(1,0),(0,1),(1,1)}. Only (1,1) is bright
        // (gray 100); the other three are 0. An area filter averages the block
        // (mean gray 25); nearest-neighbor would sample the (0,0) corner (gray
        // 0). The resulting luma tells the two apart.
        let mut src = vec![0u8; 4 * 4 * 4];
        let set_px = |buf: &mut [u8], x: usize, y: usize, gray: u8| {
            let i = (y * 4 + x) * 4;
            buf[i] = gray; // B
            buf[i + 1] = gray; // G
            buf[i + 2] = gray; // R
        };
        set_px(&mut src, 1, 1, 100);

        let out = bgra_to_i420_scaled(&src, 4, 4, 2, 2);
        let top_left_y = out[0];

        // BT.601 luma of mean gray 25: ((66+129+25)*25 + 128) >> 8 + 16 = 37.
        // Nearest-neighbor (corner gray 0) would give 16.
        assert_eq!(top_left_y, 37, "expected area-averaged luma, got nearest");
    }

    #[test]
    fn encoder_finalizes_produces_mp4() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("out.mp4");
        let mut sink = Box::new(
            Mp4EncoderSink::new(path.clone(), 320, 240, 30, CaptureQuality::Med, false, 1000)
                .unwrap(),
        );
        for i in 0..10 {
            sink.on_frame(&synthetic_frame(320, 240, 1000 + i * 33))
                .unwrap();
        }
        let meta = sink.finalize().unwrap();
        assert!(path.exists());
        assert!(path.metadata().unwrap().len() > 0);
        assert_eq!(meta.width, 320);
        assert_eq!(meta.height, 240);
        assert_eq!(meta.fps, 30);
    }
}
