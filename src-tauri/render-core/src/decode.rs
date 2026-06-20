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

/// Reads an MP4 file on `open`, demuxes all H.264 samples into Annex-B access
/// units (held in memory), and decodes them one at a time via openh264.
///
/// # Sequential decode
/// openh264 is a stateful decoder: it must receive frames in order. For this
/// spike, `decode_frame(index)` feeds all samples from 0 through `index`,
/// returning the last decoded RGBA frame. Frame-level caching is a Phase-1 concern.
pub struct Mp4FrameSource {
    decoder: Decoder,
    /// SPS + PPS packed as Annex-B (prepended to the first keyframe access unit).
    annexb_header: Vec<u8>,
    /// Per-sample Annex-B access units (AVCC length prefixes replaced with start codes).
    samples_annexb: Vec<Vec<u8>>,
    width: u32,
    height: u32,
}

impl Mp4FrameSource {
    /// Open `path` and load all H.264 samples into memory as Annex-B access units.
    pub fn open(path: &Path) -> Result<Self, DecodeError> {
        let f = File::open(path).map_err(DecodeError::Io)?;
        let size = f.metadata().map_err(DecodeError::Io)?.len();
        let reader = BufReader::new(f);
        let mut mp4 = Mp4Reader::read_header(reader, size)
            .map_err(|e| DecodeError::Demux(e.to_string()))?;

        // --- Locate the first video track ---
        let (track_id, width, height, sps, pps) = {
            let mut found = None;
            for track in mp4.tracks().values() {
                if track.track_type().map_err(|e| DecodeError::Demux(e.to_string()))?
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
        })
    }

    /// Returns `(width, height)` in pixels.
    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Number of video frames (samples) in the file.
    pub fn frame_count(&self) -> usize {
        self.samples_annexb.len()
    }

    /// Decode and return the frame at `index`.
    ///
    /// Because openh264 is stateful this resets the decoder and feeds all
    /// samples from 0 through `index`, returning the RGBA frame for `index`.
    /// This is the correct spike behaviour; caching is deferred to Phase 1.
    pub fn decode_frame(&mut self, index: usize) -> Result<RgbaFrame, DecodeError> {
        if index >= self.samples_annexb.len() {
            return Err(DecodeError::NoFrame);
        }

        // Reset the decoder so we can seek to any index safely.
        self.decoder = Decoder::new().map_err(|e| DecodeError::Codec(e.to_string()))?;

        let mut last_frame: Option<RgbaFrame> = None;

        for i in 0..=index {
            // For the very first sample prepend the SPS+PPS Annex-B header so
            // the decoder has parameter sets before it sees slice data.
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
                use openh264::formats::YUVSource;
                let (w, h) = yuv.dimensions(); // (usize, usize) from YUVSource trait
                let mut buf = vec![0u8; w * h * 4];
                yuv.write_rgba8(&mut buf);
                last_frame = Some(RgbaFrame {
                    width: w as u32,
                    height: h as u32,
                    data: buf,
                });
            }
        }

        last_frame.ok_or(DecodeError::NoFrame)
    }
}

/// Convert an AVCC-encoded buffer (4-byte big-endian NAL length prefix per NAL)
/// to Annex-B format (`00 00 00 01` start-code per NAL).
fn avcc_to_annexb(avcc: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(avcc.len() + 8);
    let mut pos = 0;
    while pos + 4 <= avcc.len() {
        let nal_len = u32::from_be_bytes([avcc[pos], avcc[pos + 1], avcc[pos + 2], avcc[pos + 3]])
            as usize;
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
        let avcc = [0x00, 0x00, 0x00, 0x02, 0x41, 0x9A, 0x00, 0x00, 0x00, 0x01, 0x65];
        let out = avcc_to_annexb(&avcc);
        assert_eq!(
            out,
            [0x00, 0x00, 0x00, 0x01, 0x41, 0x9A, 0x00, 0x00, 0x00, 0x01, 0x65]
        );
    }
}
