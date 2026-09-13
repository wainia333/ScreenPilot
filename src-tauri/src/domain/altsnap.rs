//! Window geometry and held-key parsing for the AltSnap feature.
//! Window-operation reference: RamonUnch/AltSnap 1.68, hooks.c.
//! ScreenPilot selects resize edges from the grab location, not the initial motion.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldShortcut(pub Vec<u16>);

impl HeldShortcut {
    pub fn parse(value: &str) -> Result<Self, String> {
        let mut keys = Vec::new();
        let mut ordinary = false;
        for part in value.split('+') {
            let token = part.trim().to_ascii_uppercase();
            let key = match token.as_str() {
                "ALT" => 0x12,
                "CONTROL" | "CTRL" => 0x11,
                "SHIFT" => 0x10,
                "META" | "SUPER" | "WIN" => 0x5b,
                _ => {
                    if ordinary {
                        return Err("AltSnap supports only one non-modifier key".into());
                    }
                    ordinary = true;
                    match token.as_str() {
                        "SPACE" => 0x20,
                        "ENTER" => 0x0d,
                        "BACKSPACE" => 0x08,
                        "INSERT" => 0x2d,
                        "DELETE" => 0x2e,
                        "HOME" => 0x24,
                        "END" => 0x23,
                        "PAGEUP" => 0x21,
                        "PAGEDOWN" => 0x22,
                        "ARROWLEFT" => 0x25,
                        "ARROWUP" => 0x26,
                        "ARROWRIGHT" => 0x27,
                        "ARROWDOWN" => 0x28,
                        _ if token.len() == 1 && token.as_bytes()[0].is_ascii_alphanumeric() => token.as_bytes()[0] as u16,
                        _ => token.strip_prefix('F').and_then(|n| n.parse::<u16>().ok())
                            .filter(|n| (1..=24).contains(n)).map(|n| 0x6f + n)
                            .ok_or_else(|| "AltSnap shortcut must use modifiers, letters, digits, F1–F24 or navigation keys".to_string())?,
                    }
                }
            };
            if keys.contains(&key) {
                return Err("AltSnap shortcut contains a duplicate key".into());
            }
            keys.push(key);
        }
        if keys.is_empty() {
            return Err("AltSnap shortcut cannot be empty".into());
        }
        Ok(Self(keys))
    }
}

/// Cursor shown while an AltSnap gesture owns the mouse button.
///
/// Keeping this mapping in the domain makes the input hook's lifecycle
/// explicit without coupling the geometry code to Win32 cursor handles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GestureCursor {
    Hand,
    /// Kept as the generic diagonal cursor for callers that do not have a
    /// corner. Resize gestures use one of the directional variants below.
    DiagonalResize,
    DiagonalResizeNwse,
    DiagonalResizeNesw,
}

impl GestureCursor {
    pub fn for_resize(resize: bool) -> Self {
        if resize {
            Self::DiagonalResize
        } else {
            Self::Hand
        }
    }

