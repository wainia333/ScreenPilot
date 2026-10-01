use crate::application::state::CancellationSignal;
use crate::domain::integrations::karakeep::SearchMode;
use crate::infrastructure::{credentials::CredentialVault, karakeep_http::KarakeepService};
use serde_json::{json, Value};
#[tauri::command]
pub fn integration_open_settings(app: tauri::AppHandle) -> Result<(), String> {
    crate::application::lifecycle::show_main(&app, crate::application::state::MainRoute::Settings)
}
#[tauri::command]
pub fn integration_karakeep_configured() -> Result<bool, String> {
    Ok(CredentialVault::integration_key()?.is_some())
}
#[tauri::command]
pub async fn integration_karakeep_test(
    base_url: String,
    api_key: Option<String>,
) -> Result<Value, String> {
    let key = match api_key.filter(|s| !s.trim().is_empty()) {
        Some(draft) => draft,
        None => CredentialVault::integration_key()?.ok_or("KARAKEEP_AUTH: 请先输入 API Key")?,
    };
    let service = KarakeepService::new(&base_url, key)?;
    // A real, read-only authenticated request; draft address/key are never persisted.
    let result = service
        .search(
            "Karakeep",
            SearchMode::Hybrid,
            1,
            None,
            &CancellationSignal::new(),
        )
        .await?;
    Ok(
        json!({"connected":true,"effectiveMode":"unknown","message":"只读API连接成功","sampleCount":result.bookmarks.len()}),
    )
}
