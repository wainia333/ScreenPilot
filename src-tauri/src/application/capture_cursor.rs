//! Original recording pointer/burst/scroll composition, with native sampling.
use super::capture_native::{decode, Rect};
use image::RgbaImage;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Instant};
#[derive(Clone, Default)]
pub struct Sample {
    pub x: i32,
    pub y: i32,
    pub visible: bool,
    pub scroll: i8,
    pub burst: u8,
    pub side: u8,
}
#[derive(Default)]
pub struct Track {
    pub sprites: Arc<HashMap<String, RgbaImage>>,
    pub samples: Vec<Sample>,
    last_press: u8,
    side: u8,
    released: Option<Instant>,
    pub scroll: i8,
}
impl Track {
    pub fn new(value: Option<&Value>) -> Result<Self, String> {
        let Some(value) = value else {
            return Ok(Self::default());
        };
        let mut sprites = HashMap::new();
        for name in [
            "cursor",
            "burst_left_1",
            "burst_left_2",
            "burst_left_3",
            "burst_right_1",
            "burst_right_2",
            "burst_right_3",
            "scroll_up",
            "scroll_down",
        ] {
            let text = value[name].as_str().ok_or("缺少鼠标效果图像")?;
            if text.len() > 200_000 {
                return Err("鼠标图像过大".into());
            }
            let image = decode(text)?;
            if image.width() > 128 || image.height() > 128 {
                return Err("鼠标图像尺寸无效".into());
            }
            sprites.insert(name.into(), image);
        }
        Ok(Self {
            sprites: Arc::new(sprites),
            ..Default::default()
        })
    }
    pub fn sample(&mut self, count: usize, rect: Rect, x: i32, y: i32) {
        if count == 0 || self.samples.len() >= count || count > 60000 {
            return;
        }
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON,
        };
        let press = unsafe {
            if GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 {
                1
            } else if GetAsyncKeyState(VK_RBUTTON.0 as i32) < 0 {
                2
            } else {
                0
            }
        };
        if press != 0 {
            self.side = press;
            self.released = None;
        } else if self.last_press != 0 {
            self.released = Some(Instant::now());
        }
        let burst = if press != 0 {
            1
        } else {
            self.released
                .map(|time| time.elapsed().as_millis() / 40 + 1)
                .filter(|n| *n <= 3)
                .unwrap_or(0) as u8
        };
        self.last_press = press;
        let sample = Sample {
            x: x - rect.x,
            y: y - rect.y,
            visible: x >= rect.x
                && y >= rect.y
                && i64::from(x) < i64::from(rect.x) + i64::from(rect.width)
                && i64::from(y) < i64::from(rect.y) + i64::from(rect.height),
            scroll: self.scroll,
            burst,
            side: self.side,
        };
        self.scroll = 0;
        while self.samples.len() < count {
            self.samples.push(sample.clone());
        }
    }
}
pub fn compose(
    image: &mut RgbaImage,
    sprites: &HashMap<String, RgbaImage>,
    sample: Option<&Sample>,
) {
    let Some(sample) = sample.filter(|s| s.visible) else {
        return;
    };
    let stamp = |image: &mut RgbaImage, name: &str, x: i32, y: i32| {
        if let Some(sprite) = sprites.get(name) {
            image::imageops::overlay(image, sprite, i64::from(x), i64::from(y));
        }
    };
    if sample.burst > 0 {
        let name = format!(
            "burst_{}_{}",
            if sample.side == 1 { "left" } else { "right" },
            sample.burst
        );
        if let Some(sprite) = sprites.get(&name) {
            stamp(
                image,
                &name,
                sample.x - sprite.width() as i32 / 2 + 6,
                sample.y - sprite.height() as i32 / 2 + 6,
            );
        }
    }
    if sample.scroll != 0 {
        stamp(
            image,
            if sample.scroll > 0 {
                "scroll_up"
            } else {
                "scroll_down"
            },
            sample.x + 34,
            sample.y + 12 - 20,
        );
    }
    stamp(image, "cursor", sample.x, sample.y);
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    #[test]
    fn stamps_upstream_cursor_burst_and_wheel_offsets_and_clips_edges() {
        let sprites = HashMap::from([
            (
                "cursor".into(),
                RgbaImage::from_pixel(2, 2, Rgba([255, 0, 0, 255])),
            ),
            (
                "burst_left_2".into(),
                RgbaImage::from_pixel(4, 4, Rgba([0, 255, 0, 255])),
            ),
            (
                "scroll_down".into(),
                RgbaImage::from_pixel(3, 3, Rgba([0, 0, 255, 255])),
            ),
        ]);
        let mut output = RgbaImage::new(80, 60);
        let sample = Sample {
            x: 12,
            y: 20,
            visible: true,
            burst: 2,
            side: 1,
            scroll: -1,
        };
        compose(&mut output, &sprites, Some(&sample));
        assert_eq!(output.get_pixel(12, 20).0, [255, 0, 0, 255]);
        assert_eq!(output.get_pixel(16, 24).0, [0, 255, 0, 255]);
        assert_eq!(output.get_pixel(46, 12).0, [0, 0, 255, 255]);
        let mut clipped = RgbaImage::new(1, 1);
        compose(
            &mut clipped,
            &sprites,
            Some(&Sample {
                x: -1,
                y: -1,
                visible: true,
                ..Default::default()
            }),
        );
        assert_eq!(clipped.get_pixel(0, 0).0, [255, 0, 0, 255]);
        let before = output.clone();
        compose(
            &mut output,
            &sprites,
            Some(&Sample {
                visible: false,
                ..sample
            }),
        );
        assert_eq!(output, before);
    }
}
