//! Window operations run independently of the input hook.
use super::Mailbox;
use crate::domain::altsnap::{directional_resized, Rect, ResizeEdges};
use std::sync::Arc;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, GetSystemMetricsForDpi, SetThreadDpiAwarenessContext,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Target {
    handle: usize,
    pid: u32,
    tid: u32,
    pub(super) rect: Rect,
}

impl Target {
    fn hwnd(self) -> HWND {
        HWND(self.handle as *mut _)
    }
    fn valid(self) -> bool {
        let mut pid = 0;
        let tid = unsafe { GetWindowThreadProcessId(self.hwnd(), Some(&mut pid)) };
        pid == self.pid && tid == self.tid && unsafe { IsWindowVisible(self.hwnd()).as_bool() }
    }
}

#[derive(Clone, Copy)]
pub(super) struct Motion {
    pub point: POINT,
    #[allow(dead_code)]
    pub edges: ResizeEdges,
}

pub(super) enum Command {
    Begin {
        target: Target,
        point: POINT,
        resize: bool,
        edges: ResizeEdges,
        focus: bool,
    },
    Move(Motion),
    End(Motion),
    Cancel,
    Stop,
}

pub(super) fn target_at(point: POINT) -> Option<Target> {
    unsafe {
        // Low-level hook coordinates are physical. Windows can invoke a hook
        // in a different DPI context from its message-loop thread, so set the
        // context at the hit test too, then restore it before returning.
        let previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let hwnd = GetAncestor(WindowFromPoint(point), GA_ROOT);
        let _ = SetThreadDpiAwarenessContext(previous);
        if hwnd.0.is_null()
            || !IsWindowVisible(hwnd).as_bool()
            || !IsWindowEnabled(hwnd).as_bool()
            || IsIconic(hwnd).as_bool()
            || hwnd == GetDesktopWindow()
            || hwnd == GetShellWindow()
        {
            return None;
        }
        let mut class = [0u16; 128];
        let length = GetClassNameW(hwnd, &mut class) as usize;
        let class = String::from_utf16_lossy(&class[..length]);
        if matches!(
            class.as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "#32768"
        ) {
            return None;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err()
            || rect.right <= rect.left
            || rect.bottom <= rect.top
        {
            return None;
        }
        let rect = rect_from(rect);
        let mut pid = 0;
        let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if tid == 0 {
            return None;
        }
        Some(Target {
            handle: hwnd.0 as usize,
            pid,
            tid,
            rect,
        })
    }
}

struct Movement {
    target: Target,
    origin: Rect,
    original_screen: Rect,
    placement: WINDOWPLACEMENT,
    point: POINT,
    resize: bool,
    edges: ResizeEdges,
    min: (i32, i32),
    max: (i32, i32),
    started: bool,
    maximized: bool,
}

fn rect_from(rect: RECT) -> Rect {
    Rect {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}
fn message(hwnd: HWND, msg: u32, w: usize, l: isize) -> bool {
    unsafe {
        SendMessageTimeoutW(
            hwnd,
            msg,
            WPARAM(w),
            LPARAM(l),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            50,
            None,
        )
        .0 != 0
    }
}
fn place(hwnd: HWND, rect: Rect, move_only: bool) -> bool {
    unsafe {
        // Match AltSnap's RESIZEFLAG for synchronous resize and border moves.
        let mut flags = SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER;
        if move_only {
            flags |= SWP_NOSIZE;
        }
        SetWindowPos(
            hwnd,
            None,
            rect.left,
            rect.top,
            rect.width(),
            rect.height(),
            flags,
        )
        .is_ok()
    }
}

/// Give the target the same resize negotiation it receives during a native
/// border drag.  A number of clients (notably terminal/grid based windows)
/// use WM_SIZING to snap the proposed rectangle before handling WM_SIZE.  The
/// return value is significant: DefWindowProc returns zero, while a client
/// that changed the RECT returns nonzero and asks Windows to use that value.
fn let_window_kick_back(hwnd: HWND, rect: Rect, edges: ResizeEdges) -> Rect {
    let sizing_edge = match (edges.x, edges.y) {
        (Some(crate::domain::altsnap::Edge::Near), Some(crate::domain::altsnap::Edge::Near)) => {
            WMSZ_TOPLEFT
        }
        (Some(crate::domain::altsnap::Edge::Far), Some(crate::domain::altsnap::Edge::Near)) => {
            WMSZ_TOPRIGHT
        }
        (Some(crate::domain::altsnap::Edge::Near), Some(crate::domain::altsnap::Edge::Far)) => {
            WMSZ_BOTTOMLEFT
        }
        (Some(crate::domain::altsnap::Edge::Far), Some(crate::domain::altsnap::Edge::Far)) => {
            WMSZ_BOTTOMRIGHT
        }
        (Some(crate::domain::altsnap::Edge::Near), None) => WMSZ_LEFT,
        (Some(crate::domain::altsnap::Edge::Far), None) => WMSZ_RIGHT,
        (None, Some(crate::domain::altsnap::Edge::Near)) => WMSZ_TOP,
        (None, Some(crate::domain::altsnap::Edge::Far)) => WMSZ_BOTTOM,
        (None, None) => return rect,
    };
    let mut proposed = RECT {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    };
    let mut result = 0;
    let delivered = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_SIZING,
            WPARAM(sizing_edge as usize),
            LPARAM(&mut proposed as *mut RECT as isize),
            SMTO_ABORTIFHUNG,
            64,
            Some(&mut result),
        )
    };
    if delivered.0 == 0 || result == 0 {
        return rect;
    }
    if proposed.right <= proposed.left || proposed.bottom <= proposed.top {
        return rect;
    }
    Rect {
        left: proposed.left,
        top: proposed.top,
        right: proposed.right,
        bottom: proposed.bottom,
    }
}

