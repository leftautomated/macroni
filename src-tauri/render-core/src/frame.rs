/// A single decoded or captured video frame in RGBA8 format
/// (row-major, `width * height * 4` bytes).
#[derive(Clone)]
pub struct RgbaFrame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}
