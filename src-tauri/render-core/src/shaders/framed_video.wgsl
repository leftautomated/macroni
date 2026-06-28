// framed_video.wgsl — textured quad for compositing a video frame over a background.
// Vertex buffer: [pos_x, pos_y, uv_u, uv_v] (4 × f32 = 16 bytes per vertex).
// The host computes NDC positions from the aspect-fit pixel rect and pads on every side.
//
// group(0): texture + sampler
// group(1): VideoUniform { size_px: vec2<f32>, radius_px: f32, _pad: f32 }

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct VideoUniform {
    /// Pixel width and height of the video quad on screen.
    size_px: vec2<f32>,
    /// Corner radius in pixels; 0.0 means square corners.
    radius_px: f32,
    _pad: f32,
}

@group(1) @binding(0) var<uniform> video_u: VideoUniform;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@location(0) p: vec2<f32>, @location(1) uv: vec2<f32>) -> VsOut {
    return VsOut(vec4<f32>(p, 0.0, 1.0), uv);
}

/// Signed distance to a rounded rectangle centered at the origin.
///
/// `p`  — point to test (in pixels, origin at quad center)
/// `b`  — half-extents of the box (i.e. `size_px * 0.5`)
/// `r`  — corner radius in pixels
///
/// Returns < 0 inside, > 0 outside.
fn sd_round_box(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - b + vec2<f32>(r);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    // Map uv [0,1]² → pixel position relative to quad center.
    let p = (in.uv - vec2<f32>(0.5)) * video_u.size_px;

    // Clamp radius so it never exceeds the smallest half-extent.
    let max_r = min(video_u.size_px.x, video_u.size_px.y) * 0.5;
    let r = min(video_u.radius_px, max_r);

    let sd = sd_round_box(p, video_u.size_px * 0.5, r);

    // Pixels outside the rounded rect are discarded so the background shows through.
    if sd > 0.0 {
        discard;
    }

    return textureSample(tex, samp, in.uv);
}
