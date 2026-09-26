use crate::application::state::TranslatorPasteTarget;
use arboard::Clipboard;
use std::ffi::c_void;
use std::thread;
use std::time::{Duration, Instant};
use windows::core::{w, Interface};
use windows::Win32::Foundation::{
    GetLastError, GlobalFree, SetLastError, ERROR_SUCCESS, HANDLE, HGLOBAL, HWND,
    RPC_E_CHANGED_MODE,
};
use windows::Win32::Graphics::Gdi::{
    DeleteEnhMetaFile, DeleteMetaFile, DeleteObject, HENHMETAFILE, HGDIOBJ, HMETAFILE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardSequenceNumber, OpenClipboard, SetClipboardData, METAFILEPICT,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{
    OleDuplicateData, CF_BITMAP, CF_DSPBITMAP, CF_DSPENHMETAFILE, CF_DSPMETAFILEPICT,
    CF_ENHMETAFILE, CF_GDIOBJFIRST, CF_GDIOBJLAST, CF_METAFILEPICT, CF_OWNERDISPLAY, CF_PALETTE,
    CF_PRIVATEFIRST, CF_PRIVATELAST, CLIPBOARD_FORMAT,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP, VK_CONTROL, VK_LWIN,
    VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetForegroundWindow, GetWindowThreadProcessId, IsWindow,
    HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE,
};

const SELECTION_LIMIT: usize = 200_000;

enum SelectionProbe {
    Selected(String),
    NoSelection,
    Unsupported,
}

trait ClipboardFallbackBackend {
    type Snapshot;

    fn wait_for_modifier_release(&mut self);
    fn previous_text(&mut self) -> Option<String>;
    fn sequence(&mut self) -> Option<u32>;
    fn backup(&mut self) -> Result<Self::Snapshot, String>;
    fn send_copy(&mut self) -> bool;
    fn read_copied_text(&mut self, previous_sequence: Option<u32>)
        -> (Option<String>, Option<u32>);
    fn restore(&mut self, snapshot: Self::Snapshot) -> Result<(), String>;
}

struct WindowsClipboardFallback;

struct ClipboardSnapshot {
    formats: Vec<ClipboardFormatBackup>,
}

struct ClipboardFormatBackup {
    format: u32,
    handle: Option<HANDLE>,
}

struct ClipboardOwnerWindow {
    hwnd: HWND,
}

struct OpenClipboardGuard {
    _owner: Option<ClipboardOwnerWindow>,
}

pub fn selected_text(clipboard_fallback: bool) -> String {
    resolve_selection(
        selected_text_uia(),
        clipboard_fallback,
        selected_text_clipboard,
    )
}

/// Capture the foreground window identity before ScreenPilot shows the
/// translator.  The process id protects against a recycled HWND being
/// mistaken for the original target.
pub fn foreground_paste_target() -> Option<TranslatorPasteTarget> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut process_id = 0;
        if GetWindowThreadProcessId(hwnd, Some(&mut process_id)) == 0 || process_id == 0 {
            return None;
        }
        Some(TranslatorPasteTarget {
            hwnd: hwnd.0 as isize,
            process_id,
        })
    }
}

/// Check that the original target still denotes a live window owned by the
/// same process.  This deliberately does not activate or focus the window.
pub fn paste_target_is_valid(target: TranslatorPasteTarget) -> bool {
    let hwnd = hwnd_from_paste_target(target);
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return false;
        }
        let mut process_id = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id)) != 0
            && process_id == target.process_id
    }
}

/// Read the foreground identity at the point where delayed input would be
/// injected.  No focus changes are performed here.
pub fn current_foreground_paste_target() -> Option<TranslatorPasteTarget> {
    foreground_paste_target()
}

/// Read the Win32 clipboard sequence number.  A missing/zero value is not a
/// safe basis for delayed input and is therefore represented as `None`.
pub fn current_clipboard_sequence() -> Option<u32> {
    clipboard_sequence()
}

fn hwnd_from_paste_target(target: TranslatorPasteTarget) -> HWND {
    HWND(target.hwnd as *mut c_void)
}

fn resolve_selection(
    probe: SelectionProbe,
    clipboard_fallback: bool,
    fallback: impl FnOnce() -> Option<String>,
) -> String {
    match probe {
        SelectionProbe::Selected(text) => text,
        SelectionProbe::NoSelection | SelectionProbe::Unsupported if clipboard_fallback => {
            fallback().unwrap_or_default()
        }
        SelectionProbe::NoSelection | SelectionProbe::Unsupported => String::new(),
    }
}

