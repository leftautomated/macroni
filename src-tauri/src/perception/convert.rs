//! BGRA (scap's native order) → RGBA (the extractor pixel-order canon).

use render_core::decode::RgbaFrame;

pub fn bgra_to_rgba(width: u32, height: u32, bgra: &[u8]) -> RgbaFrame {
    let mut data = vec![0u8; (width * height * 4) as usize];
    for (dst, src) in data.chunks_exact_mut(4).zip(bgra.chunks_exact(4)) {
        dst[0] = src[2];
        dst[1] = src[1];
        dst[2] = src[0];
        dst[3] = src[3];
    }
    RgbaFrame {
        width,
        height,
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bgra_to_rgba_swaps_channels() {
        let f = bgra_to_rgba(1, 1, &[10, 20, 30, 255]); // B,G,R,A
        assert_eq!(f.data, vec![30, 20, 10, 255]);
        assert_eq!((f.width, f.height), (1, 1));
    }
}
