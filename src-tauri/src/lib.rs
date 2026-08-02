mod application;
mod domain;
mod infrastructure;
#[cfg(target_os = "windows")]
mod native_freeze {
    include!(concat!(env!("OUT_DIR"), "/native_freeze_runtime.rs"));
}
mod platform;
mod screenshot;
mod vision;

use application::commands::*;
use application::lifecycle;
use application::state::AppState;
use infrastructure::images::ImageStore;
use infrastructure::settings_store::SettingsStore;
use tauri::{Manager, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;

pub fn run() {
    let restart_parent = std::env::args().find_map(|argument| {
        argument
            .strip_prefix("--restart-parent=")
            .and_then(|value| value.parse::<u32>().ok())
    });
    if let Some(process_id) = restart_parent {
        platform::windows::startup::wait_for_process_exit(process_id);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            lifecycle::focus_second_instance(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            open_external,
            settings_load,
            startup_notice_take,
            settings_save,
            translation_settings_update,
            settings_export,
            settings_import,
            directory_pick,
            credentials_set_provider_keys,
            credentials_provider_key_count,
            credentials_delete_provider_keys,
            providers_fetch_models,
            providers_test,
            translator_translate,
            optimizer_run,
            text_commit,
            window_hide,
            translator_take_selection,
            vision_take_selection,
            vision_request,
            vision_cursor_position,
            vision_list_windows,
            vision_capture_window,
            vision_capture_region,
            explain_read_image,
            vision_register_annotated_image,
            vision_commit_image_to_history,
            vision_delete_history_image,
            vision_close,
            vision_set_floating,
            vision_fly_floating,
            vision_set_hit_region,
            vision_set_ignore_cursor_events,
            vision_ask,
            vision_cancel_stream,
            vision_request_translate,
            vision_translate,
            vision_translate_text,
            synthesize_speech,
            take_vision_selection,
            get_settings,
            save_settings,
            optimize_prompt,
            permissions_status
        ])
        .setup(|app| {
            let executable = std::env::current_exe()?;
            let system_data = app.path().app_data_dir()?;
            let system_webview_data = app.path().app_local_data_dir()?;
            let directories = crate::platform::windows::installation::StorageDirectories::resolve(
                &executable,
                app.path().app_config_dir()?,
                system_data.clone(),
                app.path().app_cache_dir()?,
                system_webview_data.clone(),
            );
            crate::platform::windows::installation::migrate_portable_history(
                &directories,
                &system_data,
                &system_webview_data,
            )
            .map_err(std::io::Error::other)?;
            let store = SettingsStore::new(&directories.configuration);
            let images = ImageStore::new(&directories.data, &directories.cache)
                .map_err(std::io::Error::other)?;
            let settings = store.load().unwrap_or_default();
            app.manage(AppState::new(
                store,
                images,
                settings.clone(),
                directories.webview_data.clone(),
                directories.cache.clone(),
            ));
            screenshot::cleanup_orphan_temp_files();
            if app.get_webview_window("main").is_none() {
                let config = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|window| window.label == "main")
                    .ok_or("Main window configuration is missing")?;
                WebviewWindowBuilder::from_config(app, config)?
                    .data_directory(directories.webview_data.clone())
                    .build()?;
            }
            lifecycle::preload_translator_window(app.handle()).map_err(std::io::Error::other)?;
            lifecycle::create_tray(app.handle()).map_err(std::io::Error::other)?;
            if let Err(error) = lifecycle::register_shortcuts(app.handle(), &settings) {
                app.state::<AppState>().set_startup_notice(format!(
                    "快捷键冲突：{error}。其他入口仍可通过托盘打开，请修改快捷键后保存。"
                ));
            }
            lifecycle::startup_window(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(lifecycle::handle_window_event)
        .run(tauri::generate_context!())
        .expect("ScreenPilot failed to run");
}
