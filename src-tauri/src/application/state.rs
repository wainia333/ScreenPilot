use crate::domain::settings::AppSettings;
use crate::infrastructure::images::ImageStore;
use crate::infrastructure::settings_store::SettingsStore;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use tokio::sync::Notify;

/// A per-request cancellation primitive. The atomic flag makes cancellation
/// cheap to probe between events, while Notify wakes an in-flight network
/// operation immediately instead of waiting for another SSE chunk.
pub struct CancellationSignal {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancellationSignal {
    pub fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

pub struct AppState {
    pub settings: RwLock<AppSettings>,
    pub store: SettingsStore,
    pub images: ImageStore,
    pub webview_data_directory: PathBuf,
    pub cache_directory: PathBuf,
    pub vision_busy: AtomicBool,
    reference_vision: Mutex<ReferenceVisionState>,
    surface_generation: AtomicU64,
    surface_transition: Mutex<()>,
    settings_write: Mutex<()>,
    translator_selection: Mutex<String>,
    vision_selection: Mutex<String>,
    startup_notice: Mutex<Option<String>>,
}

struct ReferenceVisionState {
    generation: u64,
    cancelled: bool,
    signal: Arc<CancellationSignal>,
}

impl AppState {
    pub fn new(
        store: SettingsStore,
        images: ImageStore,
        settings: AppSettings,
        webview_data_directory: PathBuf,
        cache_directory: PathBuf,
    ) -> Self {
        Self {
            settings: RwLock::new(settings),
            store,
            images,
            webview_data_directory,
            cache_directory,
            vision_busy: AtomicBool::new(false),
            reference_vision: Mutex::new(ReferenceVisionState {
                generation: 0,
                cancelled: false,
                signal: Arc::new(CancellationSignal::new()),
            }),
            surface_generation: AtomicU64::new(0),
            surface_transition: Mutex::new(()),
            settings_write: Mutex::new(()),
            translator_selection: Mutex::new(String::new()),
            vision_selection: Mutex::new(String::new()),
            startup_notice: Mutex::new(None),
        }
    }

    pub fn begin_vision(&self) -> bool {
        self.vision_busy.swap(true, Ordering::SeqCst)
    }

    pub fn release_vision(&self) {
        self.vision_busy.store(false, Ordering::SeqCst);
    }

    pub fn begin_reference_vision_stream(&self) -> u64 {
        let Ok(mut state) = self.reference_vision.lock() else {
            return 0;
        };
        // Invalidate the old generation before waking it. This ordering closes
        // the Stop/new-request interleaving where an old task could observe the
        // new token while its wakeup was still in flight.
        state.generation = state.generation.wrapping_add(1).max(1);
        state.signal.cancel();
        state.cancelled = false;
        state.signal = Arc::new(CancellationSignal::new());
        state.generation
    }

    pub fn cancel_reference_vision_stream(&self) {
        if let Ok(mut state) = self.reference_vision.lock() {
            state.generation = state.generation.wrapping_add(1).max(1);
            state.cancelled = true;
            state.signal.cancel();
        }
    }

    pub fn reference_vision_signal(&self, generation: u64) -> Option<Arc<CancellationSignal>> {
        let state = self.reference_vision.lock().ok()?;
        (state.generation == generation && !state.cancelled).then(|| Arc::clone(&state.signal))
    }

    #[allow(dead_code)]
    pub fn reference_vision_stream_cancelled(&self) -> bool {
        self.reference_vision
            .lock()
            .map(|state| state.cancelled)
            .unwrap_or(true)
    }

    pub fn reference_vision_stream_current(&self, generation: u64) -> bool {
        self.reference_vision
            .lock()
            .map(|state| state.generation == generation && !state.cancelled)
            .unwrap_or(false)
    }

