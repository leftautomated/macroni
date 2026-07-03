use render_core::decode::RgbaFrame;

use super::extractor::{region_to_pixels, Extractor};
use super::{ObservationResult, Region};

pub struct TemplateMatcher {
    pub template: RgbaFrame,
    pub threshold: f32,
    /// Dimensions of the source frame the template was cropped from.
    pub source_px: [u32; 2],
}

fn to_luma(f: &RgbaFrame) -> Vec<f32> {
    f.data
        .chunks_exact(4)
        .map(|p| 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32)
        .collect()
}

fn resize_nearest(src: &[f32], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<f32> {
    let mut out = Vec::with_capacity((dw * dh) as usize);
    for y in 0..dh {
        let sy = (y as u64 * sh as u64 / dh as u64).min(sh as u64 - 1) as u32;
        for x in 0..dw {
            let sx = (x as u64 * sw as u64 / dw as u64).min(sw as u64 - 1) as u32;
            out.push(src[(sy * sw + sx) as usize]);
        }
    }
    out
}

impl Extractor for TemplateMatcher {
    fn extract(&self, frame: &RgbaFrame, region: &Region) -> ObservationResult {
        let none = |score: f32| ObservationResult::Template {
            matched: false,
            location: None,
            score,
        };
        let (x0, y0, cw, ch) = region_to_pixels(region, frame.width, frame.height);
        if cw == 0 || ch == 0 || self.template.width == 0 || self.template.height == 0 {
            return none(0.0);
        }
        // Scale the template by the ratio of the evaluated frame to its source frame.
        let tw = ((self.template.width as f32 * frame.width as f32
            / self.source_px[0].max(1) as f32)
            .round() as u32)
            .max(1);
        let th = ((self.template.height as f32 * frame.height as f32
            / self.source_px[1].max(1) as f32)
            .round() as u32)
            .max(1);
        if tw > cw || th > ch {
            return none(0.0);
        }
        let hay = to_luma(frame);
        let tpl_full = to_luma(&self.template);
        let tpl = resize_nearest(&tpl_full, self.template.width, self.template.height, tw, th);

        let n = (tw * th) as f32;
        let t_mean = tpl.iter().sum::<f32>() / n;
        let t_dev: Vec<f32> = tpl.iter().map(|v| v - t_mean).collect();
        let t_var: f32 = t_dev.iter().map(|v| v * v).sum();

        let mut best = (f32::MIN, 0u32, 0u32);
        for oy in 0..=(ch - th) {
            for ox in 0..=(cw - tw) {
                let (mut sum, mut sum_sq, mut cross) = (0.0f32, 0.0f32, 0.0f32);
                for ty in 0..th {
                    for tx in 0..tw {
                        let v = hay[((y0 + oy + ty) * frame.width + x0 + ox + tx) as usize];
                        sum += v;
                        sum_sq += v * v;
                        cross += v * t_dev[(ty * tw + tx) as usize];
                    }
                }
                let w_var = sum_sq - sum * sum / n;
                let den = (w_var * t_var).sqrt();
                let score = if den > 1e-6 { cross / den } else { 0.0 };
                if score > best.0 {
                    best = (score, ox, oy);
                }
            }
        }
        let (score, bx, by) = best;
        let location = Region {
            x: (x0 + bx) as f32 / frame.width as f32,
            y: (y0 + by) as f32 / frame.height as f32,
            w: tw as f32 / frame.width as f32,
            h: th as f32 / frame.height as f32,
        };
        ObservationResult::Template {
            matched: score >= self.threshold,
            location: Some(location),
            score,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::perception::{ObservationResult, Region};
    use render_core::decode::RgbaFrame;

    /// Black frame with a white w×h block at (x, y).
    fn frame_with_block(fw: u32, fh: u32, x: u32, y: u32, w: u32, h: u32) -> RgbaFrame {
        let mut data = vec![0u8; (fw * fh * 4) as usize];
        for py in y..y + h {
            for px in x..x + w {
                let i = ((py * fw + px) * 4) as usize;
                data[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
        RgbaFrame {
            width: fw,
            height: fh,
            data,
        }
    }

    #[test]
    fn planted_template_found_at_location_with_high_score() {
        let frame = frame_with_block(16, 16, 8, 4, 4, 4);
        let tpl = frame_with_block(4, 4, 0, 0, 4, 4); // all-white 4×4… degenerate: add a black pixel
        let mut tpl = tpl;
        tpl.data[0..4].copy_from_slice(&[0, 0, 0, 255]);
        let mut frame = frame;
        let i = ((4 * 16 + 8) * 4) as usize;
        frame.data[i..i + 4].copy_from_slice(&[0, 0, 0, 255]);
        let m = TemplateMatcher {
            template: tpl,
            threshold: 0.9,
            source_px: [16, 16],
        };
        match m.extract(
            &frame,
            &Region {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
        ) {
            ObservationResult::Template {
                matched: true,
                location: Some(loc),
                score,
            } => {
                assert!(score > 0.99, "score {score}");
                assert!(
                    (loc.x - 0.5).abs() < 0.04 && (loc.y - 0.25).abs() < 0.04,
                    "{loc:?}"
                );
            }
            other => panic!("expected match: {other:?}"),
        }
    }

    #[test]
    fn near_miss_scores_below_threshold() {
        let frame = frame_with_block(16, 16, 0, 0, 0, 0); // all black
        let mut tpl = frame_with_block(4, 4, 0, 0, 2, 2); // checker-ish
        tpl.data[60..64].copy_from_slice(&[255, 255, 255, 255]);
        let m = TemplateMatcher {
            template: tpl,
            threshold: 0.8,
            source_px: [16, 16],
        };
        match m.extract(
            &frame,
            &Region {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
        ) {
            ObservationResult::Template { matched, .. } => assert!(!matched),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn template_recorded_at_double_resolution_still_matches_after_ratio_scaling() {
        // Frame is 16×16; the template was cropped from a 32×32 source (2×),
        // so it is 8×8 but must be evaluated at 4×4.
        let frame = frame_with_block(16, 16, 8, 4, 4, 4);
        let tpl = frame_with_block(8, 8, 0, 0, 8, 8);
        let mut tpl = tpl;
        tpl.data[0..4].copy_from_slice(&[0, 0, 0, 255]);
        let mut frame = frame;
        let i = ((4 * 16 + 8) * 4) as usize;
        frame.data[i..i + 4].copy_from_slice(&[0, 0, 0, 255]);
        let m = TemplateMatcher {
            template: tpl,
            threshold: 0.6,
            source_px: [32, 32],
        };
        match m.extract(
            &frame,
            &Region {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
        ) {
            ObservationResult::Template {
                matched,
                location,
                score,
            } => {
                assert!(matched, "score {score} loc {location:?}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn template_larger_than_region_reports_unmatched_zero_score() {
        let frame = frame_with_block(8, 8, 0, 0, 2, 2);
        let tpl = frame_with_block(6, 6, 0, 0, 2, 2);
        let m = TemplateMatcher {
            template: tpl,
            threshold: 0.5,
            source_px: [8, 8],
        };
        match m.extract(
            &frame,
            &Region {
                x: 0.0,
                y: 0.0,
                w: 0.25,
                h: 0.25,
            },
        ) {
            ObservationResult::Template {
                matched: false,
                location: None,
                score,
            } => {
                assert_eq!(score, 0.0);
            }
            other => panic!("{other:?}"),
        }
    }
}
