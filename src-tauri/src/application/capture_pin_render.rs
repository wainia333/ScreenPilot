//! Render a cached pin document without PNG re-encoding on each wheel event.
use super::{capture_native::Rect, capture_pins::State};
use image::{imageops, Rgba, RgbaImage};
use serde::Deserialize;

pub const PADDING: u32 = 12;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Visual {
    pub state: State,
    pub focused: bool,
    pub color: String,
    pub rounded: bool,
}
fn color(value: &str) -> Result<[u8; 3], String> {
    if value.len() != 7
        || !value.starts_with('#')
        || !value[1..].bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("钉图主题色无效".into());
    }
    let mut rgb = [0; 3];
    for (i, channel) in rgb.iter_mut().enumerate() {
        *channel =
            u8::from_str_radix(&value[1 + i * 2..3 + i * 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(rgb)
}
pub fn render(source: &RgbaImage, visual: &Visual) -> Result<RgbaImage, String> {
    let bounds = Rect {
        width: source.width(),
        height: source.height(),
        ..Rect::default()
    }
    .validate()?;
    visual.state.validate(bounds)?;
    let theme = color(&visual.color)?;
    let (width, height) = visual.state.size(bounds);
    let (width, height) = (
        width.round().max(1.0) as u32,
        height.round().max(1.0) as u32,
    );
    Rect {
        width: width + PADDING * 2,
        height: height + PADDING * 2,
        ..Rect::default()
    }
    .validate()?;
    let view = &visual.state.view;
    let transformed = if let Some(crop) = &visual.state.crop {
        // Thumbnail crops can extend past a small source; keep the empty area.
        let mut cropped = RgbaImage::new(
            crop.rect.width.round() as u32,
            crop.rect.height.round() as u32,
        );
        imageops::overlay(
            &mut cropped,
            source,
            -(crop.rect.x.round() as i64),
            -(crop.rect.y.round() as i64),
        );
        imageops::resize(&cropped, width, height, imageops::FilterType::Triangle)
    } else {
        let mut oriented = match view.rotation {
            90 => imageops::rotate90(source),
            180 => imageops::rotate180(source),
            270 => imageops::rotate270(source),
            _ => source.clone(),
        };
        if view.flip_h {
            imageops::flip_horizontal_in_place(&mut oriented);
        }
        if view.flip_v {
            imageops::flip_vertical_in_place(&mut oriented);
        }
        if oriented.dimensions() == (width, height) {
            oriented
        } else {
            imageops::resize(&oriented, width, height, imageops::FilterType::Triangle)
        }
    };
    let mut output = RgbaImage::new(width + PADDING * 2, height + PADDING * 2);
    let radius = visual
        .state
        .frame
        .as_ref()
        .map_or(if visual.rounded { 8.0 } else { 0.0 }, |f| f.radius)
        .min(f64::from(width.min(height)) / 2.0);
    let rgb = if visual.focused {
        theme
    } else {
        [137, 145, 158]
    };
    for (x, y, pixel) in output.enumerate_pixels_mut() {
        let px = f64::from(x) - f64::from(PADDING) + 0.5;
        let py = f64::from(y) - f64::from(PADDING) + 0.5;
        let inside = x >= PADDING && y >= PADDING && x < PADDING + width && y < PADDING + height;
        // The vast majority of pixels are inside the image. Avoid distance,
        // square-root and exponential calculations on full-size screenshots.
        if inside
            && (radius == 0.0
                || (px >= radius && px <= f64::from(width) - radius)
                || (py >= radius && py <= f64::from(height) - radius))
        {
            *pixel = *transformed.get_pixel(x - PADDING, y - PADDING);
            if visual.state.opacity != 1.0 {
                pixel[3] = (f64::from(pixel[3]) * visual.state.opacity).round() as u8;
            }
            continue;
        }
        let qx = (px - f64::from(width) / 2.0).abs() - (f64::from(width) / 2.0 - radius);
        let qy = (py - f64::from(height) / 2.0).abs() - (f64::from(height) / 2.0 - radius);
        let distance = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - radius;
        if distance <= 0.0 && inside {
            *pixel = *transformed.get_pixel(x - PADDING, y - PADDING);
            pixel[3] =
                (f64::from(pixel[3]) * (-distance + 0.5).clamp(0.0, 1.0) * visual.state.opacity)
                    .round() as u8;
        } else {
            // One continuous coloured rim: strongest by the image, gradually
            // diffusing outwards. No solid stroke or independently black shadow.
            // Fade to zero within the existing padding so it never clips.
            let distance = distance.max(0.0);
            let taper = ((8.0 - distance) / 3.0).clamp(0.0, 1.0);
            let alpha = 150.0
                * (-(distance / 2.8).powi(2) / 2.0).exp()
                * taper
                * taper
                * (3.0 - 2.0 * taper);
            *pixel = Rgba([rgb[0], rgb[1], rgb[2], 0]);
            pixel[3] = (alpha * visual.state.opacity).round() as u8;
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn visual() -> Visual {
        Visual {
            state: super::super::capture_pins::Record::new(
                Rect {
                    x: 0,
                    y: 0,
                    width: 80,
                    height: 40,
                },
                Rect {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
                serde_json::json!([]),
                1.0,
                false,
            )
            .state,
            focused: true,
            color: "#3388ff".into(),
            rounded: false,
        }
    }
    #[test]
    fn pin_rim_diffuses_outwards_and_focus_changes_the_entire_rim() {
        let source = RgbaImage::from_pixel(80, 40, Rgba([22, 53, 96, 255]));
        let mut visual = visual();
        let active = render(&source, &visual).unwrap();
        visual.focused = false;
        let inactive = render(&source, &visual).unwrap();
        for x in PADDING..PADDING + 80 {
            assert_eq!(
                *active.get_pixel(x, PADDING),
                *source.get_pixel(x - PADDING, 0)
            );
        }
        let mut previous_alpha = 255;
        for distance in 1..=PADDING {
            let p = active.get_pixel(40, PADDING - distance);
            let inactive_pixel = inactive.get_pixel(40, PADDING - distance);
            assert_eq!(&p.0[..3], &[51, 136, 255]);
            assert_eq!(&inactive_pixel.0[..3], &[137, 145, 158]);
            assert_eq!(p[3], inactive_pixel[3]);
            assert!(p[3] <= previous_alpha);
            if p[3] != 0 {
                assert!(p[3] < previous_alpha, "outward falloff has no solid line");
            }
            assert_eq!(*p, *active.get_pixel(40, PADDING + 40 + distance - 1));
            previous_alpha = p[3];
        }
        assert_eq!(active.get_pixel(40, PADDING - 1)[3], 148);
        assert_eq!(active.get_pixel(40, PADDING - 3)[3], 101);
        assert!(active.get_pixel(40, PADDING - 6)[3] < 30);
        assert_eq!(active.get_pixel(40, PADDING - 8)[3], 0);
        assert_eq!(active.get_pixel(40, 0)[3], 0);
        assert_eq!(active.get_pixel(40, 25), inactive.get_pixel(40, 25));
    }
    #[test]
    fn native_pin_scaling_preserves_aspect_rotations_crop_and_opacity() {
        let source = RgbaImage::from_fn(80, 40, |x, y| Rgba([x as u8, y as u8, 96, 255]));
        let mut v = visual();
        v.state.view.rotation = 90;
        v.state.view.zoom = 1.5;
        assert_eq!(
            render(&source, &v).unwrap().dimensions(),
            (60 + 24, 120 + 24)
        );
        v.state.view.zoom = 1.0;
        v.state.opacity = 0.5;
        let output = render(&source, &v).unwrap();
        assert_eq!(
            *output.get_pixel(PADDING + 20, PADDING + 30),
            Rgba([30, 19, 96, 128])
        );
        v.state.crop = Some(super::super::capture_pins::Crop {
            rect: super::super::capture_pins::CropRect {
                x: 70.0,
                y: 30.0,
                width: 100.0,
                height: 100.0,
            },
            scale: 1.0,
        });
        let crop = render(&source, &v).unwrap();
        assert_eq!(crop.dimensions(), (124, 124));
        assert_eq!(crop.get_pixel(90, 90)[3], 0);
        v.color = "bad".into();
        assert!(render(&source, &v).is_err());
    }
}