    pub fn begin_surface_action(&self) -> u64 {
        self.surface_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn surface_action_is_current(&self, generation: u64) -> bool {
        self.surface_generation.load(Ordering::SeqCst) == generation
    }

    pub fn with_current_surface_action<T>(
        &self,
        generation: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        let _guard = self
            .surface_transition
            .lock()
            .map_err(|_| "Surface transition state is unavailable".to_string())?;
        if !self.surface_action_is_current(generation) {
            return Ok(None);
        }
        action().map(Some)
    }

    pub fn current(&self) -> Result<AppSettings, String> {
        self.settings
            .read()
            .map(|settings| settings.clone())
            .map_err(|_| "Settings state is unavailable".into())
    }

    pub fn replace(&self, settings: &AppSettings) -> Result<(), String> {
        *self
            .settings
            .write()
            .map_err(|_| "Settings state is unavailable")? = settings.clone();
        Ok(())
    }

    pub fn lock_settings_write(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.settings_write
            .lock()
            .map_err(|_| "Settings write state is unavailable".into())
    }

    pub fn set_translator_selection(&self, value: String) {
        if let Ok(mut selection) = self.translator_selection.lock() {
            *selection = value;
        }
    }

    pub fn take_translator_selection(&self) -> String {
        self.translator_selection
            .lock()
            .map(|selection| selection.clone())
            .unwrap_or_default()
    }

    pub fn set_vision_selection(&self, value: String) {
        if let Ok(mut selection) = self.vision_selection.lock() {
            *selection = value.chars().take(200_000).collect();
        }
    }

    pub fn take_vision_selection(&self) -> String {
        self.vision_selection
            .lock()
            .map(|mut selection| std::mem::take(&mut *selection))
            .unwrap_or_default()
    }

    pub fn set_startup_notice(&self, value: String) {
        if let Ok(mut notice) = self.startup_notice.lock() {
            *notice = Some(value);
        }
    }

    pub fn take_startup_notice(&self) -> Option<String> {
        self.startup_notice
            .lock()
            .ok()
            .and_then(|mut notice| notice.take())
    }
}

#[cfg(test)]
mod tests {
    use super::AppState;
    use crate::domain::settings::AppSettings;
    use crate::infrastructure::images::ImageStore;
    use crate::infrastructure::settings_store::SettingsStore;
    use tempfile::TempDir;

    fn state() -> (AppState, TempDir) {
        let directory = TempDir::new().expect("temp dir");
        let store = SettingsStore::new(directory.path());
        let images = ImageStore::new(directory.path(), directory.path()).expect("image store");
        (
            AppState::new(
                store,
                images,
                AppSettings::default(),
                directory.path().join("webview"),
                directory.path().join("cache"),
            ),
            directory,
        )
    }

    #[test]
    fn stale_surface_actions_are_discarded_after_a_new_user_intent() {
        let (state, _directory) = state();
        let first = state.begin_surface_action();
        let second = state.begin_surface_action();

        assert_eq!(
            state.with_current_surface_action(first, || Ok::<_, String>("stale")),
            Ok(None)
        );
        assert_eq!(
            state.with_current_surface_action(second, || Ok::<_, String>("current")),
            Ok(Some("current"))
        );
    }

    #[test]
    fn reference_stream_generation_invalidates_cancelled_and_replaced_requests() {
        let (state, _directory) = state();
        let first = state.begin_reference_vision_stream();
        assert!(state.reference_vision_stream_current(first));
        state.cancel_reference_vision_stream();
        assert!(!state.reference_vision_stream_current(first));

        let second = state.begin_reference_vision_stream();
        assert_ne!(first, second);
        assert!(state.reference_vision_stream_current(second));
        assert!(!state.reference_vision_stream_current(first));
    }

    #[test]
    fn generation_transition_wakes_only_the_invalidated_signal() {
        let (state, _directory) = state();
        let first = state.begin_reference_vision_stream();
        let first_signal = state.reference_vision_signal(first).expect("first signal");
        let second = state.begin_reference_vision_stream();
        let second_signal = state
            .reference_vision_signal(second)
            .expect("second signal");
        assert!(first_signal.is_cancelled());
        assert!(!second_signal.is_cancelled());
        state.cancel_reference_vision_stream();
        assert!(second_signal.is_cancelled());
        assert!(!state.reference_vision_stream_current(second));
    }
}
