//! Headless wgpu GPU context and offscreen render + pixel readback.
//!
//! Uses `Rgba8Unorm` texture format. The readback respects wgpu's
//! `COPY_BYTES_PER_ROW_ALIGNMENT` (256-byte) constraint: the staging buffer
//! is allocated with padded rows, then un-padded when assembling the output.

use wgpu::{
    BufferDescriptor, BufferUsages, CommandEncoderDescriptor, Extent3d, LoadOp, MapMode,
    Operations, Origin3d, PollType, RenderPassColorAttachment, RenderPassDescriptor, StoreOp,
    TexelCopyBufferInfo, TexelCopyBufferLayout, TexelCopyTextureInfo, TextureAspect,
    TextureDescriptor, TextureDimension, TextureFormat, TextureUsages, TextureViewDescriptor,
    COPY_BYTES_PER_ROW_ALIGNMENT,
};

use crate::decode::RgbaFrame;

/// A headless GPU context (instance + adapter + device + queue).
///
/// The `instance` and `adapter` are retained (not just used transiently) so a
/// host can create a presentation [`wgpu::Surface`] on the *same* device the
/// compositor renders with — cross-device texture use is illegal in wgpu, so the
/// preview surface MUST share this GPU.
pub struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

/// Errors that can arise when creating a [`Gpu`] or performing GPU operations.
#[derive(Debug)]
pub enum GpuError {
    /// No suitable adapter was found (e.g. no GPU in the environment).
    NoAdapter,
    /// The adapter was found but device creation failed.
    Device(String),
    /// A GPU readback operation failed (device poll, buffer mapping, or channel
    /// recv). The inner string carries the wgpu / channel error message.
    Readback(String),
    /// A surface / swapchain operation failed.
    Surface(String),
}

impl std::fmt::Display for GpuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GpuError::NoAdapter => write!(f, "no GPU adapter found"),
            GpuError::Device(e) => write!(f, "device creation failed: {e}"),
            GpuError::Readback(e) => write!(f, "GPU readback failed: {e}"),
            GpuError::Surface(e) => write!(f, "GPU surface error: {e}"),
        }
    }
}

impl std::error::Error for GpuError {}

impl Gpu {
    /// Create a headless [`Gpu`] by requesting any available adapter.
    ///
    /// Uses `pollster::block_on` to drive the async wgpu calls synchronously.
    /// On macOS this hits the Metal backend without needing a window surface.
    ///
    /// # Errors
    /// Returns [`GpuError::NoAdapter`] if no adapter could be found, or
    /// [`GpuError::Device`] if device creation fails.
    pub fn headless() -> Result<Gpu, GpuError> {
        pollster::block_on(async {
            let instance = wgpu::Instance::default();

            // wgpu 29: request_adapter returns Result<Adapter, RequestAdapterError>
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions::default())
                .await
                .map_err(|_| GpuError::NoAdapter)?;

            // wgpu 29: request_device takes only &DeviceDescriptor (no trailing None)
            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor::default())
                .await
                .map_err(|e| GpuError::Device(e.to_string()))?;

            Ok(Gpu {
                instance,
                adapter,
                device,
                queue,
            })
        })
    }
}

/// Read back an `Rgba8Unorm` texture into a tightly-packed `Vec<u8>` of length
/// `w * h * 4`. Handles wgpu's 256-byte `COPY_BYTES_PER_ROW_ALIGNMENT` by
/// allocating a padded staging buffer and stripping padding after mapping.
///
/// `texture` must have `TextureUsages::COPY_SRC` and be `Rgba8Unorm`.
///
/// # Errors
/// Returns [`GpuError::Readback`] if the device poll, buffer-map callback, or
/// channel recv fails.
pub(crate) fn read_target_rgba(
    gpu: &Gpu,
    texture: &wgpu::Texture,
    w: u32,
    h: u32,
) -> Result<Vec<u8>, GpuError> {
    let device = &gpu.device;
    let queue = &gpu.queue;

    let bytes_per_pixel: u32 = 4; // Rgba8Unorm
    let unpadded_bytes_per_row = w * bytes_per_pixel;
    let align = COPY_BYTES_PER_ROW_ALIGNMENT; // 256
    let padded_bytes_per_row = (unpadded_bytes_per_row + align - 1) / align * align;

    let buffer_size = (padded_bytes_per_row * h) as u64;
    let readback_buffer = device.create_buffer(&BufferDescriptor {
        label: Some("readback_buffer"),
        size: buffer_size,
        usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
        label: Some("readback_encoder"),
    });

    // wgpu 29 uses TexelCopyTextureInfo / TexelCopyBufferInfo
    // (renamed from ImageCopyTexture / ImageCopyBuffer in older wgpu)
    encoder.copy_texture_to_buffer(
        TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: Origin3d::ZERO,
            aspect: TextureAspect::All,
        },
        TexelCopyBufferInfo {
            buffer: &readback_buffer,
            layout: TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_bytes_per_row),
                rows_per_image: Some(h),
            },
        },
        Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );

    queue.submit(std::iter::once(encoder.finish()));

    let buffer_slice = readback_buffer.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    buffer_slice.map_async(MapMode::Read, move |result| {
        // The channel send can only fail if the receiver was dropped before the
        // callback fires, which cannot happen in this synchronous flow. Ignore
        // the send error; the recv side will surface a "callback never fired"
        // error instead.
        let _ = tx.send(result);
    });

    device
        .poll(PollType::wait_indefinitely())
        .map_err(|e| GpuError::Readback(e.to_string()))?;

    rx.recv()
        .map_err(|_| GpuError::Readback("buffer-map callback never fired".into()))?
        .map_err(|e| GpuError::Readback(e.to_string()))?;

    // Strip the per-row alignment padding to produce tightly-packed RGBA8.
    let mapped = buffer_slice.get_mapped_range();
    let mut output = Vec::with_capacity((w * h * bytes_per_pixel) as usize);
    for row in 0..h as usize {
        let row_start = row * padded_bytes_per_row as usize;
        let row_end = row_start + unpadded_bytes_per_row as usize;
        output.extend_from_slice(&mapped[row_start..row_end]);
    }
    drop(mapped);
    readback_buffer.unmap();

    Ok(output)
}

