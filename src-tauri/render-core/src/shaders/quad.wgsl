@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@location(0) p: vec2<f32>, @location(1) uv: vec2<f32>) -> VsOut {
  return VsOut(vec4<f32>(p, 0.0, 1.0), uv);
}
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> { return textureSample(tex, samp, in.uv); }
