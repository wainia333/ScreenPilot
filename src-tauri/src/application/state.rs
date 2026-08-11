use crate::domain::settings::AppSettings;
use crate::infrastructure::images::ImageStore;
use crate::infrastructure::settings_store::SettingsStore;
use std::collections::HashSet;
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
    translator_request: Mutex<TranslatorRequestState>,
    reference_vision_images: Mutex<ReferenceVisionImages>,
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

struct TranslatorRequestState {
    generation: u64,
    cancelled: bool,
    signal: Arc<CancellationSignal>,
}

struct ReferenceVisionImages {
    generation: u64,
    active: bool,
    temporary_ids: HashSet<String>,
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
            translator_request: Mutex::new(TranslatorRequestState {
                generation: 0,
                cancelled: false,
                signal: Arc::new(CancellationSignal::new()),
            }),
            reference_vision_images: Mutex::new(ReferenceVisionImages {
                generation: 0,
                active: false,
                temporary_ids: HashSet::new(),
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

    pub fn begin_translator_request(&self, generation: u64) -> Option<Arc<CancellationSignal>> {
        let mut state = self.translator_request.lock().ok()?;
        if generation <= state.generation {
            return None;
        }
        state.signal.cancel();
        state.generation = generation;
        state.cancelled = false;
        state.signal = Arc::new(CancellationSignal::new());
        Some(Arc::clone(&state.signal))
    }

    pub fn cancel_translator_request(&self, generation: u64) -> bool {
        let Ok(mut state) = self.translator_request.lock() else {
            return false;
        };
        if generation < state.generation {
            return false;
        }
        state.generation = generation;
        state.cancelled = true;
        state.signal.cancel();
        true
    }

    pub fn cancel_active_translator_request(&self) {
        if let Ok(mut state) = self.translator_request.lock() {
            state.cancelled = true;
            state.signal.cancel();
        }
    }

    pub fn translator_request_current(&self, generation: u64) -> bool {
        self.translator_request
            .lock()
            .map(|state| state.generation == generation && !state.cancelled)
            .unwrap_or(false)
    }

    pub fn begin_reference_vision_image_session(&self) -> Result<u64, String> {
        let mut session = self
            .reference_vision_images
            .lock()
            .map_err(|_| "Vision image session is unavailable".to_string())?;
        session.generation = session.generation.wrapping_add(1).max(1);
        session.active = true;
        Ok(session.generation)
    }

    pub fn reference_vision_image_session(&self) -> Result<u64, String> {
        let session = self
            .reference_vision_images
            .lock()
            .map_err(|_| "Vision image session is unavailable".to_string())?;
        if session.active {
            Ok(session.generation)
        } else {
            Err("Vision surface is no longer active".into())
        }
    }

    pub fn register_reference_vision_temporary_image(
        &self,
        generation: u64,
        image_id: &str,
    ) -> Result<(), String> {
        let mut session = self
            .reference_vision_images
            .lock()
            .map_err(|_| "Vision image session is unavailable".to_string())?;
        if session.active && session.generation == generation {
            session.temporary_ids.insert(image_id.to_owned());
            return Ok(());
        }
        self.images.delete_temporary(image_id).map_err(|error| {
            format!("Vision surface is no longer active; temporary image cleanup failed: {error}")
        })?;
        Err("Vision surface is no longer active".into())
    }

    pub fn commit_reference_vision_image(&self, image_id: &str) -> Result<(), String> {
        let mut session = self
            .reference_vision_images
            .lock()
            .map_err(|_| "Vision image session is unavailable".to_string())?;
        self.images.commit(image_id)?;
        session.temporary_ids.remove(image_id);
        Ok(())
    }

    pub fn delete_reference_vision_temporary_image(&self, image_id: &str) -> Result<(), String> {
        let mut session = self
            .reference_vision_images
            .lock()
            .map_err(|_| "Vision image session is unavailable".to_string())?;
        self.images.delete_temporary(image_id)?;
        session.temporary_ids.remove(image_id);
        Ok(())
    }

    pub fn close_reference_vision_image_session(&self) -> Result<Vec<String>, String> {
        let mut session = self
            .reference_vision_images
            .lock()
            .map_err(|_| "Vision image session is unavailable".to_string())?;
        session.generation = session.generation.wrapping_add(1).max(1);
        session.active = false;
        Ok(session.temporary_ids.iter().cloned().collect())
    }

    pub fn cleanup_reference_vision_temporary_images(
        &self,
        image_ids: &[String],
    ) -> Result<(), String> {
        let mut session = self
            .reference_vision_images
            .lock()
            .map_err(|_| "Vision image session is unavailable".to_string())?;
        let mut failures = Vec::new();
        for image_id in image_ids {
            if !session.temporary_ids.contains(image_id) {
                continue;
            }
            if let Err(error) = self.images.delete_temporary(image_id) {
                failures.push(format!("{image_id}: {error}"));
            } else {
                session.temporary_ids.remove(image_id);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Temporary Vision image cleanup failed for: {}",
                failures.join("; ")
            ))
        }
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

    pub fn startup_notice(&self) -> Option<String> {
        self.startup_notice
            .lock()
            .ok()
            .and_then(|notice| notice.clone())
    }

    pub fn acknowledge_startup_notice(&self) {
        if let Ok(mut notice) = self.startup_notice.lock() {
            *notice = None;
        }
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
    fn translator_generation_cancels_replaced_requests_and_rejects_stale_commands() {
        let (state, _directory) = state();
        let first = state
            .begin_translator_request(1)
            .expect("first translation signal");
        assert!(state.translator_request_current(1));

        let second = state
            .begin_translator_request(2)
            .expect("second translation signal");
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(!state.translator_request_current(1));
        assert!(state.translator_request_current(2));
        assert!(state.begin_translator_request(1).is_none());
        assert!(state.begin_translator_request(2).is_none());
    }

    #[test]
    fn explicit_translator_cancel_wakes_the_request_and_blocks_queued_stale_work() {
        let (state, _directory) = state();
        let signal = state
            .begin_translator_request(4)
            .expect("translation signal");

        assert!(state.cancel_translator_request(5));
        assert!(signal.is_cancelled());
        assert!(!state.translator_request_current(4));
        assert!(state.begin_translator_request(5).is_none());
        assert!(!state.cancel_translator_request(3));
        assert!(state.begin_translator_request(6).is_some());
    }

    #[test]
    fn a_recreated_translator_can_start_immediately_with_a_new_monotonic_token() {
        let (state, _directory) = state();
        let previous_window_token = 1_800_000_000_000_042;
        let previous = state
            .begin_translator_request(previous_window_token)
            .expect("previous window request");

        let recreated_window_token = previous_window_token + 1;
        assert!(state
            .begin_translator_request(recreated_window_token)
            .is_some());
        assert!(previous.is_cancelled());
        assert!(state.translator_request_current(recreated_window_token));
    }

    #[test]
    fn hiding_the_translator_cancels_without_consuming_the_next_frontend_token() {
        let (state, _directory) = state();
        let signal = state
            .begin_translator_request(100)
            .expect("active translation");

        state.cancel_active_translator_request();
        assert!(signal.is_cancelled());
        assert!(!state.translator_request_current(100));
        assert!(state.begin_translator_request(101).is_some());
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

    #[test]
    fn startup_notice_remains_available_until_explicitly_acknowledged() {
        let (state, _directory) = state();
        state.set_startup_notice("recovery notice".into());

        assert_eq!(state.startup_notice().as_deref(), Some("recovery notice"));
        assert_eq!(state.startup_notice().as_deref(), Some("recovery notice"));

        state.acknowledge_startup_notice();
        assert_eq!(state.startup_notice(), None);
        state.acknowledge_startup_notice();
        assert_eq!(state.startup_notice(), None);
    }

    #[test]
    fn vision_image_session_cleans_only_uncommitted_owned_images() {
        let (state, _directory) = state();
        let generation = state
            .begin_reference_vision_image_session()
            .expect("begin image session");
        let committed_id = state
            .images
            .save_temporary(&image::RgbaImage::new(2, 2))
            .expect("save committed image");
        let temporary_id = state
            .images
            .save_temporary(&image::RgbaImage::new(3, 3))
            .expect("save temporary image");
        state
            .register_reference_vision_temporary_image(generation, &committed_id)
            .expect("track committed image");
        state
            .register_reference_vision_temporary_image(generation, &temporary_id)
            .expect("track temporary image");
        state
            .commit_reference_vision_image(&committed_id)
            .expect("commit image");

        let cleanup = state
            .close_reference_vision_image_session()
            .expect("close image session");
        state
            .cleanup_reference_vision_temporary_images(&cleanup)
            .expect("cleanup closed image session");
        assert!(state.images.read_data_url(&committed_id).is_ok());
        assert_eq!(
            state.images.read_data_url(&temporary_id).unwrap_err(),
            "Image does not exist"
        );
    }

    #[test]
    fn late_capture_from_a_closed_session_is_deleted_instead_of_joining_a_new_session() {
        let (state, _directory) = state();
        let first = state
            .begin_reference_vision_image_session()
            .expect("begin first image session");
        let cleanup = state
            .close_reference_vision_image_session()
            .expect("close first image session");
        assert!(cleanup.is_empty());
        let second = state
            .begin_reference_vision_image_session()
            .expect("begin second image session");
        assert_ne!(first, second);
        let late_id = state
            .images
            .save_temporary(&image::RgbaImage::new(2, 2))
            .expect("save late image");

        assert_eq!(
            state.register_reference_vision_temporary_image(first, &late_id),
            Err("Vision surface is no longer active".into())
        );
        assert_eq!(
            state.images.read_data_url(&late_id).unwrap_err(),
            "Image does not exist"
        );
    }

    #[test]
    fn concurrent_commit_and_close_never_delete_a_successfully_committed_image() {
        use std::sync::{Arc, Barrier};

        let (state, _directory) = state();
        let state = Arc::new(state);
        let generation = state
            .begin_reference_vision_image_session()
            .expect("begin image session");
        let image_id = state
            .images
            .save_temporary(&image::RgbaImage::new(2, 2))
            .expect("save temporary image");
        state
            .register_reference_vision_temporary_image(generation, &image_id)
            .expect("track temporary image");
        let barrier = Arc::new(Barrier::new(3));

        let commit_state = Arc::clone(&state);
        let commit_barrier = Arc::clone(&barrier);
        let commit_id = image_id.clone();
        let commit = std::thread::spawn(move || {
            commit_barrier.wait();
            commit_state.commit_reference_vision_image(&commit_id)
        });
        let close_state = Arc::clone(&state);
        let close_barrier = Arc::clone(&barrier);
        let close = std::thread::spawn(move || {
            close_barrier.wait();
            close_state.close_reference_vision_image_session()
        });
        barrier.wait();

        let commit_result = commit.join().expect("commit thread");
        let cleanup = close
            .join()
            .expect("close thread")
            .expect("close image session");
        state
            .cleanup_reference_vision_temporary_images(&cleanup)
            .expect("cleanup closed image session");
        match commit_result {
            Ok(()) => assert!(state.images.read_data_url(&image_id).is_ok()),
            Err(_) => assert_eq!(
                state.images.read_data_url(&image_id).unwrap_err(),
                "Image does not exist"
            ),
        }
    }

    #[test]
    fn commit_during_the_closed_session_grace_period_wins_over_cleanup() {
        let (state, _directory) = state();
        let generation = state
            .begin_reference_vision_image_session()
            .expect("begin image session");
        let image_id = state
            .images
            .save_temporary(&image::RgbaImage::new(2, 2))
            .expect("save temporary image");
        state
            .register_reference_vision_temporary_image(generation, &image_id)
            .expect("track temporary image");

        let cleanup = state
            .close_reference_vision_image_session()
            .expect("close image session");
        assert!(state.images.read_data_url(&image_id).is_ok());
        state
            .commit_reference_vision_image(&image_id)
            .expect("late commit during grace period");
        state
            .cleanup_reference_vision_temporary_images(&cleanup)
            .expect("cleanup skips committed image");

        assert!(state.images.read_data_url(&image_id).is_ok());
    }
}
