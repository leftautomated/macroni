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
    start_ms: i64,
    last_frame_ms: i64,
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
    // Perf instrumentation, averaged + logged on finalize.
    convert_ns: u128,
    convert_count: u64,
    encode_ns: u128,
    encode_count: u64,
}

struct EncodedFrame {
    data: Vec<u8>,
    is_keyframe: bool,
    pts_ms: i64,
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
        use openh264::encoder::{Encoder, EncoderConfig, SpsPpsStrategy};
        use openh264::OpenH264API;
        let cfg = EncoderConfig::new()
            .sps_pps_strategy(SpsPpsStrategy::ConstantId)
            .max_frame_rate(fps as f32);
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
            last_frame_ms: start_ms,
            encoder,
            encoded_frames: Vec::new(),
            sps: Vec::new(),
            pps: Vec::new(),
            last_i420: None,
            convert_ns: 0,
            convert_count: 0,
            encode_ns: 0,
            encode_count: 0,
        })
    }

    fn encode_frame(&mut self, frame: &Frame) -> Result<(), String> {
        let t = std::time::Instant::now();
        let yuv = bgra_to_i420(&frame.data, self.width as usize, self.height as usize);
        self.convert_ns += t.elapsed().as_nanos();
        self.convert_count += 1;
        self.last_i420 = Some(yuv.clone());
        self.last_frame_ms = frame.timestamp_ms;
        let pts_ms = frame.timestamp_ms - self.start_ms;
        self.encode_yuv(yuv, pts_ms)
    }

    /// Encode one I420 buffer at the given (start-relative) pts and buffer the
    /// resulting access unit. Shared by `encode_frame` and `repeat_last`.
    fn encode_yuv(&mut self, yuv: Vec<u8>, pts_ms: i64) -> Result<(), String> {
        use openh264::formats::YUVBuffer;

        let yuv_buf = YUVBuffer::from_vec(yuv, self.width as usize, self.height as usize);
        let t = std::time::Instant::now();
        let bs = self.encoder.encode(&yuv_buf).map_err(|e| e.to_string())?;
        self.encode_ns += t.elapsed().as_nanos();
        self.encode_count += 1;

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
                pts_ms,
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
    fn repeat_last(&mut self, timestamp_ms: i64) -> Result<(), String> {
        let Some(yuv) = self.last_i420.clone() else {
            return Ok(());
        };
        self.last_frame_ms = timestamp_ms;
        let pts_ms = timestamp_ms - self.start_ms;
        self.encode_yuv(yuv, pts_ms)
    }

    fn finalize(self: Box<Self>) -> Result<VideoMetadata, String> {
        use mp4::{AvcConfig, MediaConfig, Mp4Config, Mp4Writer, TrackConfig, TrackType};

        let duration_ms = self.last_frame_ms - self.start_ms;
        if self.sps.is_empty() || self.pps.is_empty() {
            return Err("encoder produced no SPS/PPS; cannot mux MP4".into());
        }

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

        let frame_duration = (1000 / self.fps).max(1);
        let frames = &self.encoded_frames;
        for (idx, ef) in frames.iter().enumerate() {
            let duration = if idx + 1 < frames.len() {
                (frames[idx + 1].pts_ms - ef.pts_ms).max(1) as u32
            } else {
                frame_duration.max(1)
            };
            let sample = mp4::Mp4Sample {
                start_time: ef.pts_ms.max(0) as u64,
                duration,
                rendering_offset: 0,
                is_sync: ef.is_keyframe,
                bytes: ef.data.clone().into(),
            };
            writer.write_sample(1, &sample).map_err(|e| e.to_string())?;
        }
        writer.write_end().map_err(|e| e.to_string())?;

        if self.convert_count > 0 && self.encode_count > 0 {
            eprintln!(
                "encoder: avg convert {}ms ({} frames), encode {}ms ({} frames)",
                self.convert_ns / 1_000_000 / self.convert_count as u128,
                self.convert_count,
                self.encode_ns / 1_000_000 / self.encode_count as u128,
                self.encode_count,
            );
        }

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

/// BGRA → I420 planar conversion, BT.601, fixed-point integer math, parallelized
/// across rows with rayon. Float math + a single thread was the encode-pipeline
/// bottleneck; this keeps software encode real-time at 1080p.
fn bgra_to_i420(bgra: &[u8], width: usize, height: usize) -> Vec<u8> {
    use rayon::prelude::*;

    debug_assert!(
        width.is_multiple_of(2) && height.is_multiple_of(2),
        "bgra_to_i420 requires even dimensions"
    );
    debug_assert_eq!(bgra.len(), width * height * 4, "bgra buffer size mismatch");

    let y_size = width * height;
    let uv_w = width / 2;
    let uv_h = height / 2;
    let uv_size = uv_w * uv_h;
    let mut out = vec![0u8; y_size + uv_size * 2];
    let (y_plane, uv_planes) = out.split_at_mut(y_size);
    let (u_plane, v_plane) = uv_planes.split_at_mut(uv_size);

    // Y plane: one output row per source row, computed in parallel.
    y_plane
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            let base = y * width * 4;
            for (x, yv) in row.iter_mut().enumerate() {
                let i = base + x * 4;
                let b = bgra[i] as i32;
                let g = bgra[i + 1] as i32;
                let r = bgra[i + 2] as i32;
                *yv = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16).clamp(0, 255) as u8;
            }
        });

    // U/V planes: 4:2:0 subsampling, top-left of each 2x2 block, in parallel.
    u_plane
        .par_chunks_mut(uv_w)
        .zip(v_plane.par_chunks_mut(uv_w))
        .enumerate()
        .for_each(|(uy, (urow, vrow))| {
            let base = (uy * 2) * width * 4;
            for ux in 0..uv_w {
                let i = base + (ux * 2) * 4;
                let b = bgra[i] as i32;
                let g = bgra[i + 1] as i32;
                let r = bgra[i + 2] as i32;
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
        // 4x4 I420 = 16 Y bytes + 4 U bytes + 4 V bytes = 24 total.
        let out = bgra_to_i420(&[128u8; 4 * 4 * 4], 4, 4);
        assert_eq!(out.len(), 4 * 4 + 4 + 4);
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
