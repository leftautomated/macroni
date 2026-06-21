//! GPU compositor — background fill (solid, linear gradient).
//!
//! The [`Compositor`] builds a reusable render pipeline from `background.wgsl`
//! and exposes [`Compositor::render_background`] to produce an off-screen
//! `Rgba8Unorm` texture for any [`Background`] variant.

use wgpu::{
    BindGroupDescriptor, BindGroupEntry, BindGroupLayoutDescriptor, BindGroupLayoutEntry,
    BindingResource, BindingType, BufferBindingType, BufferDescriptor, BufferUsages,
    CommandEncoderDescriptor, Extent3d, LoadOp, Operations, RenderPassColorAttachment,
    RenderPassDescriptor, ShaderStages, StoreOp, TextureDescriptor, TextureDimension,
    TextureFormat, TextureUsages, TextureViewDescriptor,
};

// ── Video uniform ─────────────────────────────────────────────────────────────
//
// Passed to `framed_video.wgsl` as group(1)/binding(0).
// Must be 16-byte aligned.
//   [0..8]   size_px   (vec2<f32>: pixel width, height of the video quad)
//   [8..12]  radius_px (f32: corner radius; 0 = square)
//   [12..16] _pad      (f32: padding to reach 16 bytes)

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct VideoUniform {
    size_px: [f32; 2],
    radius_px: f32,
    _pad: f32,
}

// ── Shadow uniform ────────────────────────────────────────────────────────────
//
// Passed to `shadow.wgsl` as group(0)/binding(0).
// Must be 16-byte aligned. Total = 48 bytes (3 × vec4<f32>).
//   [0..8]   rect_min    (vec2<f32>: top-left pixel of shadow rect)
//   [8..16]  rect_size   (vec2<f32>: pixel width, height of the shadow rect)
//   [16..20] radius_px   (f32)
//   [20..24] blur_px     (f32)
//   [24..28] opacity     (f32)
//   [28..36] target_size (vec2<f32>: render target pixel dimensions)
//   [36..40] _pad0       (f32)
//   [40..48] _pad1       (f32 × 2 — fills to the next 16-byte boundary)

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct ShadowUniform {
    rect_min: [f32; 2],    // 8 bytes
    rect_size: [f32; 2],   // 8 bytes  → 16 total
    radius_px: f32,        // 4 bytes
    blur_px: f32,          // 4 bytes
    opacity: f32,          // 4 bytes
    _pad0: f32,            // 4 bytes  → 32 total
    target_size: [f32; 2], // 8 bytes
    _pad1: [f32; 2],       // 8 bytes  → 48 total
}

use crate::{
    decode::RgbaFrame,
    doc::{Background, Framing, Rgba},
    gpu::{read_target_rgba, Gpu, GpuError},
};

// ── Uniform buffer ────────────────────────────────────────────────────────────
//
// Must be 16-byte aligned. Three vec4<f32> = 48 bytes total.
//   [0..16]  color0  (rgba f32 normalised)
//   [16..32] color1  (rgba f32 normalised)
//   [32..48] params  (mode, angle_rad, width, height)

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct BgUniform {
    color0: [f32; 4],
    color1: [f32; 4],
    /// x = mode (0.0 = solid, 1.0 = gradient), y = angle_rad, z = width, w = height
    params: [f32; 4],
}

fn rgba_to_f32(c: &Rgba) -> [f32; 4] {
    [
        c.0[0] as f32 / 255.0,
        c.0[1] as f32 / 255.0,
        c.0[2] as f32 / 255.0,
        c.0[3] as f32 / 255.0,
    ]
}

// ── Compositor ────────────────────────────────────────────────────────────────

/// Holds the compiled background render pipeline.
///
/// Construct once with [`Compositor::new`], then call
/// [`Compositor::render_background`] for each frame.
pub struct Compositor {
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
}