impl Movement {
    fn begin(
        target: Target,
        point: POINT,
        resize: bool,
        edges: ResizeEdges,
        focus: bool,
    ) -> Option<Self> {
        if !target.valid() || !message(target.hwnd(), WM_NULL, 0, 0) {
            return None;
        }
        unsafe {
            let hwnd = target.hwnd();
            let mut rect = RECT::default();
            let mut placement = WINDOWPLACEMENT {
                length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                ..Default::default()
            };
            GetWindowRect(hwnd, &mut rect).ok()?;
            GetWindowPlacement(hwnd, &mut placement).ok()?;
            let origin = rect_from(rect);
            let dpi = GetDpiForWindow(hwnd);
            let mut limits = MINMAXINFO {
                ptMinTrackSize: POINT {
                    x: GetSystemMetricsForDpi(SM_CXMINTRACK, dpi).max(1),
                    y: GetSystemMetricsForDpi(SM_CYMINTRACK, dpi).max(1),
                },
                ptMaxTrackSize: POINT {
                    x: GetSystemMetricsForDpi(SM_CXMAXTRACK, dpi),
                    y: GetSystemMetricsForDpi(SM_CYMAXTRACK, dpi),
                },
                ..Default::default()
            };
            if resize {
                // AltSnap GetMinMaxInfoF: initialize DPI-correct defaults, then
                // let the application override them. A timeout must not disable
                // resizing; applications may not implement this message.
                let mut result = 0;
                let _ = SendMessageTimeoutW(
                    hwnd,
                    WM_GETMINMAXINFO,
                    WPARAM(0),
                    LPARAM(&mut limits as *mut _ as isize),
                    SMTO_ABORTIFHUNG,
                    32,
                    Some(&mut result),
                );
            }
            if focus {
                let _ = SetForegroundWindow(hwnd);
            }
            Some(Self {
                target,
                origin,
                original_screen: origin,
                placement,
                point,
                resize,
                edges,
                min: (
                    limits.ptMinTrackSize.x.max(1),
                    limits.ptMinTrackSize.y.max(1),
                ),
                max: (
                    limits.ptMaxTrackSize.x.max(limits.ptMinTrackSize.x),
                    limits.ptMaxTrackSize.y.max(limits.ptMinTrackSize.y),
                ),
                started: false,
                maximized: IsZoomed(hwnd).as_bool(),
            })
        }
    }