/// Render a solid clear-color to an offscreen `w × h` texture and return the
/// pixel data as a `Vec<u8>` of length `w * h * 4` in RGBA8 order.
///
/// Uses `TextureFormat::Rgba8Unorm`. Row alignment follows the wgpu rule that
/// `bytes_per_row` must be a multiple of [`COPY_BYTES_PER_ROW_ALIGNMENT`]
/// (256). Rows are padded in the staging buffer, then un-padded when the
/// final `Vec<u8>` is assembled.
/// # Errors
/// Returns [`GpuError::Readback`] if the GPU readback fails.
pub fn render_solid(gpu: &Gpu, w: u32, h: u32, rgba: [u8; 4]) -> Result<Vec<u8>, GpuError> {
    let device = &gpu.device;
    let queue = &gpu.queue;

    // ── 1. Create the render target texture ────────────────────────────────
    let texture = device.create_texture(&TextureDescriptor {
        label: Some("offscreen_target"),
        size: Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: TextureFormat::Rgba8Unorm,
        usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&TextureViewDescriptor::default());

    // ── 2. Record a render pass that clears to the requested colour ────────
    let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
        label: Some("offscreen_encoder"),
    });

    // Normalise the u8 components to [0.0, 1.0] for wgpu's Color.
    let clear_color = wgpu::Color {
        r: rgba[0] as f64 / 255.0,
        g: rgba[1] as f64 / 255.0,
        b: rgba[2] as f64 / 255.0,
        a: rgba[3] as f64 / 255.0,
    };

    {
        let _pass = encoder.begin_render_pass(&RenderPassDescriptor {
            label: Some("offscreen_pass"),
            color_attachments: &[Some(RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                depth_slice: None, // wgpu 29: new field (None for 2D render pass)
                ops: Operations {
                    load: LoadOp::Clear(clear_color),
                    store: StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None, // wgpu 29: new field (None = no multiview)
        });
        // No draw calls — the clear colour is all we need.
    }

    queue.submit(std::iter::once(encoder.finish()));

    // ── 3. Read back, stripping padding (shared helper) ───────────────────
    read_target_rgba(gpu, &texture, w, h)
}

/// Composite `frame` centered over a `bg` clear-color into an `out_w × out_h`
/// offscreen render target and return the pixels as a `Vec<u8>` of length
/// `out_w * out_h * 4` in RGBA8 order.
///
/// The frame is sized so that it occupies `frame.width / out_w` × `frame.height / out_h`
/// of the NDC space (i.e. it exactly fills its proportional share of the canvas
/// and is centered at the origin). A full-quad textured WGSL shader is used.
///
/// # Channel order
/// The returned bytes are `Rgba8Unorm` — R, G, B, A — matching the frame's
/// source format.
/// # Errors
/// Returns [`GpuError::Readback`] if the GPU readback fails.
pub fn composite_frame_on_bg(
    gpu: &Gpu,
    frame: &RgbaFrame,
    bg: [u8; 4],
    out_w: u32,
    out_h: u32,
) -> Result<Vec<u8>, GpuError> {
    let device = &gpu.device;
    let queue = &gpu.queue;

    // ── 1. Upload frame to a texture ───────────────────────────────────────
    //
    // write_texture does NOT require 256-byte row alignment (that constraint
    // only applies to buffer→texture and texture→buffer copies via the
    // copy_texture_to_buffer path). We can pass the exact frame width.
    let frame_texture = device.create_texture(&TextureDescriptor {
        label: Some("frame_texture"),
        size: Extent3d {
            width: frame.width,
            height: frame.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: TextureFormat::Rgba8Unorm,
        usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
        view_formats: &[],
    });

    queue.write_texture(
        TexelCopyTextureInfo {
            texture: &frame_texture,
            mip_level: 0,
            origin: Origin3d::ZERO,
            aspect: TextureAspect::All,
        },
        &frame.data,
        TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(frame.width * 4),
            rows_per_image: Some(frame.height),
        },
        Extent3d {
            width: frame.width,
            height: frame.height,
            depth_or_array_layers: 1,
        },
    );

    let frame_view = frame_texture.create_view(&TextureViewDescriptor::default());

    // ── 2. Sampler ─────────────────────────────────────────────────────────
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("frame_sampler"),
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        address_mode_w: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });

    // ── 3. Bind group layout + bind group ──────────────────────────────────
    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("quad_bgl"),
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
        label: Some("quad_bg"),
        layout: &bind_group_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&frame_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
        ],
    });

    // ── 4. Shader + pipeline ───────────────────────────────────────────────
    let shader_src = include_str!("shaders/quad.wgsl");
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("quad_shader"),
        source: wgpu::ShaderSource::Wgsl(shader_src.into()),
    });

    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("quad_pipeline_layout"),
        bind_group_layouts: &[Some(&bind_group_layout)],
        immediate_size: 0,
    });

    // Each vertex: [pos_x, pos_y, uv_u, uv_v] — 4 × f32 = 16 bytes.
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("quad_pipeline"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs"),
            buffers: &[wgpu::VertexBufferLayout {
                array_stride: 16, // 4 × f32
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[
                    // @location(0) p: vec2<f32>
                    wgpu::VertexAttribute {
                        format: wgpu::VertexFormat::Float32x2,
                        offset: 0,
                        shader_location: 0,
                    },
                    // @location(1) uv: vec2<f32>
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

    // ── 5. Vertex buffer for a centered quad ───────────────────────────────
    //
    // NDC half-extents: x spans [-hw, hw], y spans [-hh, hh] where
    //   hw = frame.width  / out_w   (proportion of canvas width)
    //   hh = frame.height / out_h   (proportion of canvas height)
    //
    // UV:  top-left (0,0) → bottom-right (1,1)
    // Two triangles (CCW): TL, BL, TR, TR, BL, BR
    let hw = frame.width as f32 / out_w as f32;
    let hh = frame.height as f32 / out_h as f32;

    #[rustfmt::skip]
    let vertices: &[f32] = &[
        // pos_x, pos_y,  uv_u, uv_v
        -hw,  hh,   0.0, 0.0,  // TL
        -hw, -hh,   0.0, 1.0,  // BL
         hw,  hh,   1.0, 0.0,  // TR
         hw,  hh,   1.0, 0.0,  // TR
        -hw, -hh,   0.0, 1.0,  // BL
         hw, -hh,   1.0, 1.0,  // BR
    ];

    let vertex_bytes = bytemuck::cast_slice(vertices);
    let vertex_buffer = device.create_buffer(&BufferDescriptor {
        label: Some("quad_vertex_buffer"),
        size: vertex_bytes.len() as u64,
        usage: BufferUsages::VERTEX | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&vertex_buffer, 0, vertex_bytes);

    // ── 6. Render target texture ───────────────────────────────────────────
    let target_texture = device.create_texture(&TextureDescriptor {
        label: Some("composite_target"),
        size: Extent3d {
            width: out_w,
            height: out_h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: TextureFormat::Rgba8Unorm,
        usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let target_view = target_texture.create_view(&TextureViewDescriptor::default());

    // ── 7. Render pass: clear to bg, draw textured quad ───────────────────
    let clear_color = wgpu::Color {
        r: bg[0] as f64 / 255.0,
        g: bg[1] as f64 / 255.0,
        b: bg[2] as f64 / 255.0,
        a: bg[3] as f64 / 255.0,
    };

    let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
        label: Some("composite_encoder"),
    });

    {
        let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
            label: Some("composite_pass"),
            color_attachments: &[Some(RenderPassColorAttachment {
                view: &target_view,
                resolve_target: None,
                depth_slice: None,
                ops: Operations {
                    load: LoadOp::Clear(clear_color),
                    store: StoreOp::Store,
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

    // ── 8. Read back via shared helper ─────────────────────────────────────
    read_target_rgba(gpu, &target_texture, out_w, out_h)
}
