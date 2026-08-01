use std::path::{Path, PathBuf};
use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
};
use winreg::RegKey;

const PRODUCT_NAME: &str = "ScreenPilot";
const PUBLISHER: &str = "Wainia";
const UNINSTALL_ROOT: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StorageDirectories {
    pub configuration: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub webview_data: PathBuf,
    pub portable: bool,
}

impl StorageDirectories {
    pub fn resolve(
        executable: &Path,
        system_configuration: PathBuf,
        system_data: PathBuf,
        system_cache: PathBuf,
        system_webview_data: PathBuf,
    ) -> Self {
        select_storage_directories(
            executable,
            system_configuration,
            system_data,
            system_cache,
            system_webview_data,
            cfg!(debug_assertions),
            installed_executable(executable),
        )
    }
}

fn select_storage_directories(
    executable: &Path,
    system_configuration: PathBuf,
    system_data: PathBuf,
    system_cache: PathBuf,
    system_webview_data: PathBuf,
    development_build: bool,
    installed: bool,
) -> StorageDirectories {
    if development_build || installed {
        return StorageDirectories {
            configuration: system_configuration,
            data: system_data,
            cache: system_cache,
            webview_data: system_webview_data,
            portable: false,
        };
    }

    let executable_directory = executable.parent().unwrap_or(&system_configuration);
    let portable_data = executable_directory.join("ScreenPilot-data");
    StorageDirectories {
        configuration: executable_directory.to_path_buf(),
        data: portable_data.clone(),
        cache: portable_data.join("cache"),
        webview_data: portable_data.join("webview"),
        portable: true,
    }
}

pub fn migrate_portable_history(
    directories: &StorageDirectories,
    system_data: &Path,
    system_webview_data: &Path,
) -> Result<(), String> {
    if !directories.portable {
        return Ok(());
    }
    copy_directory_if_missing(
        &system_data.join("screenpilot-history-images"),
        &directories.data.join("screenpilot-history-images"),
    )?;
    copy_directory_if_missing(
        &system_webview_data.join("EBWebView"),
        &directories.webview_data.join("EBWebView"),
    )
}

fn copy_directory_if_missing(source: &Path, target: &Path) -> Result<(), String> {
    if !source.is_dir() || target.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory_if_missing(&source_path, &target_path)?;
        } else {
            std::fs::copy(source_path, target_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn installed_executable(executable: &Path) -> bool {
    let Some(directory) = executable.parent() else {
        return false;
    };
    let installed_locations = registry_install_locations();
    let program_files = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    path_is_installed(directory, &installed_locations, &program_files)
}

fn registry_install_locations() -> Vec<PathBuf> {
    let mut locations = Vec::new();
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let hive = RegKey::predef(root);
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            if let Ok(uninstall) = hive.open_subkey_with_flags(UNINSTALL_ROOT, KEY_READ | view) {
                for name in uninstall.enum_keys().filter_map(Result::ok) {
                    let Ok(entry) = uninstall.open_subkey_with_flags(name, KEY_READ | view) else {
                        continue;
                    };
                    let display_name = entry.get_value::<String, _>("DisplayName");
                    let publisher = entry.get_value::<String, _>("Publisher");
                    if product_identity_matches(
                        display_name.as_deref().ok(),
                        publisher.as_deref().ok(),
                    ) {
                        if let Ok(value) = entry.get_value::<String, _>("InstallLocation") {
                            push_location(&mut locations, &value);
                        }
                    }
                }
            }
        }
    }
    locations
}

fn product_identity_matches(display_name: Option<&str>, publisher: Option<&str>) -> bool {
    display_name.is_some_and(|value| value.trim().eq_ignore_ascii_case(PRODUCT_NAME))
        && publisher.is_some_and(|value| value.trim().eq_ignore_ascii_case(PUBLISHER))
}

fn push_location(locations: &mut Vec<PathBuf>, value: &str) {
    let trimmed = value.trim().trim_matches('\"');
    if !trimmed.is_empty() {
        locations.push(PathBuf::from(trimmed));
    }
}

fn path_is_installed(
    executable_directory: &Path,
    installed_locations: &[PathBuf],
    program_files: &[PathBuf],
) -> bool {
    installed_locations
        .iter()
        .any(|location| paths_equal(executable_directory, location))
        || program_files
            .iter()
            .any(|directory| path_starts_with(executable_directory, directory))
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    normalized(left) == normalized(right)
}

fn path_starts_with(path: &Path, base: &Path) -> bool {
    let path = normalized(path);
    let base = normalized(base);
    path == base
        || path
            .strip_prefix(&base)
            .is_some_and(|remainder| remainder.starts_with('\\'))
}

