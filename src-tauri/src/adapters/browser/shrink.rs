//! A picture made smaller before it is sent to a model: a retina screenshot is twice as wide as
//! the page and no easier to read, but twice the bytes, and what a model reads is cut to size anyway.

use crate::domain::{Error, ErrorCode, Result};

/// The widest a picture sent to an agent is.
pub const MAX_WIDTH: u32 = 1280;

fn bad(message: impl ToString) -> Error {
    Error::new(ErrorCode::Io, message.to_string())
}

/// The PNG, no wider than `max_width` (it is returned as it is when it already is not).
pub fn fit(png_bytes: &[u8], max_width: u32) -> Result<Vec<u8>> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(bad)?;
    let info = reader.info();
    let (width, height) = (info.width, info.height);
    if width <= max_width || max_width == 0 {
        return Ok(png_bytes.to_vec());
    }
    let mut raw = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or_else(|| bad("the picture is too large"))?
    ];
    let frame = reader.next_frame(&mut raw).map_err(bad)?;
    let channels = match frame.color_type {
        png::ColorType::Rgba => 4,
        png::ColorType::Rgb => 3,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Grayscale => 1,
        png::ColorType::Indexed => return Err(bad("an indexed picture cannot be resized")),
    };
    let target_width = max_width;
    let target_height = ((height as u64 * target_width as u64) / width as u64).max(1) as u32;
    let mut out = vec![0u8; (target_width * target_height) as usize * channels];
    // Each new pixel is the average of the block of old ones it covers.
    for y in 0..target_height {
        let y0 = (y as u64 * height as u64 / target_height as u64) as u32;
        let y1 = (((y as u64 + 1) * height as u64).div_ceil(target_height as u64) as u32)
            .clamp(y0 + 1, height);
        for x in 0..target_width {
            let x0 = (x as u64 * width as u64 / target_width as u64) as u32;
            let x1 = (((x as u64 + 1) * width as u64).div_ceil(target_width as u64) as u32)
                .clamp(x0 + 1, width);
            let count = ((y1 - y0) * (x1 - x0)) as u64;
            for channel in 0..channels {
                let mut sum = 0u64;
                for row in y0..y1 {
                    for column in x0..x1 {
                        sum += raw
                            [(row as usize * width as usize + column as usize) * channels + channel]
                            as u64;
                    }
                }
                out[(y as usize * target_width as usize + x as usize) * channels + channel] =
                    (sum / count) as u8;
            }
        }
    }
    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut encoded, target_width, target_height);
        encoder.set_color(frame.color_type);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(bad)?;
        writer.write_image_data(&out).map_err(bad)?;
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                data.extend_from_slice(&pixel(x, y));
            }
        }
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&data)
            .unwrap();
        out
    }

    fn size_and_pixels(png_bytes: &[u8]) -> (u32, u32, Vec<u8>) {
        let mut reader = png::Decoder::new(std::io::Cursor::new(png_bytes))
            .read_info()
            .unwrap();
        let mut data = vec![0; reader.output_buffer_size().unwrap()];
        let frame = reader.next_frame(&mut data).unwrap();
        (frame.width, frame.height, data)
    }

    #[test]
    fn a_picture_that_is_wide_enough_is_left_alone() {
        let picture = make(100, 50, |_, _| [1, 2, 3, 255]);
        assert_eq!(fit(&picture, 100).unwrap(), picture);
        assert_eq!(fit(&picture, 1280).unwrap(), picture);
        assert_eq!(fit(&picture, 0).unwrap(), picture);
    }

    #[test]
    fn a_retina_picture_is_halved_keeping_its_proportions_and_its_colours() {
        let picture = make(400, 200, |x, _| {
            if x < 200 {
                [255, 0, 0, 255]
            } else {
                [0, 0, 255, 255]
            }
        });
        let small = fit(&picture, 200).unwrap();
        let (width, height, pixels) = size_and_pixels(&small);
        assert_eq!((width, height), (200, 100));
        assert_eq!(&pixels[0..4], &[255, 0, 0, 255]);
        let last = (width as usize * height as usize - 1) * 4;
        assert_eq!(&pixels[last..last + 4], &[0, 0, 255, 255]);
        assert!(small.len() < picture.len() * 2);
    }

    #[test]
    fn blocks_are_averaged_not_picked() {
        // A checkerboard of black and white squares one pixel each averages to grey.
        let picture = make(8, 8, |x, y| {
            if (x + y) % 2 == 0 {
                [0, 0, 0, 255]
            } else {
                [255, 255, 255, 255]
            }
        });
        let (_, _, pixels) = size_and_pixels(&fit(&picture, 4).unwrap());
        assert!(
            pixels
                .chunks(4)
                .all(|pixel| (126..=129).contains(&pixel[0]) && pixel[3] == 255),
            "{pixels:?}"
        );
    }

    #[test]
    fn a_width_that_does_not_divide_evenly_still_fills_every_pixel() {
        let picture = make(1000, 333, |x, y| [(x % 256) as u8, (y % 256) as u8, 7, 255]);
        let (width, height, pixels) = size_and_pixels(&fit(&picture, 640).unwrap());
        assert_eq!((width, height), (640, 213));
        assert_eq!(pixels.len(), 640 * 213 * 4);
    }

    #[test]
    fn something_that_is_not_a_picture_is_an_error() {
        assert!(fit(b"not a png", 100).is_err());
    }
}
