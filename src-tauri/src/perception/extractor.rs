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
/// Consumed by `VisionOcr` (macOS); off-macOS only the test exercises it, so the
/// non-test lib build there has no caller.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn vision_box_to_region(bx: f32, by: f32, bw: f32, bh: f32, crop: &Region) -> Region {
    let top_left_y = 1.0 - by - bh;
    Region {
        x: crop.x + bx * crop.w,
        y: crop.y + top_left_y * crop.h,
        w: bw * crop.w,
        h: bh * crop.h,
    }
}

/// Text OCR via macOS Vision. `fast` trades accuracy for speed (continuous
/// capture); on-demand extraction uses the accurate level. macOS-only: the
/// Vision binding lives in `ocr_macos`, and the commands layer returns an
/// error for `TextOcr` on other platforms.
#[cfg(target_os = "macos")]
pub struct VisionOcr {
    pub fast: bool,
}

#[cfg(target_os = "macos")]
impl Extractor for VisionOcr {
    fn extract(&self, frame: &RgbaFrame, region: &Region) -> ObservationResult {
        let crop = crop_frame(frame, region);
        let png = super::png_io::encode_png(&crop);
        match super::ocr_macos::recognize(&png, self.fast) {
            Ok(items) => ObservationResult::Text {
                spans: items
                    .into_iter()
                    .map(|s| super::TextSpan {
                        text: s.text,
                        confidence: s.confidence,
                        region: vision_box_to_region(
                            s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3], region,
                        ),
                    })
                    .collect(),
            },
            Err(e) => {
                crate::observability::log_warn("perception", "ocr_failed", &e, None);
                ObservationResult::Text { spans: Vec::new() }
            }
        }
    }
}

/// Extractor for the continuous capture worker. macOS runs Vision OCR at the
/// Fast level (accuracy traded for speed on the ~1–2 fps continuous pass); other
/// platforms have no continuous extractor yet, so no worker is spawned there.
#[cfg(target_os = "macos")]
pub fn continuous_extractor() -> Option<Box<dyn Extractor + Send>> {
    Some(Box::new(VisionOcr { fast: true }))
}

#[cfg(not(target_os = "macos"))]
pub fn continuous_extractor() -> Option<Box<dyn Extractor + Send>> {
    None
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
    use super::super::TextSpan;
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
    fn extractor_trait_object_dispatch_works_for_ocr_shape() {
        // Fake OCR extractor standing in for VisionOcr (mirrors how playback
        // hides rdev behind a simulator trait): returns one span covering the crop.
        struct FakeOcr;
        impl Extractor for FakeOcr {
            fn extract(&self, _f: &RgbaFrame, region: &Region) -> ObservationResult {
                ObservationResult::Text {
                    spans: vec![TextSpan {
                        text: "hi".into(),
                        region: *region,
                        confidence: 1.0,
                    }],
                }
            }
        }
        let f = solid(2, 2, [0, 0, 0, 255]);
        let boxed: Box<dyn Extractor> = Box::new(FakeOcr);
        match boxed.extract(
            &f,
            &Region {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
        ) {
            ObservationResult::Text { spans } => assert_eq!(spans[0].text, "hi"),
            other => panic!("{other:?}"),
        }
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

    /// Local-only Vision smoke test (not run in CI — Vision needs macOS and a
    /// window server). Exercises the exact continuous-worker pipeline
    /// (decoded RGBA frame → crop → PNG encode → Vision OCR → Y-flip mapping)
    /// against a rendered fixture with known text and geometry, and times the
    /// fast pass for the perf gate (SAMPLE_INTERVAL_MS budget).
    ///
    /// Run: VISION_SMOKE_PNG=/path/to/fixture.png cargo test vision_smoke -- --ignored --nocapture
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn vision_smoke_recognizes_known_text_with_top_left_coords() {
        let path = std::env::var("VISION_SMOKE_PNG").expect("set VISION_SMOKE_PNG");
        let frame = crate::perception::png_io::read_png(std::path::Path::new(&path)).unwrap();
        let full = Region {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        };

        // First pass pays Vision's one-time model load; the second is the
        // steady-state cost the continuous worker actually sees per sample.
        let started = std::time::Instant::now();
        let _warmup = VisionOcr { fast: true }.extract(&frame, &full);
        let first_ms = started.elapsed().as_secs_f64() * 1000.0;
        let started = std::time::Instant::now();
        let fast = VisionOcr { fast: true }.extract(&frame, &full);
        let steady_ms = started.elapsed().as_secs_f64() * 1000.0;

        let ObservationResult::Text { spans } = fast else {
            panic!("expected Text result");
        };
        println!(
            "fast pass: first={first_ms:.0}ms steady={steady_ms:.0}ms on {}x{}; {} spans:",
            frame.width,
            frame.height,
            spans.len()
        );
        for s in &spans {
            println!(
                "  {:?} conf={:.2} region={:?}",
                s.text, s.confidence, s.region
            );
        }
        // The fixture draws "HELLO MACRONI PERCEPTION" near the TOP of the
        // image — a correct bottom-left→top-left Y-flip puts its region in the
        // upper half. A missing flip would report y near the bottom.
        let hello = spans
            .iter()
            .find(|s| s.text.to_uppercase().contains("MACRONI"))
            .expect("fixture headline not recognized");
        assert!(
            hello.region.y < 0.5,
            "Y-flip broken: headline reported at y={}",
            hello.region.y
        );
        // The second line sits near the bottom.
        let fox = spans
            .iter()
            .find(|s| s.text.to_lowercase().contains("quick brown fox"))
            .expect("fixture body line not recognized");
        assert!(
            fox.region.y > 0.5,
            "body line reported at y={}",
            fox.region.y
        );
    }
}
