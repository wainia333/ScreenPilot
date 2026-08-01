use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW,
    WaitForSingleObject, INFINITE, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE,
};
use windows::Win32::UI::Shell::{
    ShellExecuteExW, ShellExecuteW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL};

const TASK_NAME: &str = "ScreenPilot Elevated Startup";
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn is_enabled() -> Result<bool, String> {
    Command::new("schtasks.exe")
        .args(["/Query", "/TN", TASK_NAME])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|status| status.success())
        .map_err(|error| error.to_string())
}

pub fn set_enabled(enabled: bool, executable: &Path) -> Result<(), String> {
    let executable = executable
        .to_str()
        .ok_or("Application path is not valid Unicode")?;
    let arguments = if enabled {
        format!(
            "/Create /TN \"{TASK_NAME}\" /SC ONLOGON /RL HIGHEST /TR \"\\\"{executable}\\\" --autostart --administrator\" /F"
        )
    } else {
        format!("/Delete /TN \"{TASK_NAME}\" /F")
    };
    run_elevated_schtasks(&arguments)
}

pub fn launch_elevated_restart() -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable = wide_os(executable.as_os_str());
    let verb = wide("runas");
    let arguments = wide(&format!("--restart-parent={}", unsafe {
        GetCurrentProcessId()
    }));
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(executable.as_ptr()),
            PCWSTR(arguments.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    let code = result.0 as isize;
    if code <= 32 {
        Err(format!(
            "Administrator restart was cancelled or failed with code {code}"
        ))
    } else {
        Ok(())
    }
}

pub fn wait_for_process_exit(process_id: u32) {
    let Ok(current_executable) = std::env::current_exe() else {
        return;
    };
    let Ok(handle) = (unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            process_id,
        )
    }) else {
        return;
    };
    let handle = ProcessHandle(handle);
    let Some(parent_executable) = process_image_path(handle.0) else {
        return;
    };
    if !paths_equal(&parent_executable, &current_executable) {
        return;
    }
    unsafe {
        WaitForSingleObject(handle.0, 30_000);
    }
}

fn process_image_path(handle: HANDLE) -> Option<std::path::PathBuf> {
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .ok()?;
    }
    buffer.truncate(length as usize);
    Some(std::path::PathBuf::from(std::ffi::OsString::from_wide(
        &buffer,
    )))
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .replace('/', "\\")
        .eq_ignore_ascii_case(&right.to_string_lossy().replace('/', "\\"))
}

fn run_elevated_schtasks(arguments: &str) -> Result<(), String> {
    let verb = wide("runas");
    let executable = wide("schtasks.exe");
    let parameters = wide(arguments);
    let mut process = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(executable.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        ShellExecuteExW(&mut process).map_err(|error| error.to_string())?;
        let handle = ProcessHandle(process.hProcess);
        WaitForSingleObject(handle.0, INFINITE);
        let mut exit_code = 1;
        GetExitCodeProcess(handle.0, &mut exit_code).map_err(|error| error.to_string())?;
        if exit_code != 0 {
            return Err(format!(
                "Administrator startup task exited with code {exit_code}"
            ));
        }
    }
    Ok(())
}

struct ProcessHandle(HANDLE);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    wide_os(std::ffi::OsStr::new(value))
}

fn wide_os(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}
