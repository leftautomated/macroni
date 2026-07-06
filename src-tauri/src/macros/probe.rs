//! Live `WaitProbe`: evaluates a macro's `WaitFor` target against the current
//! screen through the perception extractors. macOS-only — the only platform
//! with a live capture + Vision OCR pipeline (mirrors `LiveSource` and
//! `validate_runnable`'s platform gate in `macros/mod.rs`).

use std::path::PathBuf;

use super::runner::{result_matches, WaitProbe};
use crate::perception::commands::build_extractor_with_base;
use crate::perception::source::{LiveSource, PerceptionSource};
use crate::perception::{Region, Target, TargetKind};

/// Full-frame region used when a target has no `region` set.
const FULL_FRAME: Region = Region {
    x: 0.0,
    y: 0.0,
    w: 1.0,
    h: 1.0,
};

/// Polls a live capture frame and runs the target's extractor over it.
/// `macro_dir` anchors `TemplateMatch` image paths (`assets/...`) so a
/// macro's bundled template PNGs resolve regardless of which macro is
/// running — mirrors how `MacroStore` lays out `macros/{id}/assets/`.
#[allow(dead_code)] // consumed by Task 6 (commands)
pub struct LiveWaitProbe {
    macro_dir: PathBuf,
    source: LiveSource,
}

impl LiveWaitProbe {
    #[allow(dead_code)] // consumed by Task 6 (commands)
    pub fn new(macro_dir: PathBuf) -> Self {
        Self {
            macro_dir,
            source: LiveSource::new(),
        }
    }
}

impl WaitProbe for LiveWaitProbe {
    fn evaluate(&mut self, target: &Target) -> Result<bool, String> {
        let extractor = build_extractor_with_base(&target.kind, &self.macro_dir)?;
        let frame = self.source.frame_at(0)?;
        let region = target.region.unwrap_or(FULL_FRAME);
        let result = extractor.extract(&frame, &region);
        let expect = match &target.kind {
            TargetKind::TextOcr { expect } => expect.as_deref(),
            _ => None,
        };
        Ok(result_matches(&result, expect))
    }
}
