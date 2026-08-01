use arboard::Clipboard;
use std::thread;
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP, VK_CONTROL, VK_LWIN,
    VK_MENU, VK_RWIN, VK_SHIFT,
};

const SELECTION_LIMIT: usize = 200_000;

enum SelectionProbe {
    Selected(String),
    NoSelection,
    Unsupported,
}

pub fn selected_text(clipboard_fallback: bool) -> String {
    match selected_text_uia() {
        SelectionProbe::Selected(text) => text,
        SelectionProbe::NoSelection => String::new(),
        SelectionProbe::Unsupported => clipboard_fallback
            .then(selected_text_clipboard)
            .flatten()
            .unwrap_or_default(),
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
    let previous = Clipboard::new()
        .ok()
        .and_then(|mut clipboard| clipboard.get_text().ok());
    let previous_sequence = clipboard_sequence();
    wait_for_modifier_release(Duration::from_millis(450));
    send_copy()?;
    let (current, current_sequence) =
        read_copied_text(previous_sequence, Duration::from_millis(500));
    if let Some(value) = &previous {
        if let Ok(mut clipboard) = Clipboard::new() {
            let _ = clipboard.set_text(value.clone());
        }
    }
    copied_selection(
        previous.as_deref(),
        current,
        previous_sequence,
        current_sequence,
    )
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
    use super::copied_selection;

    #[test]
    fn accepts_equal_clipboard_text_when_the_sequence_changes() {
        assert_eq!(
            copied_selection(Some("same"), Some("same".into()), Some(10), Some(11)),
            Some("same".into())
        );
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
}
