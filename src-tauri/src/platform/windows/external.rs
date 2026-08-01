use std::os::windows::ffi::OsStrExt;
use url::Url;
use windows::core::PCWSTR;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const INVALID_URL: &str = "Only valid HTTP or HTTPS URLs can be opened";

pub fn open(value: &str) -> Result<(), String> {
    let url = validate(value)?;
    let verb = wide("open");
    let target = wide(url.as_str());
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    let code = result.0 as isize;
    if code <= 32 {
        Err(format!(
            "The system browser could not open the link, ShellExecuteW returned {code}"
        ))
    } else {
        Ok(())
    }
}

fn validate(value: &str) -> Result<Url, String> {
    if value.is_empty() || value.trim() != value {
        return Err(INVALID_URL.into());
    }
    let url = Url::parse(value).map_err(|_| INVALID_URL.to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(INVALID_URL.into());
    }
    Ok(url)
}

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn accepts_http_and_https_urls() {
        for value in [
            "http://example.com",
            "https://example.com/path?q=screen%20pilot#result",
            "HTTPS://EXAMPLE.COM",
            "https://\u{4f8b}\u{5b50}.com/\u{8def}\u{5f84}",
        ] {
            let url = validate(value).expect("valid external URL");
            assert!(matches!(url.scheme(), "http" | "https"));
            assert!(url.host_str().is_some());
        }
    }

    #[test]
    fn rejects_non_web_protocols_and_relative_urls() {
        for value in [
            "javascript:alert(1)",
            "data:text/html,test",
            "file:///C:/Windows/System32/calc.exe",
            "ftp://example.com/file",
            "shell:AppsFolder",
            "ms-settings:privacy",
            "//example.com/path",
            "/relative/path",
        ] {
            assert!(validate(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn rejects_empty_malformed_and_unbounded_urls() {
        for value in [
            "",
            "https://",
            "http:///",
            "https://exa mple.com",
            " https://example.com",
            "https://example.com ",
        ] {
            assert!(validate(value).is_err(), "accepted {value}");
        }
    }
}
