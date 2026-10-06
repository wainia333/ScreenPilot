//! Scroll-image orientation adapter around the unmodified upstream stitch core.
use super::capture_native as native;
use image::RgbaImage;
/// Fixed short-side scale, with the newest rows/columns visible at the monitor
/// limit. Crop before resizing so an arbitrarily long source has bounded output.
pub fn preview(image: &RgbaImage, horizontal: bool, width: u32, height: u32) -> RgbaImage {
    let width = width.clamp(1, 8192);
    let height = height.clamp(1, 8192);
    let (source_width, source_height) = image.dimensions();
    let (crop_width, crop_height, output_width, output_height) = if horizontal {
        let crop_width = ((f64::from(width) * f64::from(source_height) / f64::from(height)).round()
            as u32)
            .clamp(1, source_width);
        let output_width = ((f64::from(crop_width) * f64::from(height) / f64::from(source_height))
            .round() as u32)
            .clamp(1, width);
        (crop_width, source_height, output_width, height)
    } else {
        let crop_height = ((f64::from(height) * f64::from(source_width) / f64::from(width)).round()
            as u32)
            .clamp(1, source_height);
        let output_height = ((f64::from(crop_height) * f64::from(width) / f64::from(source_width))
            .round() as u32)
            .clamp(1, height);
        (source_width, crop_height, width, output_height)
    };
    let tail = image::imageops::crop_imm(
        image,
        source_width - crop_width,
        source_height - crop_height,
        crop_width,
        crop_height,
    )
    .to_image();
    image::imageops::resize(
        &tail,
        output_width,
        output_height,
        image::imageops::FilterType::Triangle,
    )
}
pub fn capture(rect: native::Rect, engine: &mut String) -> Result<RgbaImage, String> {
    if engine == "auto" {
        match native::capture(rect, "hdr") {
            Ok(frame) => {
                *engine = "hdr".into();
                Ok(frame)
            }
            Err(_) => {
                *engine = "mss".into();
                native::capture(rect, "mss")
            }
        }
    } else {
        native::capture(rect, engine)
    }
}
pub fn join(
    previous: &RgbaImage,
    frame: &RgbaImage,
    horizontal: bool,
    ignore: u32,
) -> Result<Option<RgbaImage>, String> {
    if previous == frame {
        return Ok(Some(previous.clone()));
    }
    let pixel_budget = u64::from(previous.width()) * u64::from(previous.height())
        + u64::from(frame.width()) * u64::from(frame.height());
    if pixel_budget > 90_000_000 {
        return Err("长截图达到像素上限，请完成保存".into());
    }
    // Rotate horizontal scrolling to the vertical matcher, then restore orientation.
    let a = if horizontal {
        image::imageops::rotate90(previous)
    } else {
        previous.clone()
    };
    let b = if horizontal {
        image::imageops::rotate90(frame)
    } else {
        frame.clone()
    };
    let result = longstitch::stitch::stitch_two_images_smart_auto(
        &native::png(&a)?,
        &native::png(&b)?,
        20,
        ignore,
        0.01,
    );
    match result {
        Ok((bytes, direction)) => {
            let mut image = image::load_from_memory(&bytes)
                .map_err(|e| e.to_string())?
                .into_rgba8();
            if direction == "reverse" {
                image = image::imageops::flip_vertical(&image);
            }
            if horizontal {
                image = image::imageops::rotate270(&image);
            }
            native::Rect {
                x: 0,
                y: 0,
                width: image.width(),
                height: image.height(),
            }
            .validate()?;
            Ok(Some(image))
        }
        Err(longstitch::error::StitchError::NoOverlap) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_keeps_short_side_and_latest_pixels_without_distorting_or_modifying_source() {
        for horizontal in [false, true] {
            let source = if horizontal {
                RgbaImage::from_fn(2000, 100, |x, _| image::Rgba([(x / 100) as u8, 0, 0, 255]))
            } else {
                RgbaImage::from_fn(100, 2000, |_, y| image::Rgba([(y / 100) as u8, 0, 0, 255]))
            };
            let before = source.clone();
            let output = preview(
                &source,
                horizontal,
                if horizontal { 300 } else { 100 },
                if horizontal { 100 } else { 300 },
            );
            assert_eq!(
                output.dimensions(),
                if horizontal { (300, 100) } else { (100, 300) }
            );
            assert_eq!(output.get_pixel(0, 0)[0], 17);
            assert_eq!(
                output.get_pixel(output.width() - 1, output.height() - 1)[0],
                19
            );
            assert_eq!(source, before);
            let first = image::imageops::crop_imm(&source, 0, 0, 100, 100).to_image();
            assert_eq!(
                preview(&first, horizontal, 300, 300).dimensions(),
                (300, 300)
            );
        }
    }
    #[test]
    fn live_poll_catches_keyboard_scrolling_without_wheel_and_preserves_reverse_lock() {
        use std::time::{Duration, Instant};
        let cooldown = Duration::from_millis(150);
        let mut trigger = Trigger::default();
        assert!(trigger.due(cooldown));
        assert!(!trigger.due(cooldown));
        trigger.last_sample = Some(Instant::now() - Duration::from_millis(500));
        assert!(trigger.due(cooldown));
        trigger.wheel(-120, false, false);
        trigger.wheel(120, false, false);
        trigger.last_sample = Some(Instant::now() - Duration::from_millis(500));
        assert!(!trigger.due(cooldown));
        trigger.wheel(-120, false, false);
        trigger.pending = Some(Instant::now() - cooldown);
        assert!(trigger.due(cooldown));
    }
    #[test]
    fn multi_frame_scroll_keeps_every_row_and_duplicate_final_frame_does_not_shorten() {
        let source = RgbaImage::from_fn(160, 800, |x, y| {
            image::Rgba([
                ((y * 17 + x * 29) % 251) as u8,
                ((y * 31 + x * 7) % 253) as u8,
                ((x * y * 13) % 255) as u8,
                255,
            ])
        });
        let first = image::imageops::crop_imm(&source, 0, 0, 160, 320).to_image();
        let mut stitched = first;
        for y in [160, 320, 480] {
            let frame = image::imageops::crop_imm(&source, 0, y, 160, 320).to_image();
            stitched = join(&stitched, &frame, false, 0).unwrap().unwrap();
        }
        assert_eq!(stitched, source);
        let final_frame = image::imageops::crop_imm(&source, 0, 480, 160, 320).to_image();
        assert_eq!(
            join(&stitched, &final_frame, false, 0).unwrap().unwrap(),
            source
        );
    }
    #[test]
    fn wheel_direction_and_cooldown_match_original_scroll_trigger() {
        use std::time::{Duration, Instant};
        let cooldown = Duration::from_millis(150);
        let mut trigger = Trigger::default();
        trigger.wheel(120, true, false);
        trigger.wheel(0, false, false);
        assert!(trigger.direction.is_none());
        trigger.wheel(-120, false, false);
        assert_eq!(trigger.direction, Some(1));
        assert!(!trigger.pending(cooldown));
        trigger.pending = Some(Instant::now() - cooldown);
        trigger.wheel(-120, false, false);
        assert!(trigger.pending(cooldown)); // bursts do not starve the first scheduled shot
        assert!(!trigger.pending(cooldown));
        trigger.wheel(120, false, false);
        assert!(trigger.pending.is_none()); // reverse wheel does not corrupt a forward stitch
        trigger.wheel(-120, false, false);
        trigger.manual();
        assert!(trigger.pending.is_none());
        let mut horizontal = Trigger::default();
        horizontal.wheel(120, true, true);
        assert_eq!(horizontal.direction, Some(1));
        horizontal.pending = Some(Instant::now() - cooldown);
        assert!(horizontal.pending(cooldown));
    }
    #[test]
    fn capture_scroll_preserves_forward_reverse_and_horizontal_content() {
        let source = RgbaImage::from_fn(180, 360, |x, y| {
            image::Rgba([
                ((y * 17 + x * 29) % 251) as u8,
                ((y * 31 + x * 7) % 253) as u8,
                ((x * y * 13) % 255) as u8,
                255,
            ])
        });
        let a = image::imageops::crop_imm(&source, 0, 0, 180, 240).to_image();
        let b = image::imageops::crop_imm(&source, 0, 120, 180, 240).to_image();
        assert_eq!(join(&a, &b, false, 0).unwrap().unwrap(), source);
        assert_eq!(join(&b, &a, false, 0).unwrap().unwrap(), source);
        let a = image::imageops::rotate270(&a);
        let b = image::imageops::rotate270(&b);
        assert_eq!(
            join(&a, &b, true, 0).unwrap().unwrap(),
            image::imageops::rotate270(&source)
        );
    }
}
#[derive(Default)]
pub struct Trigger {
    pending: Option<std::time::Instant>,
    direction: Option<i8>,
    last_sample: Option<std::time::Instant>,
    reversing: bool,
    last_wheel: Option<std::time::Instant>,
}
impl Trigger {
    pub fn wheel(&mut self, delta: i32, wheel_horizontal: bool, horizontal: bool) {
        if delta == 0 || (wheel_horizontal && !horizontal) {
            return;
        }
        let direction = if wheel_horizontal {
            delta.signum()
        } else {
            -delta.signum()
        } as i8;
        if *self.direction.get_or_insert(direction) == direction {
            self.reversing = false;
            self.last_wheel = Some(std::time::Instant::now());
            self.pending.get_or_insert_with(std::time::Instant::now);
        } else {
            self.reversing = true;
            self.pending = None;
        }
    }
    pub fn pending(&mut self, cooldown: std::time::Duration) -> bool {
        if self.pending.is_some_and(|time| time.elapsed() >= cooldown) {
            self.pending = None;
            true
        } else {
            false
        }
    }
    pub fn manual(&mut self) {
        self.pending = None;
        self.last_sample = Some(std::time::Instant::now());
    }
    pub fn due(&mut self, cooldown: std::time::Duration) -> bool {
        // Poll live content as well as wheel notifications: scrollbar dragging,
        // keyboard scrolling and early wheel events must also reach the stitcher.
        if !self.reversing
            && (self.pending(cooldown)
                || (self.pending.is_none()
                    && self.last_sample.is_none_or(|time| {
                        time.elapsed() >= std::time::Duration::from_millis(450)
                    })))
        {
            self.last_sample = Some(std::time::Instant::now());
            true
        } else {
            false
        }
    }
    pub fn settle_delay(&self, cooldown: std::time::Duration) -> std::time::Duration {
        self.last_wheel.map_or(std::time::Duration::ZERO, |time| {
            cooldown.saturating_sub(time.elapsed())
        })
    }
}
