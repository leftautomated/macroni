//! High-level offscreen render engine.
//!
//! [`Engine`] combines a [`FrameSource`], a headless [`Gpu`], and a
//! [`Compositor`] into a single render-to-pixels call.
//!
//! # Phase 1 scope
//! Output resolution equals the source dimensions. Framing (padding, background,
//! shadow, border radius) is applied by the compositor. The caller obtains raw
//! `RGBA8` bytes ready for encoding or snapshot testing.

use std::path::Path;

use crate::{
    compositor::Compositor,
    decode::{DecodeError, FrameSource, RgbaFrame},
    doc::{Background, ProjectDoc},
    encode::Mp4Encoder,
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
    /// H.264 encode or MP4 mux failure.
    Encode(String),
    /// Failure acquiring or presenting a host swapchain surface texture.
    Surface(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Decode(e) => write!(f, "decode error: {e}"),
            EngineError::Gpu(e) => write!(f, "GPU error: {e}"),
            EngineError::Image(s) => write!(f, "image error: {s}"),
            EngineError::Encode(s) => write!(f, "encode error: {s}"),
            EngineError::Surface(s) => write!(f, "surface error: {s}"),
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
    Ok(RgbaFrame {
        width,
        height,
        data: img.into_raw(),
    })
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
        Ok(Self {
            gpu,
            compositor,
            source,
        })
    }

    /// Output pixel dimensions.
    ///
    /// In Phase 1 this is identical to the source dimensions; later phases may
    /// apply a custom output resolution via [`ProjectDoc`].
    pub fn output_size(&self) -> (u32, u32) {
        self.source.dimensions()
    }

    /// Access the engine's [`Gpu`] (instance + adapter + device + queue).
    ///
    /// A host uses this to create a presentation [`wgpu::Surface`] on the *same*
    /// device the compositor renders with, which is required because
    /// [`Engine::render_to_surface`] blits an offscreen texture (this device)
    /// onto the surface's swapchain texture — those must share a device.
    pub fn gpu(&self) -> &Gpu {
        &self.gpu
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

    /// Composite `frame_index` per `doc.framing` and present the result onto a
    /// host-provided wgpu swapchain `surface`.
    ///
    /// The compositor renders into an offscreen `Rgba8Unorm` texture at
    /// [`output_size`](Self::output_size); this method then blits that texture
    /// onto the surface's current texture with a small fullscreen textured-quad
    /// pass whose pipeline target format is `surface_format`. That decouples the
    /// compositor's `Rgba8Unorm` output from the surface's (typically
    /// `Bgra8Unorm`) swapchain format — the GPU handles the channel swizzle.
    ///
    /// The `surface` MUST already be `configure`d by the caller to
    /// `output_size()` with `surface_format`; this method does not resize it.
    ///
    /// Render-on-demand: call when the doc or scrub position changes. There is
    /// no playback loop here.
    ///
    /// # Errors
    /// - [`EngineError::Decode`] if the video frame cannot be decoded.
    /// - [`EngineError::Image`] if a wallpaper file cannot be opened or decoded.
    /// - [`EngineError::Gpu`] if a GPU operation fails.
    /// - [`EngineError::Surface`] if the swapchain texture cannot be acquired.
    ///
    // smoke: covered by host preview (Task 12 visual verification); no unit test.
    pub fn render_to_surface(
        &mut self,
        doc: &ProjectDoc,
        frame_index: usize,
        surface: &wgpu::Surface,
        surface_format: wgpu::TextureFormat,
    ) -> Result<(), EngineError> {
        let (out_w, out_h) = self.output_size();
        let frame = self.source.frame(frame_index)?;

        // Load wallpaper pixels ahead of the GPU phase so I/O failures surface
        // as EngineError::Image (mirrors render_to_texture).
        let wallpaper_frame: Option<RgbaFrame> =
            if let Background::Wallpaper { path } = &doc.framing.background {
                Some(load_wallpaper(path)?)
            } else {
                None
            };

        // Composite the full scene into an offscreen Rgba8Unorm texture handle.
        let composited = self.compositor.render_to_texture_handle(
            &self.gpu,
            &doc.framing,
            &frame,
            wallpaper_frame.as_ref(),
            out_w,
            out_h,
        )?;

        // Acquire the surface's current swapchain texture (wgpu 29 enum).
        let surface_tex = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            other => {
                return Err(EngineError::Surface(format!(
                    "get_current_texture: {other:?}"
                )))
            }
        };

        // Blit the composited texture onto the swapchain texture.
        self.blit_to_surface(&composited, &surface_tex.texture, surface_format);

        surface_tex.present();
        Ok(())
    }

    /// Draw `src` (an `Rgba8Unorm` texture) as a fullscreen textured quad into
    /// `dst` (the swapchain texture), with the pipeline targeting `dst_format`.
    ///
    /// Built per-call for the spike (cheap relative to the decode/composite the
    /// frame already paid for). Reuses the shared `quad.wgsl` shader.
    fn blit_to_surface(
        &self,
        src: &wgpu::Texture,
        dst: &wgpu::Texture,
        dst_format: wgpu::TextureFormat,
    ) {
        let device = &self.gpu.device;
        let queue = &self.gpu.queue;

        let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
        let dst_view = dst.create_view(&wgpu::TextureViewDescriptor::default());

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("blit_sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("blit_bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("blit_bg"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&src_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("blit_shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/quad.wgsl").into()),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("blit_pipeline_layout"),
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });

        // Fullscreen quad covering NDC [-1,1]; UV (0,0) top-left → (1,1) bottom.
        // Matches the offscreen texture's row-major top-left origin.
        #[rustfmt::skip]
        let vertices: &[f32] = &[
            -1.0,  1.0,  0.0, 0.0, // TL
            -1.0, -1.0,  0.0, 1.0, // BL
             1.0,  1.0,  1.0, 0.0, // TR
             1.0,  1.0,  1.0, 0.0, // TR
            -1.0, -1.0,  0.0, 1.0, // BL
             1.0, -1.0,  1.0, 1.0, // BR
        ];

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("blit_pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: 16, // 4 × f32: pos_x, pos_y, uv_u, uv_v
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x2,
                            offset: 0,
                            shader_location: 0,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x2,
                            offset: 8,
                            shader_location: 1,
                        },
                    ],
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                // Target the SURFACE format so the GPU swizzles Rgba8→Bgra8.
                targets: &[Some(wgpu::ColorTargetState {
                    format: dst_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        let vertex_bytes: &[u8] = bytemuck::cast_slice(vertices);
        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("blit_vbuf"),
            size: vertex_bytes.len() as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&vertex_buffer, 0, vertex_bytes);

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("blit_encoder"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("blit_pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &dst_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.set_vertex_buffer(0, vertex_buffer.slice(..));
            pass.draw(0..6, 0..1);
        }
        queue.submit(std::iter::once(encoder.finish()));
    }

    /// Render every frame of the source through the compositor, encode as
    /// H.264, and mux the result into an MP4 file at `out`.
    ///
    /// `progress` is called after each frame with a value in `(0.0, 1.0]`
    /// (1.0 means all frames encoded, before the final mux write).
    ///
    /// # Errors
    /// - [`EngineError::Decode`] if any frame cannot be decoded.
    /// - [`EngineError::Gpu`] if a GPU operation fails.
    /// - [`EngineError::Image`] if a wallpaper file cannot be opened.
    /// - [`EngineError::Encode`] if encoding or muxing fails.
    pub fn export(
        &mut self,
        doc: &ProjectDoc,
        out: &Path,
        mut progress: impl FnMut(f32),
    ) -> Result<(), EngineError> {
        let (w, h) = self.output_size();
        let n = self.source.frame_count();

        // Use 30 fps as the Phase 1 default; the source FPS is not yet exposed
        // by the FrameSource trait.
        const FPS: u32 = 30;
        let frame_range = export_frame_range(doc, n, FPS);
        if frame_range.is_empty() {
            return Err(EngineError::Encode(
                "trim range contains no video frames".into(),
            ));
        }
        let export_count = frame_range.len();
        let mut enc = Mp4Encoder::new(w, h, FPS)?;

        for (exported, i) in frame_range.enumerate() {
            let rgba = self.render_to_texture(doc, i)?;
            enc.encode_rgba(&rgba)?;
            progress((exported + 1) as f32 / export_count as f32);
        }

        enc.finish(out)?;
        Ok(())
    }
}

/// Converts the persisted millisecond kept range into source-frame indices.
fn export_frame_range(doc: &ProjectDoc, frame_count: usize, fps: u32) -> std::ops::Range<usize> {
    let Some(trim) = doc.trim_regions.first() else {
        return 0..frame_count;
    };
    let fps = u64::from(fps.max(1));
    let start = ((trim.start_ms.saturating_mul(fps)) / 1000) as usize;
    let end = ((trim.end_ms.saturating_mul(fps).saturating_add(999)) / 1000) as usize;
    start.min(frame_count)..end.min(frame_count)
}

#[cfg(test)]
mod trim_tests {
    use super::*;
    use crate::doc::TrimRegion;

    #[test]
    fn empty_trim_exports_every_frame() {
        let doc = ProjectDoc::new_default("clip.mp4".into());
        assert_eq!(export_frame_range(&doc, 90, 30), 0..90);
    }

    #[test]
    fn kept_millisecond_range_maps_to_source_frames() {
        let mut doc = ProjectDoc::new_default("clip.mp4".into());
        doc.trim_regions.push(TrimRegion {
            id: "recording-trim".into(),
            start_ms: 1000,
            end_ms: 2500,
        });
        assert_eq!(export_frame_range(&doc, 90, 30), 30..75);
    }
}
