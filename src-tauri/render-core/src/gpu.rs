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

/// A headless GPU context (device + queue pair).
pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

/// Errors that can arise when creating a [`Gpu`].
#[derive(Debug)]
pub enum GpuError {
    /// No suitable adapter was found (e.g. no GPU in the environment).
    NoAdapter,
    /// The adapter was found but device creation failed.
    Device(String),
}

impl std::fmt::Display for GpuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GpuError::NoAdapter => write!(f, "no GPU adapter found"),
            GpuError::Device(e) => write!(f, "device creation failed: {e}"),
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

            Ok(Gpu { device, queue })
        })
    }
}

/// Render a solid clear-color to an offscreen `w × h` texture and return the
/// pixel data as a `Vec<u8>` of length `w * h * 4` in RGBA8 order.
///
/// Uses `TextureFormat::Rgba8Unorm`. Row alignment follows the wgpu rule that
/// `bytes_per_row` must be a multiple of [`COPY_BYTES_PER_ROW_ALIGNMENT`]
/// (256). Rows are padded in the staging buffer, then un-padded when the
/// final `Vec<u8>` is assembled.
pub fn render_solid(gpu: &Gpu, w: u32, h: u32, rgba: [u8; 4]) -> Vec<u8> {
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

    // ── 3. Create a staging buffer (256-byte aligned rows) ─────────────────
    //
    // wgpu requires that `bytes_per_row` in a texture→buffer copy is a
    // multiple of COPY_BYTES_PER_ROW_ALIGNMENT (256).  For a 4-channel u8
    // texture this means we must round `w * 4` up to the next multiple of 256.
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

    // ── 4. Copy texture → staging buffer ──────────────────────────────────
    // wgpu 29 uses TexelCopyTextureInfo / TexelCopyBufferInfo
    // (renamed from ImageCopyTexture / ImageCopyBuffer in older wgpu)
    encoder.copy_texture_to_buffer(
        TexelCopyTextureInfo {
            texture: &texture,
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

    // ── 5. Map the buffer and read back, stripping padding ─────────────────
    let buffer_slice = readback_buffer.slice(..);

    // Use a channel to receive the mapping callback result.
    let (tx, rx) = std::sync::mpsc::channel();
    buffer_slice.map_async(MapMode::Read, move |result| {
        tx.send(result).unwrap();
    });

    // Block until the GPU finishes and the mapping callback fires.
    device
        .poll(PollType::wait_indefinitely())
        .expect("device poll failed");

    rx.recv()
        .expect("mapping callback never fired")
        .expect("buffer mapping failed");

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

    output
}
