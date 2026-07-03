//! MP4 demuxer + H.264 decoder producing RGBA8 frames.
//!
//! # AVCC → Annex-B conversion
//! The `mp4` crate returns samples as AVCC: each NAL unit is prefixed with a
//! 4-byte big-endian length field. openh264's decoder expects Annex-B format
//! (`00 00 00 01` start-code prefix). SPS/PPS parameter sets live in the
//! `avcC` config box — NOT in the sample data — so we extract them once on
//! `open` and prepend them (Annex-B) to the first keyframe's access unit.

use mp4::{Mp4Reader, TrackType};
use openh264::decoder::Decoder;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

/// A single decoded video frame in RGBA8 format (row-major, `width*height*4` bytes).
#[derive(Clone)]
pub struct RgbaFrame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// Errors that can occur during demux or decode.
#[derive(Debug)]
pub enum DecodeError {
    Io(std::io::Error),
    Demux(String),
    Codec(String),
    NoFrame,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::Io(e) => write!(f, "IO error: {e}"),
            DecodeError::Demux(s) => write!(f, "Demux error: {s}"),
            DecodeError::Codec(s) => write!(f, "Codec error: {s}"),
            DecodeError::NoFrame => write!(f, "No frame at requested index"),
        }
    }
}

impl std::error::Error for DecodeError {}

/// A source of decoded RGBA frames backed by a media file or synthetic generator.
///
/// Implementations are free to cache or decode lazily. The only contract is:
/// - `frame(i)` returns the correct RGBA frame for index `i`.
/// - Sequential access (`0, 1, 2, …`) SHOULD be efficient; random-access MUST be correct.
pub trait FrameSource {
    /// Returns `(width, height)` in pixels.
    fn dimensions(&self) -> (u32, u32);

    /// Total number of frames available.
    fn frame_count(&self) -> usize;

    /// Decode and return the RGBA frame at `index`.
    ///
    /// # Errors
    /// Returns [`DecodeError::NoFrame`] when `index >= frame_count()`.
    fn frame(&mut self, index: usize) -> Result<RgbaFrame, DecodeError>;
}

/// Reads an MP4 file on `open`, demuxes all H.264 samples into Annex-B access
/// units (held in memory), and decodes them one at a time via openh264.
///
/// # Forward-cursor cache
/// The decoder is kept alive between calls. `cursor` records the last frame index
/// that was produced. When `frame(i)` is called with `i == cursor + 1` the decoder
/// just receives the next access unit (O(1)). Any backwards or non-sequential
/// access resets the decoder and re-feeds from the beginning (O(n)).
pub struct Mp4FrameSource {
    decoder: Decoder,
    /// SPS + PPS packed as Annex-B (prepended to the first keyframe access unit).
    annexb_header: Vec<u8>,
    /// Per-sample Annex-B access units (AVCC length prefixes replaced with start codes).
    samples_annexb: Vec<Vec<u8>>,
    width: u32,
    height: u32,
    /// Index of the last frame that was successfully produced, or `None` if the
    /// decoder has never produced a frame since the last reset.
    cursor: Option<usize>,
}

impl FrameSource for Mp4FrameSource {
    fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn frame_count(&self) -> usize {
        self.samples_annexb.len()
    }

    /// Decode and return the frame at `index` using a forward-cursor strategy.
    ///
    /// # Forward path (O(1) amortised)
    /// When `index == cursor + 1` the existing decoder receives only the next
    /// access unit. This is the hot path for sequential export.
    ///
    /// # Reset path (O(n))
    /// Any other `index` (backwards seek, gap, or first call) recreates the
    /// decoder, feeds the Annex-B SPS+PPS header, then replays samples `0..=index`.
    fn frame(&mut self, index: usize) -> Result<RgbaFrame, DecodeError> {
        if index >= self.samples_annexb.len() {
            return Err(DecodeError::NoFrame);
        }

        // Determine whether we can use the forward path.
        let forward = matches!(self.cursor, Some(c) if index == c + 1);

        if forward {
            // Fast path: feed only the next access unit.
            let yuv_opt = self
                .decoder
                .decode(&self.samples_annexb[index])
                .map_err(|e| DecodeError::Codec(e.to_string()))?;

            if let Some(yuv) = yuv_opt {
                let frame = yuv_to_rgba(&yuv);
                self.cursor = Some(index);
                return Ok(frame);
            }
            // Decoder returned None despite feeding a real sample (warm-up artefact
            // on forward path is unexpected, but handle it defensively by falling
            // through to the reset path so the caller always gets a frame).
        }

        // Reset path: recreate decoder and replay from the beginning.
        self.decoder = Decoder::new().map_err(|e| DecodeError::Codec(e.to_string()))?;
        self.cursor = None;

        let mut last_frame: Option<RgbaFrame> = None;

        for i in 0..=index {
            // Prepend SPS+PPS header to the first access unit so the decoder has
            // parameter sets before it sees any slice data.
            let packet: Vec<u8> = if i == 0 {
                let mut p = self.annexb_header.clone();
                p.extend_from_slice(&self.samples_annexb[i]);
                p
            } else {
                self.samples_annexb[i].clone()
            };

            let yuv_opt = self
                .decoder
                .decode(&packet)
                .map_err(|e| DecodeError::Codec(e.to_string()))?;

            if let Some(yuv) = yuv_opt {
                last_frame = Some(yuv_to_rgba(&yuv));
            }
        }

        let frame = last_frame.ok_or(DecodeError::NoFrame)?;
        self.cursor = Some(index);
        Ok(frame)
    }
}