impl Compositor {
    /// Compile the background shader pipeline.
    ///
    /// # Errors
    /// Returns [`GpuError`] if the device is lost (propagated via the `?`
    /// operator; wgpu pipeline creation is infallible on creation, but we keep
    /// the signature consistent with the rest of `render-core`).
    pub fn new(gpu: &Gpu) -> Result<Self, GpuError> {
        let device = &gpu.device;

        let shader_src = include_str!("shaders/background.wgsl");
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("background_shader"),
            source: wgpu::ShaderSource::Wgsl(shader_src.into()),
        });

        // One uniform buffer binding at group 0 / binding 0.
        let bind_group_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("bg_bgl"),
            entries: &[BindGroupLayoutEntry {
                binding: 0,
                visibility: ShaderStages::VERTEX_FRAGMENT,
                ty: BindingType::Buffer {
                    ty: BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("bg_pipeline_layout"),
                bind_group_layouts: &[Some(&bind_group_layout)],
                immediate_size: 0,
            });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("bg_pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                buffers: &[], // full-screen triangle: no vertex buffer
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: TextureFormat::Rgba8Unorm,
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

        Ok(Self {
            pipeline,
            bind_group_layout,
        })
    }

    /// Render `bg` into a fresh `out_w × out_h` `Rgba8Unorm` texture.
    ///
    /// The returned texture has usages `RENDER_ATTACHMENT | COPY_SRC | TEXTURE_BINDING`.
    ///
    /// For [`Background::Wallpaper`] a solid mid-gray `[128, 128, 128, 255]` is
    /// rendered as a placeholder.
    /// # TODO(Task 8): real wallpaper compositing
    ///
    /// # Errors
    /// Returns [`GpuError`] if device operations fail.
    pub fn render_background(
        &self,
        gpu: &Gpu,
        bg: &Background,
        out_w: u32,
        out_h: u32,
    ) -> Result<wgpu::Texture, GpuError> {
        let device = &gpu.device;
        let queue = &gpu.queue;

        // ── Build the uniform ────────────────────────────────────────────────
        let uniform = match bg {
            Background::Solid { color } => BgUniform {
                color0: rgba_to_f32(color),
                color1: [0.0; 4],
                params: [0.0, 0.0, out_w as f32, out_h as f32],
            },
            Background::LinearGradient {
                from,
                to,
                angle_deg,
            } => BgUniform {
                color0: rgba_to_f32(from),
                color1: rgba_to_f32(to),
                params: [
                    1.0,
                    angle_deg.to_radians(),
                    out_w as f32,
                    out_h as f32,
                ],
            },
            // TODO(Task 8): real wallpaper compositing
            Background::Wallpaper { .. } => BgUniform {
                color0: rgba_to_f32(&Rgba([128, 128, 128, 255])),
                color1: [0.0; 4],
                params: [0.0, 0.0, out_w as f32, out_h as f32],
            },
        };

        // ── Upload uniform to a GPU buffer ───────────────────────────────────
        let uniform_bytes: &[u8] = bytemuck::bytes_of(&uniform);
        let uniform_buffer = device.create_buffer(&BufferDescriptor {
            label: Some("bg_uniform"),
            size: uniform_bytes.len() as u64,
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&uniform_buffer, 0, uniform_bytes);

        // ── Bind group ───────────────────────────────────────────────────────
        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("bg_bind_group"),
            layout: &self.bind_group_layout,
            entries: &[BindGroupEntry {
                binding: 0,
                resource: BindingResource::Buffer(uniform_buffer.as_entire_buffer_binding()),
            }],
        });

        // ── Render target ────────────────────────────────────────────────────
        let target = device.create_texture(&TextureDescriptor {
            label: Some("bg_target"),
            size: Extent3d {
                width: out_w,
                height: out_h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::RENDER_ATTACHMENT
                | TextureUsages::COPY_SRC
                | TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let target_view = target.create_view(&TextureViewDescriptor::default());

        // ── Render pass ──────────────────────────────────────────────────────
        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("bg_encoder"),
        });

        {
            let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("bg_pass"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &target_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: Operations {
                        // Clear to black; the shader overwrites every pixel.
                        load: LoadOp::Clear(wgpu::Color::BLACK),
                        store: StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });

            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            // Full-screen triangle: 3 vertices, no vertex buffer.
            pass.draw(0..3, 0..1);
        }

        queue.submit(std::iter::once(encoder.finish()));

        Ok(target)
    }

    /// Read an `Rgba8Unorm` texture back to CPU memory as a tightly-packed
    /// `Vec<u8>` of length `width * height * 4`.
    ///
    /// Delegates to the shared `gpu::read_target_rgba` helper.
    ///
    /// # Errors
    /// Returns [`GpuError::Readback`] if the GPU readback fails.
    pub fn read_texture(
        &self,
        gpu: &Gpu,
        texture: &wgpu::Texture,
    ) -> Result<Vec<u8>, GpuError> {
        let size = texture.size();
        read_target_rgba(gpu, texture, size.width, size.height)
    }

    /// Render `video` composited over the background defined in `framing`, with
    /// `framing.padding_px` inset on every side and aspect-fit centering.
    ///
    /// **Phase 1:** plain rect — no rounded corners, no shadow (Tasks 6–7).
    ///
    /// # How the fit rect is computed
    /// 1. Available area: `[padding, out_w-padding] × [padding, out_h-padding]`.
    /// 2. `scale = min(avail_w / video_w, avail_h / video_h)` — largest scale
    ///    that fits both dimensions without clipping.
    /// 3. Fitted pixel rect is centered in the output canvas.
    /// 4. Pixel corners are converted to NDC (`[-1, 1]`) for the quad.
    ///
    /// # Errors
    /// Returns [`GpuError`] if any GPU operation fails.
    pub fn render_frame(
        &self,
        gpu: &Gpu,
        framing: &Framing,
        video: &RgbaFrame,
        out_w: u32,
        out_h: u32,
    ) -> Result<Vec<u8>, GpuError> {
        let device = &gpu.device;
        let queue = &gpu.queue;

        // ── Step 1: Render background into a texture ─────────────────────────
        let bg_texture = self.render_background(gpu, &framing.background, out_w, out_h)?;

        // ── Step 2: Upload video frame as a GPU texture ───────────────────────
        //
        // queue.write_texture does NOT require 256-byte row alignment — only the
        // buffer→texture copy path has that constraint.
        let video_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("video_frame_texture"),
            size: wgpu::Extent3d {
                width: video.width,
                height: video.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &video_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &video.data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(video.width * 4),
                rows_per_image: Some(video.height),
            },
            wgpu::Extent3d {
                width: video.width,
                height: video.height,
                depth_or_array_layers: 1,
            },
        );

        let video_view = video_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // ── Step 3: Compute aspect-fit rect in NDC ───────────────────────────
        //
        // Available pixel area after padding on all four sides:
        let pad = framing.padding_px;
        let avail_w = out_w as f32 - 2.0 * pad;
        let avail_h = out_h as f32 - 2.0 * pad;

        // Uniform scale that fits the video within the available area.
        // Capped at 1.0: the compositor downscales to fit but never upscales.
        let scale =
            (avail_w / video.width as f32).min(avail_h / video.height as f32).min(1.0);
        let fit_w = video.width as f32 * scale;
        let fit_h = video.height as f32 * scale;

        // Pixel coordinates of the fit rect, centered in the output canvas:
        let cx = out_w as f32 / 2.0;
        let cy = out_h as f32 / 2.0;
        let px_left = cx - fit_w / 2.0;
        let px_right = cx + fit_w / 2.0;
        let px_top = cy - fit_h / 2.0;
        let px_bot = cy + fit_h / 2.0;

        // Convert pixel coords to NDC: ndc_x = (px / out_w) * 2 - 1
        //                              ndc_y = 1 - (py / out_h) * 2   (y flipped)
        let to_ndc_x = |px: f32| (px / out_w as f32) * 2.0 - 1.0;
        let to_ndc_y = |py: f32| 1.0 - (py / out_h as f32) * 2.0;

        let ndc_left = to_ndc_x(px_left);
        let ndc_right = to_ndc_x(px_right);
        let ndc_top = to_ndc_y(px_top);   // larger NDC-y = top of screen
        let ndc_bot = to_ndc_y(px_bot);   // smaller NDC-y = bottom of screen

        // Two triangles (CCW) covering the fit rect: TL, BL, TR, TR, BL, BR
        // Each vertex: [pos_x, pos_y, uv_u, uv_v]
        #[rustfmt::skip]
        let vertices: &[f32] = &[
            ndc_left,  ndc_top,  0.0, 0.0,  // TL
            ndc_left,  ndc_bot,  0.0, 1.0,  // BL
            ndc_right, ndc_top,  1.0, 0.0,  // TR
            ndc_right, ndc_top,  1.0, 0.0,  // TR
            ndc_left,  ndc_bot,  0.0, 1.0,  // BL
            ndc_right, ndc_bot,  1.0, 1.0,  // BR
        ];

        // ── Step 4: Build sampler + bind groups + pipeline ───────────────────
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("framed_video_sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        // group(0): texture + sampler
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("framed_video_bgl"),
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
            label: Some("framed_video_bg"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&video_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });

        // group(1): VideoUniform — quad pixel size + corner radius for the SDF mask.
        let video_uniform = VideoUniform {
            size_px: [fit_w, fit_h],
            radius_px: framing.border_radius_px,
            _pad: 0.0,
        };
        let video_uniform_bytes: &[u8] = bytemuck::bytes_of(&video_uniform);
        let video_uniform_buf = device.create_buffer(&BufferDescriptor {
            label: Some("framed_video_uniform"),
            size: video_uniform_bytes.len() as u64,
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&video_uniform_buf, 0, video_uniform_bytes);

        let video_bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("framed_video_uniform_bgl"),
            entries: &[BindGroupLayoutEntry {
                binding: 0,
                visibility: ShaderStages::FRAGMENT,
                ty: BindingType::Buffer {
                    ty: BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let video_bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("framed_video_uniform_bg"),
            layout: &video_bgl,
            entries: &[BindGroupEntry {
                binding: 0,
                resource: BindingResource::Buffer(video_uniform_buf.as_entire_buffer_binding()),
            }],
        });

        let shader_src = include_str!("shaders/framed_video.wgsl");
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("framed_video_shader"),
            source: wgpu::ShaderSource::Wgsl(shader_src.into()),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("framed_video_pipeline_layout"),
            bind_group_layouts: &[Some(&bgl), Some(&video_bgl)],
            immediate_size: 0,
        });

        // Each vertex: [pos_x, pos_y, uv_u, uv_v] — 4 × f32 = 16 bytes.
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("framed_video_pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: 16,
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
                targets: &[Some(wgpu::ColorTargetState {
                    format: TextureFormat::Rgba8Unorm,
                    // Opaque blend: video quad overwrites the background.
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

        // ── Step 5: Vertex buffer ─────────────────────────────────────────────
        let vertex_bytes = bytemuck::cast_slice(vertices);
        let vertex_buffer = device.create_buffer(&BufferDescriptor {
            label: Some("framed_video_vbuf"),
            size: vertex_bytes.len() as u64,
            usage: BufferUsages::VERTEX | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&vertex_buffer, 0, vertex_bytes);

        // ── Step 5b: Shadow pass — blend soft drop shadow over the background ─
        //
        // Only run if shadow opacity > 0 to avoid unnecessary GPU work on
        // zero-opacity shadows (also preserves existing test behaviour).
        if framing.shadow.opacity > 0.0 {
            // Shadow rect = video fit rect, shifted DOWN by offset_y_px.
            // In render-target pixel space, "down" = increasing Y.
            let shadow_rect_min = [px_left, px_top + framing.shadow.offset_y_px];
            let shadow_rect_size = [fit_w, fit_h];

            let shadow_uniform = ShadowUniform {
                rect_min: shadow_rect_min,
                rect_size: shadow_rect_size,
                radius_px: framing.border_radius_px,
                blur_px: framing.shadow.blur_px,
                opacity: framing.shadow.opacity,
                _pad0: 0.0,
                target_size: [out_w as f32, out_h as f32],
                _pad1: [0.0, 0.0],
            };
            let shadow_bytes: &[u8] = bytemuck::bytes_of(&shadow_uniform);
            let shadow_buf = device.create_buffer(&BufferDescriptor {
                label: Some("shadow_uniform"),
                size: shadow_bytes.len() as u64,
                usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            queue.write_buffer(&shadow_buf, 0, shadow_bytes);

            let shadow_bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
                label: Some("shadow_bgl"),
                entries: &[BindGroupLayoutEntry {
                    binding: 0,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Buffer {
                        ty: BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });

            let shadow_bind_group = device.create_bind_group(&BindGroupDescriptor {
                label: Some("shadow_bg"),
                layout: &shadow_bgl,
                entries: &[BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::Buffer(shadow_buf.as_entire_buffer_binding()),
                }],
            });

            let shadow_shader_src = include_str!("shaders/shadow.wgsl");
            let shadow_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("shadow_shader"),
                source: wgpu::ShaderSource::Wgsl(shadow_shader_src.into()),
            });

            let shadow_pipeline_layout =
                device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("shadow_pipeline_layout"),
                    bind_group_layouts: &[Some(&shadow_bgl)],
                    immediate_size: 0,
                });

            // Alpha blending: src_alpha + (1 - src_alpha) * dst
            // Shadow writes (0,0,0,a); blends black at `a` over the background.
            let shadow_pipeline =
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("shadow_pipeline"),
                    layout: Some(&shadow_pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &shadow_shader,
                        entry_point: Some("vs"),
                        buffers: &[], // full-screen triangle, no vertex buffer
                        compilation_options: Default::default(),
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &shadow_shader,
                        entry_point: Some("fs"),
                        targets: &[Some(wgpu::ColorTargetState {
                            format: TextureFormat::Rgba8Unorm,
                            blend: Some(wgpu::BlendState::ALPHA_BLENDING),
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

            let shadow_view = bg_texture.create_view(&TextureViewDescriptor::default());
            let mut shadow_encoder = device.create_command_encoder(&CommandEncoderDescriptor {
                label: Some("shadow_encoder"),
            });

            {
                let mut shadow_pass =
                    shadow_encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("shadow_pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &shadow_view,
                            resolve_target: None,
                            depth_slice: None,
                            ops: wgpu::Operations {
                                // Load the background; shadow blends on top.
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                        multiview_mask: None,
                    });

                shadow_pass.set_pipeline(&shadow_pipeline);
                shadow_pass.set_bind_group(0, &shadow_bind_group, &[]);
                // Full-screen triangle: 3 vertices, no vertex buffer.
                shadow_pass.draw(0..3, 0..1);
            }

            queue.submit(std::iter::once(shadow_encoder.finish()));
        }

        // ── Step 6: Render pass — load bg texture, draw video quad ───────────
        //
        // We use the bg_texture as the render attachment and load its contents
        // (LoadOp::Load). The video quad is drawn on top of it.
        let bg_view = bg_texture.create_view(&TextureViewDescriptor::default());

        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("framed_video_encoder"),
        });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("framed_video_pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &bg_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        // Load the background that was already rendered by render_background.
                        load: wgpu::LoadOp::Load,
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
            pass.set_bind_group(1, &video_bind_group, &[]);
            pass.set_vertex_buffer(0, vertex_buffer.slice(..));
            pass.draw(0..6, 0..1);
        }

        queue.submit(std::iter::once(encoder.finish()));

        // ── Step 7: Read back from the bg_texture (now has video on top) ─────
        read_target_rgba(gpu, &bg_texture, out_w, out_h)
    }
}