    pub fn for_resize_edges(resize: bool, edges: ResizeEdges) -> Self {
        if !resize {
            return Self::Hand;
        }
        match (edges.x, edges.y) {
            (Some(Edge::Near), Some(Edge::Near)) | (Some(Edge::Far), Some(Edge::Far)) => {
                Self::DiagonalResizeNwse
            }
            (Some(Edge::Near), Some(Edge::Far)) | (Some(Edge::Far), Some(Edge::Near)) => {
                Self::DiagonalResizeNesw
            }
            // A resize gesture always supplies both axes. Keep a safe default
            // for callers that construct a partial edge selection.
            _ => Self::DiagonalResizeNwse,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(self) -> i32 {
        self.right - self.left
    }
    pub fn height(self) -> i32 {
        self.bottom - self.top
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Near,
    Far,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResizeEdges {
    pub x: Option<Edge>,
    pub y: Option<Edge>,
}

impl ResizeEdges {
    /// Select the corner under the pointer when the gesture starts.
    ///
    /// The midpoint belongs to the far (right/bottom) half. The returned
    /// edges are immutable for the rest of a gesture, so reversing the drag
    /// or crossing the midpoint cannot change the selected corner.
    pub fn from_grab_point(point: (i32, i32), rect: Rect) -> Self {
        let center_x = i64::from(rect.left) + (i64::from(rect.right) - i64::from(rect.left)) / 2;
        let center_y = i64::from(rect.top) + (i64::from(rect.bottom) - i64::from(rect.top)) / 2;
        Self {
            x: Some(if i64::from(point.0) < center_x {
                Edge::Near
            } else {
                Edge::Far
            }),
            y: Some(if i64::from(point.1) < center_y {
                Edge::Near
            } else {
                Edge::Far
            }),
        }
    }
}

/// Resize the edges selected at button-down. The opposite corner remains
/// fixed for the whole gesture.
pub fn directional_resized(
    rect: Rect,
    edges: ResizeEdges,
    dx: i32,
    dy: i32,
    min: (i32, i32),
    max: (i32, i32),
) -> Rect {
    fn axis(
        start: i32,
        end: i32,
        edge: Option<Edge>,
        delta: i32,
        min: i32,
        max: i32,
    ) -> (i32, i32) {
        let Some(edge) = edge else {
            return (start, end);
        };
        let original = end - start;
        let requested = match edge {
            Edge::Near => original.saturating_sub(delta),
            Edge::Far => original.saturating_add(delta),
        };
        let size = requested.clamp(min.max(1), max.max(min).max(1));
        match edge {
            Edge::Near => (end - size, end),
            Edge::Far => (start, start + size),
        }
    }
    let (left, right) = axis(rect.left, rect.right, edges.x, dx, min.0, max.0);
    let (top, bottom) = axis(rect.top, rect.bottom, edges.y, dy, min.1, max.1);
    Rect {
        left,
        top,
        right,
        bottom,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const R: Rect = Rect {
        left: -1000,
        top: -500,
        right: 0,
        bottom: 500,
    };
    #[test]
    fn grab_point_selects_each_quadrant_and_midpoints_are_consistent() {
        for (point, expected) in [
            (
                (-750, -250),
                ResizeEdges {
                    x: Some(Edge::Near),
                    y: Some(Edge::Near),
                },
            ),
            (
                (-250, -250),
                ResizeEdges {
                    x: Some(Edge::Far),
                    y: Some(Edge::Near),
                },
            ),
            (
                (-750, 250),
                ResizeEdges {
                    x: Some(Edge::Near),
                    y: Some(Edge::Far),
                },
            ),
            (
                (-250, 250),
                ResizeEdges {
                    x: Some(Edge::Far),
                    y: Some(Edge::Far),
                },
            ),
            // The boundary belongs to the far/right and far/bottom halves.
            (
                (-500, 0),
                ResizeEdges {
                    x: Some(Edge::Far),
                    y: Some(Edge::Far),
                },
            ),
        ] {
            assert_eq!(ResizeEdges::from_grab_point(point, R), expected);
        }
    }

    #[test]
    fn selected_corner_stays_fixed_when_drag_reverses_or_crosses_center() {
        for (point, edges) in [
            (
                (-750, -250),
                ResizeEdges {
                    x: Some(Edge::Near),
                    y: Some(Edge::Near),
                },
            ),
            (
                (-250, -250),
                ResizeEdges {
                    x: Some(Edge::Far),
                    y: Some(Edge::Near),
                },
            ),
            (
                (-750, 250),
                ResizeEdges {
                    x: Some(Edge::Near),
                    y: Some(Edge::Far),
                },
            ),
            (
                (-250, 250),
                ResizeEdges {
                    x: Some(Edge::Far),
                    y: Some(Edge::Far),
                },
            ),
        ] {
            let first = directional_resized(R, edges, 100, 50, (100, 80), (3000, 3000));
            let reversed = directional_resized(R, edges, -100, -50, (100, 80), (3000, 3000));
            // The fixed edge pair is unchanged even though the pointer crossed
            // the original center between the two points.
            match edges {
                ResizeEdges {
                    x: Some(Edge::Near),
                    y: Some(Edge::Near),
                } => {
                    assert_eq!((first.right, first.bottom), (0, 500));
                    assert_eq!((reversed.right, reversed.bottom), (0, 500));
                }
                ResizeEdges {
                    x: Some(Edge::Far),
                    y: Some(Edge::Near),
                } => {
                    assert_eq!((first.left, first.bottom), (-1000, 500));
                    assert_eq!((reversed.left, reversed.bottom), (-1000, 500));
                }
                ResizeEdges {
                    x: Some(Edge::Near),
                    y: Some(Edge::Far),
                } => {
                    assert_eq!((first.right, first.top), (0, -500));
                    assert_eq!((reversed.right, reversed.top), (0, -500));
                }
                ResizeEdges {
                    x: Some(Edge::Far),
                    y: Some(Edge::Far),
                } => {
                    assert_eq!((first.left, first.top), (-1000, -500));
                    assert_eq!((reversed.left, reversed.top), (-1000, -500));
                }
                _ => unreachable!(),
            }
            assert_eq!(ResizeEdges::from_grab_point(point, R), edges);
        }
    }
    #[test]
    fn shrinking_left_and_top_keeps_opposite_corner_fixed() {
        assert_eq!(
            directional_resized(
                R,
                ResizeEdges {
                    x: Some(Edge::Near),
                    y: Some(Edge::Near)
                },
                2000,
                2000,
                (100, 80),
                (3000, 3000)
            ),
            Rect {
                left: -100,
                top: 420,
                right: 0,
                bottom: 500
            }
        );
    }
    #[test]
    fn untouched_axis_stays_fixed_and_can_select_its_direction_later() {
        assert_eq!(
            directional_resized(
                R,
                ResizeEdges {
                    x: Some(Edge::Near),
                    y: None,
                },
                100,
                0,
                (100, 80),
                (3000, 3000)
            ),
            Rect { left: -900, ..R }
        );
    }
    #[test]
    fn both_size_limits_preserve_the_fixed_edges_and_allow_reversal() {
        let edges = ResizeEdges {
            x: Some(Edge::Near),
            y: Some(Edge::Far),
        };
        assert_eq!(
            directional_resized(R, edges, i32::MAX, i32::MIN, (100, 80), (1200, 1100)),
            Rect {
                left: -100,
                top: -500,
                right: 0,
                bottom: -420
            }
        );
        assert_eq!(
            directional_resized(R, edges, i32::MIN, i32::MAX, (100, 80), (1200, 1100)),
            Rect {
                left: -1200,
                top: -500,
                right: 0,
                bottom: 600
            }
        );
        assert_eq!(
            directional_resized(R, edges, 0, 0, (100, 80), (1200, 1100)),
            R
        );
    }
    #[test]
    fn shortcuts_accept_held_modifiers_and_validate_other_keys() {
        for key in [
            "Alt",
            "Control+Alt",
            "Meta",
            "Alt+F24",
            "F2",
            "Control+K",
            "Shift+ArrowLeft",
        ] {
            assert!(HeldShortcut::parse(key).is_ok(), "{key}");
        }
        for key in [
            "",
            "Alt+",
            "Escape",
            "Tab",
            "A+B",
            "F25",
            "Alt+Alt",
            "Alt+unknown",
        ] {
            assert!(HeldShortcut::parse(key).is_err(), "{key}");
        }
    }

    #[test]
    fn gesture_cursor_matches_drag_kind() {
        assert_eq!(GestureCursor::for_resize(false), GestureCursor::Hand);
        assert_eq!(
            GestureCursor::for_resize(true),
            GestureCursor::DiagonalResize
        );
        assert_eq!(
            GestureCursor::for_resize_edges(
                true,
                ResizeEdges {
                    x: Some(Edge::Near),
                    y: Some(Edge::Near),
                }
            ),
            GestureCursor::DiagonalResizeNwse
        );
        assert_eq!(
            GestureCursor::for_resize_edges(
                true,
                ResizeEdges {
                    x: Some(Edge::Far),
                    y: Some(Edge::Near),
                }
            ),
            GestureCursor::DiagonalResizeNesw
        );
    }
}
