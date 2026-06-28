// background.wgsl — full-screen background fill (solid or linear gradient).
//
// Uniform layout (all vec4 for 16-byte alignment):
//   color0: vec4<f32>   — solid color, or gradient "from" color
//   color1: vec4<f32>   — gradient "to" color (unused in solid mode)
//   params: vec4<f32>   — .x = mode (0=solid, 1=gradient)
//                         .y = angle_rad
//                         .zw = (width, height) in pixels

struct Bg {
    color0: vec4<f32>,
    color1: vec4<f32>,
    params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> bg: Bg;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    // Full-screen triangle — covers [-1,1]×[-1,1] NDC in a single triangle.
    let p = array(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    return vec4<f32>(p[i], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    if bg.params.x < 0.5 {
        // Solid fill.
        return bg.color0;
    }

    // Linear gradient.
    // frag.xy is in pixel space, origin top-left, x increases right, y increases down.
    // angle_deg=0 → left-to-right: dir=(cos(0),sin(0))=(1,0).
    // We project the normalized pixel coordinate onto the gradient direction.
    let res = bg.params.zw;
    let uv = frag.xy / res;                      // [0..1, 0..1]
    let angle = bg.params.y;
    let dir = vec2<f32>(cos(angle), sin(angle)); // unit direction in UV space
    let t = clamp(dot(uv, dir), 0.0, 1.0);
    return mix(bg.color0, bg.color1, t);
}
