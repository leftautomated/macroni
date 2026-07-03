use std::io::Cursor;
use std::path::Path;

use png::{BitDepth, ColorType, Encoder};
use render_core::decode::RgbaFrame;

pub fn encode_png(frame: &RgbaFrame) -> Vec<u8> {
    let mut buf = vec![];
    {
        let mut encoder = Encoder::new(&mut buf, frame.width, frame.height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&frame.data).unwrap();
    }
    buf
}

pub fn write_png(path: &Path, frame: &RgbaFrame) -> Result<(), String> {
    let buf = encode_png(frame);
    std::fs::write(path, buf).map_err(|e| e.to_string())
}

pub fn read_png(path: &Path) -> Result<RgbaFrame, String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let decoder = png::Decoder::new(Cursor::new(data));
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size()];
    reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let info = reader.info();
    let width = info.width;
    let height = info.height;

    let data = match info.color_type {
        ColorType::Rgb => {
            let mut rgba = Vec::with_capacity((width * height * 4) as usize);
            for chunk in buf.chunks_exact(3) {
                rgba.push(chunk[0]);
                rgba.push(chunk[1]);
                rgba.push(chunk[2]);
                rgba.push(255);
            }
            rgba
        }
        ColorType::Rgba => buf,
        other => return Err(format!("unsupported color type: {other:?}")),
    };

    Ok(RgbaFrame {
        width,
        height,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn encode_decode_round_trip() {
        let frame = RgbaFrame {
            width: 3,
            height: 2,
            data: vec![
                255, 0, 0, 255, 128, 64, 32, 255, 0, 128, 255, 255, 100, 100, 100, 255, 200, 200,
                200, 255, 0, 0, 0, 255,
            ],
        };

        let dir = tempdir().unwrap();
        let path = dir.path().join("test.png");
        write_png(&path, &frame).unwrap();
        let decoded = read_png(&path).unwrap();

        assert_eq!(decoded.width, frame.width);
        assert_eq!(decoded.height, frame.height);
        assert_eq!(decoded.data, frame.data);
    }
}