fn selected_text_uia() -> SelectionProbe {
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return SelectionProbe::Unsupported;
        }
        let should_uninitialize = initialized.is_ok();
        let result = (|| {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let focused = automation.GetFocusedElement().ok()?;
            let pattern: IUIAutomationTextPattern = focused
                .GetCurrentPattern(UIA_TextPatternId)
                .ok()?
                .cast()
                .ok()?;
            let ranges = pattern.GetSelection().ok()?;
            let count = ranges.Length().ok()?.max(0);
            let mut parts = Vec::new();
            for index in 0..count {
                let range = ranges.GetElement(index).ok()?;
                let value = range.GetText(-1).ok()?;
                let text = String::from_utf16_lossy(&value);
                if !text.trim().is_empty() {
                    parts.push(text);
                }
            }
            Some(match bounded_selection(parts.join("\n")) {
                Some(text) => SelectionProbe::Selected(text),
                None => SelectionProbe::NoSelection,
            })
        })();
        if should_uninitialize {
            CoUninitialize();
        }
        result.unwrap_or(SelectionProbe::Unsupported)
    }
}

fn selected_text_clipboard() -> Option<String> {
    capture_clipboard_selection(&mut WindowsClipboardFallback)
}

fn capture_clipboard_selection<B: ClipboardFallbackBackend>(backend: &mut B) -> Option<String> {
    backend.wait_for_modifier_release();
    let previous = backend.previous_text();
    let previous_sequence = backend.sequence();
    let snapshot = match backend.backup() {
        Ok(snapshot) => snapshot,
        Err(error) => {
            eprintln!("[selection] Clipboard fallback skipped because backup failed: {error}");
            return None;
        }
    };
    let copied = if backend.send_copy() {
        let (current, current_sequence) = backend.read_copied_text(previous_sequence);
        copied_selection(
            previous.as_deref(),
            current,
            previous_sequence,
            current_sequence,
        )
    } else {
        None
    };
    if let Err(error) = backend.restore(snapshot) {
        eprintln!("[selection] Clipboard restore failed: {error}");
    }
    copied
}

impl ClipboardFallbackBackend for WindowsClipboardFallback {
    type Snapshot = ClipboardSnapshot;

    fn wait_for_modifier_release(&mut self) {
        wait_for_modifier_release(Duration::from_millis(450));
    }

    fn previous_text(&mut self) -> Option<String> {
        Clipboard::new()
            .ok()
            .and_then(|mut clipboard| clipboard.get_text().ok())
    }

    fn sequence(&mut self) -> Option<u32> {
        clipboard_sequence()
    }

    fn backup(&mut self) -> Result<Self::Snapshot, String> {
        ClipboardSnapshot::capture()
    }

    fn send_copy(&mut self) -> bool {
        send_copy().is_some()
    }

    fn read_copied_text(
        &mut self,
        previous_sequence: Option<u32>,
    ) -> (Option<String>, Option<u32>) {
        read_copied_text(previous_sequence, Duration::from_millis(500))
    }

    fn restore(&mut self, snapshot: Self::Snapshot) -> Result<(), String> {
        snapshot.restore()
    }
}

impl ClipboardSnapshot {
    fn capture() -> Result<Self, String> {
        let _clipboard = OpenClipboardGuard::open(Duration::from_millis(100))?;
        let mut formats = Vec::new();
        let mut current = 0;
        loop {
            unsafe { SetLastError(ERROR_SUCCESS) };
            let format = unsafe { EnumClipboardFormats(current) };
            if format == 0 {
                let error = unsafe { GetLastError() };
                if error == ERROR_SUCCESS {
                    break;
                }
                return Err(format!("Clipboard format enumeration failed: {error:?}"));
            }
            if !clipboard_format_has_safe_ownership(format) {
                return Err(format!(
                    "Clipboard format {format} cannot be safely owned and restored"
                ));
            }
            let source = unsafe { GetClipboardData(format) }
                .map_err(|error| format!("Clipboard format {format} is unavailable: {error}"))?;
            let duplicated =
                unsafe { OleDuplicateData(source, CLIPBOARD_FORMAT(format as u16), GMEM_MOVEABLE) };
            if duplicated.is_invalid() {
                return Err(format!("Clipboard format {format} could not be duplicated"));
            }
            formats.push(ClipboardFormatBackup {
                format,
                handle: Some(duplicated),
            });
            current = format;
        }
        Ok(Self { formats })
    }