impl Mp4FrameSource {
    /// Open `path` and load all H.264 samples into memory as Annex-B access units.
    pub fn open(path: &Path) -> Result<Self, DecodeError> {
        let f = File::open(path).map_err(DecodeError::Io)?;
        let size = f.metadata().map_err(DecodeError::Io)?.len();
        let reader = BufReader::new(f);
        let mut mp4 =
            Mp4Reader::read_header(reader, size).map_err(|e| DecodeError::Demux(e.to_string()))?;

        // --- Locate the first video track ---
        let (track_id, width, height, sps, pps) = {
            let mut found = None;
            for track in mp4.tracks().values() {
                if track
                    .track_type()
                    .map_err(|e| DecodeError::Demux(e.to_string()))?
                    == TrackType::Video
                {
                    let w = track.width();
                    let h = track.height();

                    // Extract SPS/PPS from the avcC config box via the mp4 crate's
                    // dedicated accessors (`sequence_parameter_set` / `picture_parameter_set`).
                    let sps = track
                        .sequence_parameter_set()
                        .map_err(|e| DecodeError::Demux(e.to_string()))?
                        .to_vec();
                    let pps = track
                        .picture_parameter_set()
                        .map_err(|e| DecodeError::Demux(e.to_string()))?
                        .to_vec();

                    found = Some((track.track_id(), w as u32, h as u32, sps, pps));
                    break;
                }
            }
            found.ok_or_else(|| DecodeError::Demux("no video track found".into()))?
        };

        // Build the Annex-B SPS+PPS header: [00 00 00 01 <sps>] [00 00 00 01 <pps>]
        let mut annexb_header: Vec<u8> = Vec::new();
        annexb_header.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        annexb_header.extend_from_slice(&sps);
        annexb_header.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        annexb_header.extend_from_slice(&pps);

        // --- Read every sample and convert from AVCC to Annex-B ---
        let sample_count = mp4
            .tracks()
            .get(&track_id)
            .ok_or_else(|| DecodeError::Demux("track disappeared".into()))?
            .sample_count();

        let mut samples_annexb: Vec<Vec<u8>> = Vec::with_capacity(sample_count as usize);

        for sample_idx in 1..=sample_count {
            let sample = mp4
                .read_sample(track_id, sample_idx)
                .map_err(|e| DecodeError::Demux(e.to_string()))?
                .ok_or_else(|| DecodeError::Demux(format!("missing sample {sample_idx}")))?;

            let avcc = sample.bytes.as_ref();
            let annexb = avcc_to_annexb(avcc);
            samples_annexb.push(annexb);
        }

        // Create the decoder
        let decoder = Decoder::new().map_err(|e| DecodeError::Codec(e.to_string()))?;

        Ok(Self {
            decoder,
            annexb_header,
            samples_annexb,
            width,
            height,
            cursor: None,
        })
    }

    /// Returns `(width, height)` in pixels.
    ///
    /// This is a convenience forwarder to [`FrameSource::dimensions`].
    pub fn dimensions(&self) -> (u32, u32) {
        FrameSource::dimensions(self)
    }

    /// Number of video frames (samples) in the file.
    ///
    /// This is a convenience forwarder to [`FrameSource::frame_count`].
    pub fn frame_count(&self) -> usize {
        FrameSource::frame_count(self)
    }

    /// Decode and return the frame at `index`.
    ///
    /// Delegates to [`FrameSource::frame`], which uses a forward-cursor strategy
    /// (O(1) amortised for sequential access, O(n) on rewind/seek).
    pub fn decode_frame(&mut self, index: usize) -> Result<RgbaFrame, DecodeError> {
        FrameSource::frame(self, index)
    }
}

/// Convert a decoded YUV frame into an [`RgbaFrame`].
fn yuv_to_rgba(yuv: &openh264::decoder::DecodedYUV<'_>) -> RgbaFrame {
    use openh264::formats::YUVSource;
    let (w, h) = yuv.dimensions();
    let mut buf = vec![0u8; w * h * 4];
    yuv.write_rgba8(&mut buf);
    RgbaFrame {
        width: w as u32,
        height: h as u32,
        data: buf,
    }
}

/// Convert an AVCC-encoded buffer (4-byte big-endian NAL length prefix per NAL)
/// to Annex-B format (`00 00 00 01` start-code per NAL).
fn avcc_to_annexb(avcc: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(avcc.len() + 8);
    let mut pos = 0;
    while pos + 4 <= avcc.len() {
        let nal_len =
            u32::from_be_bytes([avcc[pos], avcc[pos + 1], avcc[pos + 2], avcc[pos + 3]]) as usize;
        pos += 4;
        if pos + nal_len > avcc.len() {
            break; // malformed; stop gracefully
        }
        out.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        out.extend_from_slice(&avcc[pos..pos + nal_len]);
        pos += nal_len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::avcc_to_annexb;

    #[test]
    fn avcc_to_annexb_single_nal() {
        // 4-byte length (3) + body [0x65, 0x00, 0xFF]
        let avcc = [0x00, 0x00, 0x00, 0x03, 0x65, 0x00, 0xFF];
        let out = avcc_to_annexb(&avcc);
        assert_eq!(out, [0x00, 0x00, 0x00, 0x01, 0x65, 0x00, 0xFF]);
    }

    #[test]
    fn avcc_to_annexb_two_nals() {
        // NAL1: length 2, body [0x41, 0x9A]; NAL2: length 1, body [0x65]
        let avcc = [
            0x00, 0x00, 0x00, 0x02, 0x41, 0x9A, 0x00, 0x00, 0x00, 0x01, 0x65,
        ];
        let out = avcc_to_annexb(&avcc);
        assert_eq!(
            out,
            [0x00, 0x00, 0x00, 0x01, 0x41, 0x9A, 0x00, 0x00, 0x00, 0x01, 0x65]
        );
    }
}
