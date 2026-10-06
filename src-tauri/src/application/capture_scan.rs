//! Scan results use the existing popup placement/clamping conventions.
use super::{capture_native::Rect, lifecycle};
pub fn popup_bounds(selection: Rect, screen: Rect, scale: f64) -> Rect {
    let margin = (8.0 * scale).round() as i32;
    let gap = (10.0 * scale).round() as i32;
    let (width, height) = lifecycle::physical_window_size((560.0, 360.0), scale);
    let width = width.min((screen.width as i32 - margin * 2).max(1));
    let height = height.min((screen.height as i32 - margin * 2).max(1));
    let right = selection.x + selection.width as i32 + gap;
    let left = selection.x - gap - width;
    let below = selection.y + selection.height as i32 + gap;
    let above = selection.y - gap - height;
    let (x, y) = if right + width <= screen.x + screen.width as i32 - margin {
        (right, selection.y)
    } else if left >= screen.x + margin {
        (left, selection.y)
    } else if below + height <= screen.y + screen.height as i32 - margin {
        (selection.x, below)
    } else if above >= screen.y + margin {
        (selection.x, above)
    } else {
        (selection.x + gap, selection.y + gap)
    };
    let (x, y) = lifecycle::popup_position(
        (x, y),
        (
            screen.x,
            screen.y,
            screen.width as i32,
            screen.height as i32,
        ),
        (width, height),
        0,
        margin,
    );
    Rect {
        x,
        y,
        width: width as u32,
        height: height as u32,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn results_stay_near_selection_on_negative_monitors_and_at_fractional_dpi() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let screen = Rect {
                x: -2560,
                y: -240,
                width: 2560,
                height: 1440,
            };
            let selection = Rect {
                x: -2000,
                y: 100,
                width: 300,
                height: 240,
            };
            let popup = popup_bounds(selection, screen, scale);
            assert!(popup.x >= selection.x + selection.width as i32);
            assert_eq!(popup.y, selection.y);
            for region in [
                selection,
                screen,
                Rect {
                    x: -100,
                    y: 1000,
                    width: 80,
                    height: 100,
                },
            ] {
                let popup = popup_bounds(region, screen, scale);
                assert!(popup.x >= screen.x && popup.y >= screen.y);
                assert!(popup.x + popup.width as i32 <= screen.x + screen.width as i32);
                assert!(popup.y + popup.height as i32 <= screen.y + screen.height as i32);
            }
        }
    }
}
