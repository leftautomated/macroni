//! High-level offscreen render engine.
//!
//! [`Engine`] combines a [`FrameSource`], a headless [`Gpu`], and a
//! [`Compositor`] into a single render-to-pixels call.
//!
//! # Phase 1 scope
//! Output resolution equals the source dimensions. Framing (padding, background,
//! shadow, border radius) is applied by the compositor. The caller obtains raw
//! `RGBA8` bytes ready for encoding or snapshot testing.

use crate::{
    compositor::Compositor,
    decode::{DecodeError, FrameSource, RgbaFrame},
    doc::{Background, ProjectDoc},
    gpu::{Gpu, GpuError},
};

// ── EngineError ───────────────────────────────────────────────────────────────

/// Errors produced by [`Engine`] operations.
#[derive(Debug)]
pub enum EngineError {
    /// Failure during frame decode (demux, codec, or out-of-range index).
    Decode(DecodeError),
    /// GPU device, pipeline, or readback failure.
    Gpu(GpuError),
    /// Image loading or format error (e.g. bad wallpaper path or unsupported format).
    Image(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Decode(e) => write!(f, "decode error: {e}"),
            EngineError::Gpu(e) => write!(f, "GPU error: {e}"),
            EngineError::Image(s) => write!(f, "image error: {s}"),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<DecodeError> for EngineError {
    fn from(e: DecodeError) -> Self {
        EngineError::Decode(e)
    }
}

impl From<GpuError> for EngineError {
    fn from(e: GpuError) -> Self {
        EngineError::Gpu(e)
    }
}

// ── Wallpaper loader ──────────────────────────────────────────────────────────

/// Load a wallpaper image from `path` and convert it to an [`RgbaFrame`].
///
/// File I/O and decoding live here — in the engine — so that failures surface
/// as [`EngineError::Image`] rather than being mislabelled as GPU errors.
///
/// # Errors
/// Returns [`EngineError::Image`] if the file cannot be opened or its format
/// is unsupported / corrupt.
fn load_wallpaper(path: &str) -> Result<RgbaFrame, EngineError> {
    let img = image::open(path)
        .map_err(|e| EngineError::Image(format!("wallpaper '{path}': {e}")))?
        .into_rgba8();
    let width = img.width();
    let height = img.height();
    Ok(RgbaFrame { width, height, data: img.into_raw() })
}

// ── Engine ────────────────────────────────────────────────────────────────────

/// Offscreen render engine: decodes a frame, composites it, returns RGBA8 pixels.
pub struct Engine {
    gpu: Gpu,
    compositor: Compositor,
    source: Box<dyn FrameSource>,
}

impl Engine {
    /// Create an [`Engine`] wrapping `source`.
    ///
    /// Acquires a headless GPU and compiles the compositor shader pipelines.
    ///
    /// # Errors
    /// Returns [`EngineError::Gpu`] if no GPU adapter is available or device
    /// creation fails.
    pub fn new(source: Box<dyn FrameSource>) -> Result<Self, EngineError> {
        let gpu = Gpu::headless()?;
        let compositor = Compositor::new(&gpu)?;
        Ok(Self { gpu, compositor, source })
    }

    /// Output pixel dimensions.
    ///
    /// In Phase 1 this is identical to the source dimensions; later phases may
    /// apply a custom output resolution via [`ProjectDoc`].
    pub fn output_size(&self) -> (u32, u32) {
        self.source.dimensions()
    }

    /// Decode `frame_index` from the source, composite per `doc.framing`, and
    /// return the result as tightly-packed `RGBA8` bytes (`out_w * out_h * 4`).
    ///
    /// When `doc.framing.background` is [`Background::Wallpaper`] the image at
    /// the given path is loaded here (before the GPU phase) so that file-system
    /// errors surface as [`EngineError::Image`] rather than a GPU error.
    ///
    /// # Errors
    /// - [`EngineError::Decode`] if the video frame cannot be decoded.
    /// - [`EngineError::Image`] if a wallpaper file cannot be opened or decoded.
    /// - [`EngineError::Gpu`] if a GPU operation fails.
    pub fn render_to_texture(
        &mut self,
        doc: &ProjectDoc,
        frame_index: usize,
    ) -> Result<Vec<u8>, EngineError> {
        let (out_w, out_h) = self.output_size();
        let frame = self.source.frame(frame_index)?;

        // Load wallpaper pixels ahead of the GPU phase so that I/O failures
        // are reported as EngineError::Image, not EngineError::Gpu.
        let wallpaper_frame: Option<RgbaFrame> =
            if let Background::Wallpaper { path } = &doc.framing.background {
                Some(load_wallpaper(path)?)
            } else {
                None
            };

        let pixels = self.compositor.render_frame(
            &self.gpu,
            &doc.framing,
            &frame,
            wallpaper_frame.as_ref(),
            out_w,
            out_h,
        )?;
        Ok(pixels)
    }
}
