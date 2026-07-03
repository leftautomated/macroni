//! Extractor seam. All extractors consume RGBA8 frames (top-left origin);
//! sources are responsible for converting into this pixel order (convert.rs).

use render_core::decode::RgbaFrame;

use super::{ObservationResult, Region};

pub trait Extractor {
    fn extract(&self, frame: &RgbaFrame, region: &Region) -> ObservationResult;
}

pub fn region_to_pixels(region: &Region, w: u32, h: u32) -> (u32, u32, u32, u32) {
    if w == 0 || h == 0 {
        return (0, 0, 0, 0);
    }
    let c = |v: f32| v.clamp(0.0, 1.0);
    let x0 = ((c(region.x) * w as f32).floor() as u32).min(w - 1);
    let y0 = ((c(region.y) * h as f32).floor() as u32).min(h - 1);
    let x1 = ((c(region.x + region.w) * w as f32).ceil() as u32).clamp(x0 + 1, w);
    let y1 = ((c(region.y + region.h) * h as f32).ceil() as u32).clamp(y0 + 1, h);
    (x0, y0, x1 - x0, y1 - y0)
}

pub fn crop_frame(frame: &RgbaFrame, region: &Region) -> RgbaFrame {
    let (x0, y0, cw, ch) = region_to_pixels(region, frame.width, frame.height);
    let mut data = Vec::with_capacity((cw * ch * 4) as usize);
    for y in y0..y0 + ch {
        let start = ((y * frame.width + x0) * 4) as usize;
        data.extend_from_slice(&frame.data[start..start + (cw * 4) as usize]);
    }
    RgbaFrame {
        width: cw,
        height: ch,
        data,
    }
}

/// Vision reports boxes normalized to the *crop*, origin bottom-left.
/// Flip to top-left and compose into full-frame normalized coordinates.
#[allow(dead_code)] // consumed by Task 7 (OCR: maps vision-reported boxes back to frame coords)
pub fn vision_box_to_region(bx: f32, by: f32, bw: f32, bh: f32, crop: &Region) -> Region {
    let top_left_y = 1.0 - by - bh;
    Region {
        x: crop.x + bx * crop.w,
        y: crop.y + top_left_y * crop.h,
        w: bw * crop.w,
        h: bh * crop.h,
    }
}

pub struct ColorSampler {
    pub rgb: [u8; 3],
    pub tolerance: f32,
}

impl Extractor for ColorSampler {
    fn extract(&self, frame: &RgbaFrame, region: &Region) -> ObservationResult {
        let (x0, y0, cw, ch) = region_to_pixels(region, frame.width, frame.height);
        if cw == 0 || ch == 0 {
            return ObservationResult::Color {
                rgb: [0, 0, 0],
                matched: false,
            };
        }
        let (mut r, mut g, mut b) = (0u64, 0u64, 0u64);
        for y in y0..y0 + ch {
            for x in x0..x0 + cw {
                let i = ((y * frame.width + x) * 4) as usize;
                r += frame.data[i] as u64;
                g += frame.data[i + 1] as u64;
                b += frame.data[i + 2] as u64;
            }
        }
        let n = cw as u64 * ch as u64;
        let avg = [(r / n) as u8, (g / n) as u8, (b / n) as u8];
        let max_diff = avg
            .iter()
            .zip(self.rgb.iter())
            .map(|(a, e)| (*a as f32 - *e as f32).abs())
            .fold(0.0f32, f32::max);
        ObservationResult::Color {
            rgb: avg,
            matched: max_diff <= self.tolerance,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use render_core::decode::RgbaFrame;

    fn solid(w: u32, h: u32, rgba: [u8; 4]) -> RgbaFrame {
        RgbaFrame {
            width: w,
            height: h,
            data: rgba
                .iter()
                .copied()
                .cycle()
                .take((w * h * 4) as usize)
                .collect(),
        }
    }

    #[test]
    fn region_to_pixels_round_trips_and_clamps() {
        let r = Region {
            x: 0.25,
            y: 0.5,
            w: 0.5,
            h: 0.25,
        };
        assert_eq!(region_to_pixels(&r, 100, 200), (25, 100, 50, 50)); // non-square aspect
        let wild = Region {
            x: -1.0,
            y: 0.9,
            w: 5.0,
            h: 5.0,
        };
        let (x0, y0, cw, ch) = region_to_pixels(&wild, 10, 10);
        assert!(x0 == 0 && y0 == 9 && x0 + cw <= 10 && y0 + ch <= 10 && cw >= 1 && ch >= 1);
        let tiny = Region {
            x: 0.5,
            y: 0.5,
            w: 0.0,
            h: 0.0,
        };
        let (_, _, cw, ch) = region_to_pixels(&tiny, 10, 10);
        assert!(
            cw >= 1 && ch >= 1,
            "degenerate region still samples one pixel"
        );
        assert_eq!(region_to_pixels(&r, 0, 0), (0, 0, 0, 0));
    }

    #[test]
    fn crop_frame_extracts_expected_pixels() {
        let mut f = solid(4, 4, [0, 0, 0, 255]);
        // Paint pixel (2,1) red.
        let i = ((4 + 2) * 4) as usize;
        f.data[i] = 255;
        let c = crop_frame(
            &f,
            &Region {
                x: 0.5,
                y: 0.25,
                w: 0.25,
                h: 0.25,
            },
        );
        assert_eq!((c.width, c.height), (1, 1));
        assert_eq!(&c.data[0..3], &[255, 0, 0]);
    }

    #[test]
    fn vision_box_flips_y_and_composes_into_frame_coords() {
        // A box at the crop's bottom-left, in a crop occupying the frame's top-right quadrant.
        let crop = Region {
            x: 0.5,
            y: 0.0,
            w: 0.5,
            h: 0.5,
        };
        let r = vision_box_to_region(0.0, 0.0, 0.5, 0.2, &crop);
        assert!((r.x - 0.5).abs() < 1e-6);
        assert!(
            (r.y - (0.0 + 0.8 * 0.5)).abs() < 1e-6,
            "bottom of crop = y 0.8 within crop"
        );
        assert!((r.w - 0.25).abs() < 1e-6 && (r.h - 0.1).abs() < 1e-6);
    }

    #[test]
    fn color_sampler_matches_within_and_at_tolerance_only() {
        let f = solid(8, 8, [100, 150, 200, 255]);
        let region = Region {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        };
        let at = ColorSampler {
            rgb: [110, 150, 200],
            tolerance: 10.0,
        }
        .extract(&f, &region);
        let over = ColorSampler {
            rgb: [111, 150, 200],
            tolerance: 10.0,
        }
        .extract(&f, &region);
        match (at, over) {
            (
                ObservationResult::Color { rgb, matched: true },
                ObservationResult::Color { matched: false, .. },
            ) => {
                assert_eq!(rgb, [100, 150, 200]);
            }
            other => panic!("boundary must be inclusive: {other:?}"),
        }
    }
}
