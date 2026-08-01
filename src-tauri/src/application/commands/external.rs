#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    crate::platform::windows::external::open(&url)
}