fn normalized(path: &Path) -> String {
    path.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_installed_and_portable_locations() {
        let installed = vec![PathBuf::from(r"C:\Apps\ScreenPilot")];
        let program_files = vec![PathBuf::from(r"C:\Program Files")];
        assert!(path_is_installed(
            Path::new("c:\\apps\\screenpilot\\"),
            &installed,
            &program_files
        ));
        assert!(path_is_installed(
            Path::new(r"C:\Program Files\ScreenPilot"),
            &[],
            &program_files
        ));
        assert!(!path_is_installed(
            Path::new(r"C:\Program Files Backup\ScreenPilot"),
            &[],
            &program_files
        ));
        assert!(!path_is_installed(
            Path::new(r"D:\Portable\ScreenPilot"),
            &installed,
            &program_files
        ));
    }

    #[test]
    fn keeps_installed_and_development_storage_in_the_system_directories() {
        let executable = Path::new(r"D:\Portable\ScreenPilot\screenpilot.exe");
        let expected = StorageDirectories {
            configuration: PathBuf::from(r"C:\Users\User\AppData\Roaming\ScreenPilot"),
            data: PathBuf::from(r"C:\Users\User\AppData\Roaming\ScreenPilot\data"),
            cache: PathBuf::from(r"C:\Users\User\AppData\Local\ScreenPilot\cache"),
            webview_data: PathBuf::from(r"C:\Users\User\AppData\Local\ScreenPilot\webview"),
            portable: false,
        };
        for (development_build, installed) in [(true, false), (false, true)] {
            assert_eq!(
                select_storage_directories(
                    executable,
                    expected.configuration.clone(),
                    expected.data.clone(),
                    expected.cache.clone(),
                    expected.webview_data.clone(),
                    development_build,
                    installed,
                ),
                expected
            );
        }
    }

    #[test]
    fn keeps_every_portable_runtime_store_beside_the_executable() {
        let portable = Path::new(r"D:\Portable\ScreenPilot\screenpilot.exe");
        let directories = select_storage_directories(
            portable,
            PathBuf::from(r"C:\Users\User\AppData\Roaming\ScreenPilot"),
            PathBuf::from(r"C:\Users\User\AppData\Roaming\ScreenPilot"),
            PathBuf::from(r"C:\Users\User\AppData\Local\ScreenPilot\cache"),
            PathBuf::from(r"C:\Users\User\AppData\Local\ScreenPilot"),
            false,
            false,
        );
        assert_eq!(
            directories.configuration,
            PathBuf::from(r"D:\Portable\ScreenPilot")
        );
        assert_eq!(
            directories.data,
            PathBuf::from(r"D:\Portable\ScreenPilot\ScreenPilot-data")
        );
        assert_eq!(
            directories.cache,
            PathBuf::from(r"D:\Portable\ScreenPilot\ScreenPilot-data\cache")
        );
        assert_eq!(
            directories.webview_data,
            PathBuf::from(r"D:\Portable\ScreenPilot\ScreenPilot-data\webview")
        );
        assert!(directories.portable);
    }

    #[test]
    fn migrates_existing_history_into_an_empty_portable_store_once() {
        let source = tempfile::tempdir().expect("source");
        let portable = tempfile::tempdir().expect("portable");
        let system_images = source.path().join("screenpilot-history-images");
        let system_webview = source.path().join("EBWebView/Default/Local Storage");
        std::fs::create_dir_all(&system_images).expect("images");
        std::fs::create_dir_all(&system_webview).expect("webview");
        std::fs::write(system_images.join("image.png"), b"image").expect("image");
        std::fs::write(system_webview.join("history"), b"history").expect("history");
        let data = portable.path().join("ScreenPilot-data");
        let directories = StorageDirectories {
            configuration: portable.path().to_path_buf(),
            data: data.clone(),
            cache: data.join("cache"),
            webview_data: data.join("webview"),
            portable: true,
        };
        migrate_portable_history(&directories, source.path(), source.path()).expect("migrate");
        assert_eq!(
            std::fs::read(
                directories
                    .data
                    .join("screenpilot-history-images/image.png")
            )
            .expect("portable image"),
            b"image"
        );
        let portable_history = directories
            .webview_data
            .join("EBWebView/Default/Local Storage/history");
        assert_eq!(
            std::fs::read(&portable_history).expect("portable history"),
            b"history"
        );
        std::fs::write(&portable_history, b"portable").expect("replace portable history");
        migrate_portable_history(&directories, source.path(), source.path()).expect("repeat");
        assert_eq!(
            std::fs::read(portable_history).expect("kept portable history"),
            b"portable"
        );
    }

    #[test]
    fn only_accepts_the_screenpilot_uninstall_identity() {
        assert!(product_identity_matches(
            Some(" ScreenPilot "),
            Some("wainia")
        ));
        assert!(!product_identity_matches(
            Some("ScreenPilot"),
            Some("Another publisher")
        ));
        assert!(!product_identity_matches(
            Some("Another app"),
            Some("Wainia")
        ));
    }
}
