// shadow.wgsl — full-screen drop shadow pass.
//
// Renders a soft black shadow under the video rect.  The shadow is drawn over
// the full render target so the GPU can apply a smooth SDF blur edge without
// needing a separate blur texture.  Alpha-blending is enabled on the host side
// so the shadow blends naturally over the background.
//
// group(0): ShadowUniform — shadow geometry + appearance.

// Layout (matches ShadowUniform in compositor.rs, 48 bytes = 3 × vec4<f32>):
//   vec4: rect_min.xy, rect_size.xy
//   vec4: radius_px, blur_px, opacity, _pad0
//   vec4: target_size.xy, _pad1.xy
struct ShadowUniform {
    /// Pixel position of the shadow rect's top-left corner (after offset_y).
    rect_min: vec2<f32>,
    /// Pixel width and height of the shadow rect (same as the video fit rect).
    rect_size: vec2<f32>,
    /// Corner radius in pixels (matches the video border_radius_px).
    radius_px: f32,
    /// Blur half-width in pixels.  smoothstep(0, blur_px, sd).
    blur_px: f32,
    /// Shadow opacity [0, 1].
    opacity: f32,
    _pad0: f32,
    /// Render-target width and height in pixels (needed to convert clip-space
    /// builtin position → pixel coords).
    target_size: vec2<f32>,
    _pad1: vec2<f32>,
}

@group(0) @binding(0) var<uniform> shadow_u: ShadowUniform;

/// Signed distance to a rounded rectangle centered at the origin.
/// Returns < 0 inside, > 0 outside.
fn sd_round_box(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - b + vec2<f32>(r);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@vertex
fn vs(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
    // Full-screen triangle (covers clip-space [-1,1]² with 3 vertices).
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    return vec4<f32>(pos[idx], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    // Convert from clip-space pixel coords to render-target pixel coords.
    // frag_coord.xy is in [0, target_size) with origin at top-left.
    let p_px = frag_coord.xy;

    // Center of the shadow rect in pixel space.
    let rect_center = shadow_u.rect_min + shadow_u.rect_size * 0.5;

    // Pixel position relative to the shadow rect center.
    let p_rel = p_px - rect_center;

    let half_size = shadow_u.rect_size * 0.5;

    // Clamp radius so it never exceeds the smallest half-extent.
    let max_r = min(half_size.x, half_size.y);
    let r = min(shadow_u.radius_px, max_r);

    let sd = sd_round_box(p_rel, half_size, r);

    // Shadow alpha: inside the rect = full opacity; fades out over blur_px.
    // Guard against blur_px == 0 to avoid divide-by-zero in smoothstep.
    var shadow_alpha: f32;
    if shadow_u.blur_px <= 0.0 {
        // Hard edge: 1 inside, 0 outside.
        shadow_alpha = shadow_u.opacity * select(0.0, 1.0, sd <= 0.0);
    } else {
        shadow_alpha = shadow_u.opacity * (1.0 - smoothstep(0.0, shadow_u.blur_px, sd));
    }

    // Black shadow, pre-multiplied alpha for standard ALPHA_BLENDING.
    return vec4<f32>(0.0, 0.0, 0.0, shadow_alpha);
}