    fn apply(&mut self, motion: Motion) {
        if !self.target.valid() {
            return;
        }
        let dx = motion.point.x - self.point.x;
        let dy = motion.point.y - self.point.y;
        if !self.started && dx == 0 && dy == 0 {
            return;
        }
        let hwnd = self.target.hwnd();
        if !self.started {
            if self.maximized && dx.abs().max(dy.abs()) < 20 {
                return;
            }
            if self.maximized {
                let saved = self.origin;
                let normal = rect_from(self.placement.rcNormalPosition);
                if !message(hwnd, WM_SYSCOMMAND, SC_RESTORE as usize, 0) {
                    return;
                }
                if !self.resize {
                    let width = normal.width().max(self.min.0);
                    let height = normal.height().max(self.min.1);
                    let x = self.point.x
                        - (i64::from(self.point.x - saved.left) * i64::from(width)
                            / i64::from(saved.width())) as i32;
                    let y = self.point.y
                        - (i64::from(self.point.y - saved.top) * i64::from(height)
                            / i64::from(saved.height())) as i32;
                    self.origin = Rect {
                        left: x,
                        top: y,
                        right: x + width,
                        bottom: y + height,
                    };
                }
            }
            let _ = unsafe { PostMessageW(Some(hwnd), WM_ENTERSIZEMOVE, WPARAM(0), LPARAM(0)) };
            self.started = true;
        }
        let mut rect = if self.resize {
            directional_resized(self.origin, self.edges, dx, dy, self.min, self.max)
        } else {
            Rect {
                left: self.origin.left + dx,
                top: self.origin.top + dy,
                right: self.origin.right + dx,
                bottom: self.origin.bottom + dy,
            }
        };
        if self.resize {
            // Match AltSnap's LetWindowKickBack path: let a client adjust the
            // candidate rectangle (for example to a terminal cell grid) and
            // only use the adjustment when the client explicitly returns true.
            rect = let_window_kick_back(hwnd, rect, self.edges);
        }
        // Like upstream's normal SetWindowPos path, apply the latest geometry
        // directly. The resize path stays synchronous so WM_SIZE and paint
        // invalidation are ordered with the worker's latest candidate.
        place(hwnd, rect, !self.resize && !self.maximized);
    }

    fn finish(mut self, cancelled: bool, motion: Option<Motion>) {
        if !self.target.valid() {
            return;
        }
        if let Some(motion) = motion {
            self.apply(motion);
        }
        if !self.started {
            return;
        }
        let hwnd = self.target.hwnd();
        if cancelled {
            let _ = unsafe { SetWindowPlacement(hwnd, &self.placement) };
            if !self.maximized {
                place(hwnd, self.original_screen, false);
            }
        }
        let _ = unsafe { PostMessageW(Some(hwnd), WM_EXITSIZEMOVE, WPARAM(0), LPARAM(0)) };
    }
}

pub(super) fn run(mailbox: Arc<Mailbox>) {
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let mut movement: Option<Movement> = None;
    loop {
        match mailbox.receive() {
            Command::Begin {
                target,
                point,
                resize,
                edges,
                focus,
            } => {
                if let Some(previous) = movement.take() {
                    previous.finish(true, None);
                }
                movement = Movement::begin(target, point, resize, edges, focus);
            }
            Command::Move(point) => {
                if let Some(movement) = &mut movement {
                    movement.apply(point);
                }
            }
            Command::End(point) => {
                if let Some(movement) = movement.take() {
                    movement.finish(false, Some(point));
                }
            }
            Command::Cancel => {
                if let Some(movement) = movement.take() {
                    movement.finish(true, None);
                }
            }
            Command::Stop => {
                if let Some(movement) = movement.take() {
                    movement.finish(true, None);
                }
                break;
            }
        }
    }
}