    fn restore(mut self) -> Result<(), String> {
        let _clipboard = OpenClipboardGuard::open_owned(Duration::from_millis(100))?;
        unsafe { EmptyClipboard() }.map_err(|error| error.to_string())?;
        let mut failures = Vec::new();
        for format in &mut self.formats {
            let Some(handle) = format.handle.take() else {
                continue;
            };
            if let Err(error) = unsafe { SetClipboardData(format.format, Some(handle)) } {
                format.handle = Some(handle);
                failures.push(format!("{}: {error}", format.format));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Clipboard formats could not be restored: {}",
                failures.join("; ")
            ))
        }
    }
}

impl ClipboardOwnerWindow {
    fn create() -> Result<Self, String> {
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("ScreenPilot Clipboard Owner"),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
        }
        .map_err(|error| format!("Clipboard owner window creation failed: {error}"))?;
        Ok(Self { hwnd })
    }
}

impl Drop for ClipboardOwnerWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

impl OpenClipboardGuard {
    fn open(timeout: Duration) -> Result<Self, String> {
        Self::open_with_owner(None, timeout)
    }

    fn open_owned(timeout: Duration) -> Result<Self, String> {
        Self::open_with_owner(Some(ClipboardOwnerWindow::create()?), timeout)
    }

    fn open_with_owner(
        owner: Option<ClipboardOwnerWindow>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let started = Instant::now();
        let hwnd = owner.as_ref().map(|owner| owner.hwnd);
        loop {
            match unsafe { OpenClipboard(hwnd) } {
                Ok(()) => return Ok(Self { _owner: owner }),
                Err(error) if started.elapsed() < timeout => {
                    let _ = error;
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }
}

impl Drop for OpenClipboardGuard {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

impl Drop for ClipboardFormatBackup {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };
        unsafe { free_duplicated_clipboard_data(self.format, handle) };
    }
}

fn clipboard_format_has_safe_ownership(format: u32) -> bool {
    let owner_display = u32::from(CF_OWNERDISPLAY.0);
    let private_first = u32::from(CF_PRIVATEFIRST.0);
    let private_last = u32::from(CF_PRIVATELAST.0);
    let gdi_first = u32::from(CF_GDIOBJFIRST.0);
    let gdi_last = u32::from(CF_GDIOBJLAST.0);
    format != owner_display
        && !(private_first..=private_last).contains(&format)
        && !(gdi_first..=gdi_last).contains(&format)
}

unsafe fn free_duplicated_clipboard_data(format: u32, handle: HANDLE) {
    let bitmap = u32::from(CF_BITMAP.0);
    let display_bitmap = u32::from(CF_DSPBITMAP.0);
    let palette = u32::from(CF_PALETTE.0);
    let enhanced_metafile = u32::from(CF_ENHMETAFILE.0);
    let display_enhanced_metafile = u32::from(CF_DSPENHMETAFILE.0);
    let metafile_picture = u32::from(CF_METAFILEPICT.0);
    let display_metafile_picture = u32::from(CF_DSPMETAFILEPICT.0);
    if matches!(format, value if value == bitmap || value == display_bitmap || value == palette) {
        let _ = unsafe { DeleteObject(HGDIOBJ(handle.0)) };
    } else if matches!(
        format,
        value if value == enhanced_metafile || value == display_enhanced_metafile
    ) {
        let _ = unsafe { DeleteEnhMetaFile(Some(HENHMETAFILE(handle.0))) };
    } else if matches!(
        format,
        value if value == metafile_picture || value == display_metafile_picture
    ) {
        let memory = HGLOBAL(handle.0);
        let pointer = unsafe { GlobalLock(memory) }.cast::<METAFILEPICT>();
        if !pointer.is_null() {
            let metafile = unsafe { (*pointer).hMF };
            if !metafile.is_invalid() {
                let _ = unsafe { DeleteMetaFile(HMETAFILE(metafile.0)) };
            }
            let _ = unsafe { GlobalUnlock(memory) };
        }
        let _ = unsafe { GlobalFree(Some(memory)) };
    } else {
        let _ = unsafe { GlobalFree(Some(HGLOBAL(handle.0))) };
    }
}

fn send_copy() -> Option<()> {
    let mut inputs = [INPUT::default(); 4];
    inputs[0].r#type = INPUT_KEYBOARD;
    inputs[0].Anonymous.ki.wVk = VK_CONTROL;
    inputs[1].r#type = INPUT_KEYBOARD;
    inputs[1].Anonymous.ki.wVk.0 = 0x43;
    inputs[2].r#type = INPUT_KEYBOARD;
    inputs[2].Anonymous.ki.wVk.0 = 0x43;
    inputs[2].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
    inputs[3].r#type = INPUT_KEYBOARD;
    inputs[3].Anonymous.ki.wVk = VK_CONTROL;
    inputs[3].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    (sent == inputs.len() as u32).then_some(())
}

fn wait_for_modifier_release(timeout: Duration) {
    let started = Instant::now();
    while started.elapsed() < timeout {
        let pressed = [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN]
            .iter()
            .any(|key| unsafe { GetAsyncKeyState(key.0 as i32) as u16 & 0x8000 != 0 });
        if !pressed {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn read_copied_text(previous: Option<u32>, timeout: Duration) -> (Option<String>, Option<u32>) {
    let started = Instant::now();
    while started.elapsed() < timeout {
        let current = clipboard_sequence();
        let changed = match (previous, current) {
            (Some(before), Some(after)) => before != after,
            (None, Some(_)) => true,
            _ => false,
        };
        if changed {
            if let Ok(mut clipboard) = Clipboard::new() {
                if let Ok(text) = clipboard.get_text() {
                    return (Some(text), current);
                }
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    (
        Clipboard::new()
            .ok()
            .and_then(|mut clipboard| clipboard.get_text().ok()),
        clipboard_sequence(),
    )
}

fn clipboard_sequence() -> Option<u32> {
    let value = unsafe { GetClipboardSequenceNumber() };
    (value != 0).then_some(value)
}

fn copied_selection(
    previous: Option<&str>,
    current: Option<String>,
    previous_sequence: Option<u32>,
    current_sequence: Option<u32>,
) -> Option<String> {
    let changed_text = match (previous, current.as_deref()) {
        (Some(before), Some(after)) => before != after,
        (None, Some(_)) => true,
        _ => false,
    };
    let changed_sequence = matches!(
        (previous_sequence, current_sequence),
        (Some(before), Some(after)) if before != after
    );
    if !changed_text && !changed_sequence {
        return None;
    }
    current.and_then(bounded_selection)
}

fn bounded_selection(value: String) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.chars().take(SELECTION_LIMIT).collect())
}

#[cfg(test)]
mod tests {
    use super::{
        capture_clipboard_selection, clipboard_format_has_safe_ownership, copied_selection,
        resolve_selection, ClipboardFallbackBackend, ClipboardOwnerWindow, SelectionProbe,
    };
    use std::cell::Cell;
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;

    struct FakeClipboardBackend {
        actions: Vec<&'static str>,
        backup_error: Option<String>,
        restore_error: Option<String>,
        send_succeeds: bool,
    }

    impl Default for FakeClipboardBackend {
        fn default() -> Self {
            Self {
                actions: Vec::new(),
                backup_error: None,
                restore_error: None,
                send_succeeds: true,
            }
        }
    }

    impl ClipboardFallbackBackend for FakeClipboardBackend {
        type Snapshot = ();

        fn wait_for_modifier_release(&mut self) {
            self.actions.push("wait");
        }

        fn previous_text(&mut self) -> Option<String> {
            self.actions.push("previous-text");
            Some("old".into())
        }

        fn sequence(&mut self) -> Option<u32> {
            self.actions.push("sequence");
            Some(10)
        }

        fn backup(&mut self) -> Result<Self::Snapshot, String> {
            self.actions.push("backup");
            match &self.backup_error {
                Some(error) => Err(error.clone()),
                None => Ok(()),
            }
        }

        fn send_copy(&mut self) -> bool {
            self.actions.push("send-copy");
            self.send_succeeds
        }

        fn read_copied_text(
            &mut self,
            _previous_sequence: Option<u32>,
        ) -> (Option<String>, Option<u32>) {
            self.actions.push("read-copy");
            (Some("selected".into()), Some(11))
        }

        fn restore(&mut self, _snapshot: Self::Snapshot) -> Result<(), String> {
            self.actions.push("restore");
            match &self.restore_error {
                Some(error) => Err(error.clone()),
                None => Ok(()),
            }
        }
    }

    #[test]
    fn accepts_equal_clipboard_text_when_the_sequence_changes() {
        assert_eq!(
            copied_selection(Some("same"), Some("same".into()), Some(10), Some(11)),
            Some("same".into())
        );
    }

    #[test]
    fn falls_back_when_uia_reports_no_selection() {
        let fallback_called = Cell::new(false);
        let selection = resolve_selection(SelectionProbe::NoSelection, true, || {
            fallback_called.set(true);
            Some("clipboard selection".into())
        });

        assert!(fallback_called.get());
        assert_eq!(selection, "clipboard selection");
    }

    #[test]
    fn keeps_non_clipboard_probes_side_effect_free() {
        let fallback_called = Cell::new(false);
        assert_eq!(
            resolve_selection(
                SelectionProbe::Selected("uia selection".into()),
                true,
                || {
                    fallback_called.set(true);
                    Some("clipboard selection".into())
                }
            ),
            "uia selection"
        );
        assert!(!fallback_called.get());

        assert_eq!(
            resolve_selection(SelectionProbe::NoSelection, false, || {
                fallback_called.set(true);
                Some("clipboard selection".into())
            }),
            ""
        );
        assert!(!fallback_called.get());
    }

    #[test]
    fn rejects_stale_clipboard_text_and_caps_fresh_text() {
        assert_eq!(
            copied_selection(Some("stale"), Some("stale".into()), Some(10), Some(10)),
            None
        );
        let value = "a".repeat(200_001);
        assert_eq!(
            copied_selection(None, Some(value), None, None)
                .expect("fresh text")
                .chars()
                .count(),
            200_000
        );
    }

    #[test]
    fn backup_failure_aborts_before_sending_copy() {
        let mut backend = FakeClipboardBackend {
            backup_error: Some("snapshot unavailable".into()),
            ..FakeClipboardBackend::default()
        };

        assert_eq!(capture_clipboard_selection(&mut backend), None);
        assert_eq!(
            backend.actions,
            ["wait", "previous-text", "sequence", "backup"]
        );
    }

    #[test]
    fn restores_the_snapshot_after_copy_and_before_returning_selection() {
        let mut backend = FakeClipboardBackend::default();

        assert_eq!(
            capture_clipboard_selection(&mut backend),
            Some("selected".into())
        );
        assert_eq!(
            backend.actions,
            [
                "wait",
                "previous-text",
                "sequence",
                "backup",
                "send-copy",
                "read-copy",
                "restore"
            ]
        );
    }

    #[test]
    fn restores_the_snapshot_even_when_copy_injection_fails() {
        let mut backend = FakeClipboardBackend {
            send_succeeds: false,
            ..FakeClipboardBackend::default()
        };

        assert_eq!(capture_clipboard_selection(&mut backend), None);
        assert_eq!(
            backend.actions,
            [
                "wait",
                "previous-text",
                "sequence",
                "backup",
                "send-copy",
                "restore"
            ]
        );
    }

    #[test]
    fn returns_the_captured_selection_even_when_clipboard_restore_fails() {
        let mut backend = FakeClipboardBackend {
            restore_error: Some("clipboard busy".into()),
            ..FakeClipboardBackend::default()
        };

        assert_eq!(
            capture_clipboard_selection(&mut backend),
            Some("selected".into())
        );
        assert_eq!(backend.actions.last(), Some(&"restore"));
    }

    #[test]
    fn refuses_formats_whose_clipboard_ownership_cannot_be_safely_transferred() {
        assert!(!clipboard_format_has_safe_ownership(128));
        assert!(!clipboard_format_has_safe_ownership(512));
        assert!(!clipboard_format_has_safe_ownership(768));
        assert!(clipboard_format_has_safe_ownership(13));
        assert!(clipboard_format_has_safe_ownership(0xc000));
    }

    #[test]
    fn clipboard_owner_window_is_valid_for_its_raii_lifetime() {
        let hwnd = {
            let owner = ClipboardOwnerWindow::create().expect("create clipboard owner window");
            assert!(unsafe { IsWindow(Some(owner.hwnd)) }.as_bool());
            owner.hwnd
        };

        assert!(!unsafe { IsWindow(Some(hwnd)) }.as_bool());
    }
}
