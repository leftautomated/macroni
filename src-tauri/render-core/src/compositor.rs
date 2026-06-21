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

use crate::{
    doc::{Background, Rgba},
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
}
