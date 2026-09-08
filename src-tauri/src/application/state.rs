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
    pub vision_busy: AtomicBool,
    pub ocr_busy: AtomicBool,
    vision_surface_generation: AtomicU64,
    ocr_surface_generation: AtomicU64,
    reference_vision: Mutex<ReferenceVisionState>,
    reference_ocr: Mutex<ReferenceVisionState>,
    translator_request: Mutex<TranslatorRequestState>,
    optimizer_request: Mutex<TranslatorRequestState>,
    reference_vision_images: Mutex<ReferenceVisionImages>,
    reference_ocr_images: Mutex<ReferenceVisionImages>,
    surface_generation: AtomicU64,
    reference_intent_generation: AtomicU64,
    surface_transition: Mutex<()>,
    selection_capture: Mutex<()>,
    settings_write: Mutex<()>,
    translator_selection: Mutex<String>,
    vision_selection: Mutex<String>,
    startup_notice: Mutex<Option<String>>,
    native_freeze_owner: Mutex<Option<ReferenceSurface>>,
    suspended_reference_surface: Mutex<Option<ReferenceSurface>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReferenceSurface {
    Vision,
    Ocr,
}

impl ReferenceSurface {
    pub fn for_mode(mode: &str) -> Self {
        if mode == "translate" {
            Self::Ocr
        } else {
            Self::Vision
        }
    }
    pub fn for_window(label: &str) -> Self {
        if label == "ocr" {
            Self::Ocr
        } else {
            Self::Vision
        }
    }
    pub fn peer(self) -> Self {
        match self {
            Self::Vision => Self::Ocr,
            Self::Ocr => Self::Vision,
        }
    }

    pub fn window_label(self) -> &'static str {
        match self {
            Self::Vision => "vision",
            Self::Ocr => "ocr",
        }
    }
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
    capture_ready: bool,
    temporary_ids: HashSet<String>,
}

impl AppState {
    pub fn new(
        store: SettingsStore,
        images: ImageStore,
        settings: AppSettings,
        webview_data_directory: PathBuf,
        _cache_directory: PathBuf,
    ) -> Self {
        Self {
            settings: RwLock::new(settings),
            store,
            images,
            webview_data_directory,
            vision_busy: AtomicBool::new(false),
            ocr_busy: AtomicBool::new(false),
            vision_surface_generation: AtomicU64::new(0),
            ocr_surface_generation: AtomicU64::new(0),
            reference_vision: Mutex::new(ReferenceVisionState {
                generation: 0,
                cancelled: false,
                signal: Arc::new(CancellationSignal::new()),
            }),
            reference_ocr: Mutex::new(ReferenceVisionState {
                generation: 0,
                cancelled: false,
                signal: Arc::new(CancellationSignal::new()),
            }),
            translator_request: Mutex::new(TranslatorRequestState {
                generation: 0,
                cancelled: false,
                signal: Arc::new(CancellationSignal::new()),
            }),
            reference_ocr_images: Mutex::new(ReferenceVisionImages {
                generation: 0,
                active: false,
                capture_ready: false,
                temporary_ids: HashSet::new(),
            }),
            optimizer_request: Mutex::new(TranslatorRequestState {
                generation: 0,
                cancelled: false,
                signal: Arc::new(CancellationSignal::new()),
            }),
            reference_vision_images: Mutex::new(ReferenceVisionImages {
                generation: 0,
                active: false,
                capture_ready: false,
                temporary_ids: HashSet::new(),
            }),
            surface_generation: AtomicU64::new(0),
            reference_intent_generation: AtomicU64::new(0),
            surface_transition: Mutex::new(()),
            selection_capture: Mutex::new(()),
            settings_write: Mutex::new(()),
            translator_selection: Mutex::new(String::new()),
            vision_selection: Mutex::new(String::new()),
            startup_notice: Mutex::new(None),
            native_freeze_owner: Mutex::new(None),
            suspended_reference_surface: Mutex::new(None),
        }
    }

    pub fn reference_surface_can_open(&self, surface: ReferenceSurface) -> bool {
        !self.reference_surface_active(surface.peer())
            || self.reference_capture_ready(surface.peer())
    }

    pub fn begin_reference_surface_action(&self, surface: ReferenceSurface) -> Option<u64> {
        self.reference_surface_can_open(surface)
            .then(|| self.begin_surface_action())
    }

    pub fn accept_reference_surface_action(
        &self,
        surface: ReferenceSurface,
        generation: u64,
    ) -> bool {
        if !self.surface_action_is_current(generation) {
            return false;
        }
        self.reference_intent_generation
            .store(generation, Ordering::SeqCst);
        self.reference_surface_can_open(surface)
    }

    pub fn begin_vision_surface_action(&self, mode: &str) -> Option<u64> {
        self.begin_reference_surface_action(ReferenceSurface::for_mode(mode))
    }

    #[cfg(test)]
    pub fn begin_vision(&self, surface_generation: u64) -> bool {
        self.begin_reference_surface(ReferenceSurface::Vision, surface_generation)
    }

    #[cfg(test)]
    pub fn release_vision(&self) {
        self.release_reference_surface(ReferenceSurface::Vision);
    }

    pub fn vision_active(&self) -> bool {
        self.vision_busy.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub fn vision_surface_generation(&self) -> Option<u64> {
        self.reference_surface_generation(ReferenceSurface::Vision)
    }

    pub fn reference_surface_generation(&self, surface: ReferenceSurface) -> Option<u64> {
        let generation = self.surface_generation_for(surface).load(Ordering::SeqCst);
        (generation != 0).then_some(generation)
    }

    fn surface_generation_for(&self, surface: ReferenceSurface) -> &AtomicU64 {
        match surface {
            ReferenceSurface::Vision => &self.vision_surface_generation,
            ReferenceSurface::Ocr => &self.ocr_surface_generation,
        }
    }

    fn busy_for(&self, surface: ReferenceSurface) -> &AtomicBool {
        match surface {
            ReferenceSurface::Vision => &self.vision_busy,
            ReferenceSurface::Ocr => &self.ocr_busy,
        }
    }

    fn stream_for(&self, surface: ReferenceSurface) -> &Mutex<ReferenceVisionState> {
        match surface {
            ReferenceSurface::Vision => &self.reference_vision,
            ReferenceSurface::Ocr => &self.reference_ocr,
        }
    }

    fn images_for(&self, surface: ReferenceSurface) -> &Mutex<ReferenceVisionImages> {
        match surface {
            ReferenceSurface::Vision => &self.reference_vision_images,
            ReferenceSurface::Ocr => &self.reference_ocr_images,
        }
    }

    pub fn begin_reference_surface(&self, surface: ReferenceSurface, generation: u64) -> bool {
        self.reference_intent_generation
            .store(generation, Ordering::SeqCst);
        let already_active = self.busy_for(surface).swap(true, Ordering::SeqCst);
        self.surface_generation_for(surface)
            .store(generation, Ordering::SeqCst);
        already_active
    }

    pub fn release_reference_surface(&self, surface: ReferenceSurface) {
        self.surface_generation_for(surface)
            .store(0, Ordering::SeqCst);
        self.busy_for(surface).store(false, Ordering::SeqCst);
    }

    pub fn reference_surface_active(&self, surface: ReferenceSurface) -> bool {
        self.busy_for(surface).load(Ordering::SeqCst)
    }

    pub fn reference_surface_action_is_current(
        &self,
        surface: ReferenceSurface,
        generation: u64,
    ) -> bool {
        self.reference_surface_generation(surface) == Some(generation)
            && self
                .surface_action_is_current(self.reference_intent_generation.load(Ordering::SeqCst))
    }

    pub fn with_current_reference_surface<T>(
        &self,
        surface: ReferenceSurface,
        generation: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        if !self.reference_surface_action_is_current(surface, generation) {
            return Ok(None);
        }
        let _guard = self
            .surface_transition
            .lock()
            .map_err(|_| "Surface transition state is unavailable".to_string())?;
        if !self.reference_surface_action_is_current(surface, generation) {
            return Ok(None);
        }
        action().map(Some)
    }

    pub fn claim_native_freeze(&self, surface: ReferenceSurface) {
        *self
            .native_freeze_owner
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(surface);
    }

    pub fn owns_native_freeze(&self, surface: ReferenceSurface) -> bool {
        *self
            .native_freeze_owner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            == Some(surface)
    }

    pub fn release_native_freeze(&self, surface: ReferenceSurface) -> bool {
        let mut owner = self
            .native_freeze_owner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *owner != Some(surface) {
            return false;
        }
        *owner = None;
        true
    }

    pub fn suspend_reference_surface(&self, surface: ReferenceSurface) {
        *self
            .suspended_reference_surface
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(surface);
    }

    pub fn take_suspended_reference_surface(
        &self,
        capturing: ReferenceSurface,
    ) -> Option<ReferenceSurface> {
        let mut suspended = self
            .suspended_reference_surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *suspended == Some(capturing.peer()) {
            suspended.take()
        } else {
            None
        }
    }

    #[cfg(test)]
    pub fn begin_reference_vision_stream(&self) -> u64 {
        self.begin_reference_stream(ReferenceSurface::Vision)
    }

    pub fn begin_active_reference_stream(&self, surface: ReferenceSurface) -> Result<u64, String> {
        let session = self
            .images_for(surface)
            .lock()
            .map_err(|_| "Image session is unavailable".to_string())?;
        if !session.active {
            return Err("Reference window is no longer active".into());
        }
        Ok(self.begin_reference_stream(surface))
    }

    pub fn begin_reference_stream(&self, surface: ReferenceSurface) -> u64 {
        let Ok(mut state) = self.stream_for(surface).lock() else {
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
        self.cancel_reference_stream(ReferenceSurface::Vision);
    }

    pub fn cancel_reference_stream(&self, surface: ReferenceSurface) {
        if let Ok(mut state) = self.stream_for(surface).lock() {
            state.generation = state.generation.wrapping_add(1).max(1);
            state.cancelled = true;
            state.signal.cancel();
        }
    }

    pub fn cancel_reference_stream_for_surface(
        &self,
        surface: ReferenceSurface,
        surface_generation: u64,
    ) -> bool {
        let Ok(mut state) = self.stream_for(surface).lock() else {
            return false;
        };
        if !self.surface_action_is_current(surface_generation) {
            return false;
        }
        state.generation = state.generation.wrapping_add(1).max(1);
        state.cancelled = true;
        state.signal.cancel();
        true
    }

    pub fn with_current_selection_capture<T>(
        &self,
        surface_generation: u64,
        capture: impl FnOnce() -> T,
    ) -> Result<Option<T>, String> {
        self.with_current_selection_capture_for_surface(
            ReferenceSurface::Vision,
            surface_generation,
            capture,
        )
    }

    pub fn with_current_selection_capture_for_surface<T>(
        &self,
        surface: ReferenceSurface,
        surface_generation: u64,
        capture: impl FnOnce() -> T,
    ) -> Result<Option<T>, String> {
        let _guard = self
            .selection_capture
            .lock()
            .map_err(|_| "Selection capture state is unavailable".to_string())?;
        if !self.cancel_reference_stream_for_surface(surface, surface_generation) {
            return Ok(None);
        }
        self.cancel_reference_stream(surface.peer());
        Ok(Some(capture()))
    }

    pub fn reference_vision_signal(&self, generation: u64) -> Option<Arc<CancellationSignal>> {
        self.reference_signal(ReferenceSurface::Vision, generation)
    }

    pub fn reference_signal(
        &self,
        surface: ReferenceSurface,
        generation: u64,
    ) -> Option<Arc<CancellationSignal>> {
        let state = self.stream_for(surface).lock().ok()?;
        (state.generation == generation && !state.cancelled).then(|| Arc::clone(&state.signal))
    }

    #[allow(dead_code)]
    pub fn reference_vision_stream_cancelled(&self) -> bool {
        self.reference_stream_cancelled(ReferenceSurface::Vision)
    }

    pub fn reference_stream_cancelled(&self, surface: ReferenceSurface) -> bool {
        self.stream_for(surface)
            .lock()
            .map(|state| state.cancelled)
            .unwrap_or(true)
    }

    pub fn reference_vision_stream_current(&self, generation: u64) -> bool {
        self.reference_stream_current(ReferenceSurface::Vision, generation)
    }

    pub fn reference_stream_current(&self, surface: ReferenceSurface, generation: u64) -> bool {
        self.stream_for(surface)
            .lock()
            .map(|state| state.generation == generation && !state.cancelled)
            .unwrap_or(false)
    }

    #[cfg(test)]
    pub fn with_current_reference_vision_stream<T>(
        &self,
        generation: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        self.with_current_reference_stream(ReferenceSurface::Vision, generation, action)
    }

    pub fn with_current_reference_stream<T>(
        &self,
        surface: ReferenceSurface,
        generation: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        let state = self
            .stream_for(surface)
            .lock()
            .map_err(|_| "Reference Vision stream state is unavailable".to_string())?;
        if state.generation != generation || state.cancelled {
            return Ok(None);
        }
        action().map(Some)
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

    pub fn begin_optimizer_request(&self, generation: u64) -> Option<Arc<CancellationSignal>> {
        let mut state = self.optimizer_request.lock().ok()?;
        if generation <= state.generation {
            return None;
        }
        state.signal.cancel();
        state.generation = generation;
        state.cancelled = false;
        state.signal = Arc::new(CancellationSignal::new());
        Some(Arc::clone(&state.signal))
    }

    pub fn cancel_optimizer_request(&self, generation: u64) -> bool {
        let Ok(mut state) = self.optimizer_request.lock() else {
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

    pub fn cancel_active_optimizer_request(&self) {
        if let Ok(mut state) = self.optimizer_request.lock() {
            state.cancelled = true;
            state.signal.cancel();
        }
    }

    pub fn optimizer_request_current(&self, generation: u64) -> bool {
        self.optimizer_request
            .lock()
            .map(|state| state.generation == generation && !state.cancelled)
            .unwrap_or(false)
    }

    #[cfg(test)]
    pub fn begin_reference_vision_image_session(&self) -> Result<u64, String> {
        self.begin_reference_image_session(ReferenceSurface::Vision)
    }

    pub fn begin_reference_image_session(&self, surface: ReferenceSurface) -> Result<u64, String> {
        let mut session = self
            .images_for(surface)
            .lock()
            .map_err(|_| format!("{} image session is unavailable", surface.window_label()))?;
        session.generation = session.generation.wrapping_add(1).max(1);
        session.active = true;
        session.capture_ready = false;
        Ok(session.generation)
    }

    #[cfg(test)]
    pub fn reference_vision_capture_ready(&self) -> bool {
        self.reference_capture_ready(ReferenceSurface::Vision)
    }

    pub fn reference_capture_ready(&self, surface: ReferenceSurface) -> bool {
        self.images_for(surface)
            .lock()
            .map(|session| session.active && session.capture_ready)
            .unwrap_or(false)
    }

    #[cfg(test)]
    pub fn finish_reference_vision_capture(&self, generation: u64) -> bool {
        self.finish_reference_capture(ReferenceSurface::Vision, generation)
    }

    pub fn finish_reference_capture(&self, surface: ReferenceSurface, generation: u64) -> bool {
        let Ok(mut session) = self.images_for(surface).lock() else {
            return false;
        };
        if !session.active || session.generation != generation {
            return false;
        }
        session.capture_ready = true;
        true
    }

    #[cfg(test)]
    pub fn reference_vision_image_session(&self) -> Result<u64, String> {
        self.reference_image_session(ReferenceSurface::Vision)
    }

    pub fn reference_image_session(&self, surface: ReferenceSurface) -> Result<u64, String> {
        let session = self
            .images_for(surface)
            .lock()
            .map_err(|_| format!("{} image session is unavailable", surface.window_label()))?;
        if session.active {
            Ok(session.generation)
        } else {
            Err(format!(
                "{} surface is no longer active",
                surface.window_label()
            ))
        }
    }

    #[cfg(test)]
    pub fn register_reference_vision_temporary_image(
        &self,
        generation: u64,
        image_id: &str,
    ) -> Result<(), String> {
        self.register_reference_temporary_image(ReferenceSurface::Vision, generation, image_id)
    }

    pub fn register_reference_temporary_image(
        &self,
        surface: ReferenceSurface,
        generation: u64,
        image_id: &str,
    ) -> Result<(), String> {
        let mut session = self
            .images_for(surface)
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

    #[cfg(test)]
    pub fn commit_reference_vision_image(&self, image_id: &str) -> Result<(), String> {
        self.commit_reference_image(ReferenceSurface::Vision, image_id)
    }

    pub fn commit_reference_image(
        &self,
        surface: ReferenceSurface,
        image_id: &str,
    ) -> Result<(), String> {
        let mut session = self
            .images_for(surface)
            .lock()
            .map_err(|_| "Vision image session is unavailable".to_string())?;
        self.images.commit(image_id)?;
        session.temporary_ids.remove(image_id);
        Ok(())
    }

    pub fn delete_reference_temporary_image(
        &self,
        surface: ReferenceSurface,
        image_id: &str,
    ) -> Result<(), String> {
        let mut session = self
            .images_for(surface)
            .lock()
            .map_err(|_| "Vision image session is unavailable".to_string())?;
        self.images.delete_temporary(image_id)?;
        session.temporary_ids.remove(image_id);
        Ok(())
    }

    #[cfg(test)]
    pub fn close_reference_vision_image_session(&self) -> Result<Vec<String>, String> {
        self.close_reference_image_session(ReferenceSurface::Vision)
    }

    pub fn close_reference_image_session(
        &self,
        surface: ReferenceSurface,
    ) -> Result<Vec<String>, String> {
        let mut session = self
            .images_for(surface)
            .lock()
            .map_err(|_| "Vision image session is unavailable".to_string())?;
        session.generation = session.generation.wrapping_add(1).max(1);
        session.active = false;
        session.capture_ready = false;
        Ok(session.temporary_ids.iter().cloned().collect())
    }

    #[cfg(test)]
    pub fn cleanup_reference_vision_temporary_images(
        &self,
        image_ids: &[String],
    ) -> Result<(), String> {
        self.cleanup_reference_temporary_images(ReferenceSurface::Vision, image_ids)
    }

    pub fn cleanup_reference_temporary_images(
        &self,
        surface: ReferenceSurface,
        image_ids: &[String],
    ) -> Result<(), String> {
        let mut session = self
            .images_for(surface)
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
        // Stale window events must not wait behind a current transition. On
        // Windows that transition may be waiting for the main thread to build
        // a WebView, while the stale event itself is running on that thread.
        if !self.surface_action_is_current(generation) {
            return Ok(None);
        }
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
    use super::{AppState, ReferenceSurface};
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
    fn ocr_preserves_vision_stream_images_and_close_generation() {
        let (state, _directory) = state();
        let vision = ReferenceSurface::Vision;
        let ocr = ReferenceSurface::Ocr;
        let vision_generation = state.begin_vision_surface_action("chat").unwrap();
        state.begin_reference_surface(vision, vision_generation);
        let vision_images = state.begin_reference_image_session(vision).unwrap();
        let vision_stream = state.begin_reference_stream(vision);
        let signal = state.reference_signal(vision, vision_stream).unwrap();
        assert!(state.finish_reference_capture(vision, vision_images));
        let ocr_generation = state.begin_vision_surface_action("translate").unwrap();
        state.begin_reference_surface(ocr, ocr_generation);
        state.begin_reference_image_session(ocr).unwrap();
        let ocr_stream = state.begin_reference_stream(ocr);
        state.cancel_reference_stream(ocr);
        state.close_reference_image_session(ocr).unwrap();
        state.release_reference_surface(ocr);
        assert!(!state.reference_stream_current(ocr, ocr_stream));
        assert!(!signal.is_cancelled());
        assert!(state.reference_stream_current(vision, vision_stream));
        assert_eq!(state.reference_image_session(vision), Ok(vision_images));
        assert!(state.reference_capture_ready(vision));
        assert_eq!(
            state.with_current_reference_surface(vision, vision_generation, || Ok(true)),
            Ok(Some(true))
        );
        state.begin_surface_action();
        assert_eq!(
            state.with_current_reference_surface(vision, vision_generation, || Ok(true)),
            Ok(None)
        );
    }

    #[test]
    fn closing_vision_does_not_cancel_ocr_or_its_freeze_overlay() {
        let (state, _directory) = state();
        let vision_generation = state.begin_surface_action();
        state.begin_reference_surface(ReferenceSurface::Vision, vision_generation);
        let ocr_generation = state.begin_surface_action();
        state.begin_reference_surface(ReferenceSurface::Ocr, ocr_generation);
        let ocr_images = state
            .begin_reference_image_session(ReferenceSurface::Ocr)
            .unwrap();
        let ocr_stream = state.begin_reference_stream(ReferenceSurface::Ocr);
        state.claim_native_freeze(ReferenceSurface::Ocr);
        state.cancel_reference_stream(ReferenceSurface::Vision);
        state
            .close_reference_image_session(ReferenceSurface::Vision)
            .unwrap();
        state.release_reference_surface(ReferenceSurface::Vision);
        assert!(!state.release_native_freeze(ReferenceSurface::Vision));
        assert!(state.owns_native_freeze(ReferenceSurface::Ocr));
        assert!(state.reference_stream_current(ReferenceSurface::Ocr, ocr_stream));
        assert_eq!(
            state.reference_image_session(ReferenceSurface::Ocr),
            Ok(ocr_images)
        );
        assert!(state.reference_surface_action_is_current(ReferenceSurface::Ocr, ocr_generation));
        assert!(state.release_native_freeze(ReferenceSurface::Ocr));
        assert!(!state.release_native_freeze(ReferenceSurface::Ocr));
    }

    #[test]
    fn direct_text_flight_unlocks_ocr_without_a_registered_screenshot() {
        let (state, _directory) = state();
        let generation = state.begin_vision_surface_action("chat").unwrap();
        state.begin_reference_surface(ReferenceSurface::Vision, generation);
        let session = state
            .begin_reference_image_session(ReferenceSurface::Vision)
            .unwrap();
        assert_eq!(state.begin_vision_surface_action("translate"), None);
        assert!(state.finish_reference_capture(ReferenceSurface::Vision, session));
        assert!(state.begin_vision_surface_action("translate").is_some());
    }

    #[test]
    fn closing_ocr_only_cleans_its_images_and_rejects_queued_requests() {
        let (state, _directory) = state();
        let vision = ReferenceSurface::Vision;
        let ocr = ReferenceSurface::Ocr;
        let vision_session = state.begin_reference_image_session(vision).unwrap();
        let ocr_session = state.begin_reference_image_session(ocr).unwrap();
        let image = image::RgbaImage::new(2, 2);
        let vision_image = state.images.save_temporary(&image).unwrap();
        let ocr_image = state.images.save_temporary(&image).unwrap();
        state
            .register_reference_temporary_image(vision, vision_session, &vision_image)
            .unwrap();
        state
            .register_reference_temporary_image(ocr, ocr_session, &ocr_image)
            .unwrap();
        let vision_stream = state.begin_active_reference_stream(vision).unwrap();
        let cleanup = state.close_reference_image_session(ocr).unwrap();
        assert_eq!(cleanup, vec![ocr_image.clone()]);
        state
            .cleanup_reference_temporary_images(ocr, &cleanup)
            .unwrap();
        assert!(state.images.read_data_url(&vision_image).is_ok());
        assert!(state.images.read_data_url(&ocr_image).is_err());
        assert!(state.begin_active_reference_stream(ocr).is_err());
        assert!(state.reference_stream_current(vision, vision_stream));
    }

    #[test]
    fn suspended_window_is_restored_only_by_its_capturing_peer() {
        let (state, _directory) = state();
        state.suspend_reference_surface(ReferenceSurface::Vision);
        assert_eq!(
            state.take_suspended_reference_surface(ReferenceSurface::Vision),
            None
        );
        assert_eq!(
            state.take_suspended_reference_surface(ReferenceSurface::Ocr),
            Some(ReferenceSurface::Vision)
        );
        assert_eq!(
            state.take_suspended_reference_surface(ReferenceSurface::Ocr),
            None
        );
    }

    #[test]
    fn vision_is_blocked_while_ocr_is_selecting_or_flying() {
        let (state, _directory) = state();
        let generation = state.begin_vision_surface_action("translate").unwrap();
        state.begin_reference_surface(ReferenceSurface::Ocr, generation);
        let session = state
            .begin_reference_image_session(ReferenceSurface::Ocr)
            .unwrap();
        assert_eq!(state.begin_vision_surface_action("chat"), None);
        assert!(state.finish_reference_capture(ReferenceSurface::Ocr, session));
        assert!(state.begin_vision_surface_action("chat").is_some());
    }

    #[test]
    fn both_vision_entries_restore_after_each_ocr_cancel_stage() {
        for has_screenshot in [true, false] {
            for landed_before_cancel in [false, true] {
                let (state, _directory) = state();
                let vision_generation = state.begin_vision_surface_action("chat").unwrap();
                state.begin_reference_surface(ReferenceSurface::Vision, vision_generation);
                let vision_session = state
                    .begin_reference_image_session(ReferenceSurface::Vision)
                    .unwrap();
                if has_screenshot {
                    let image = image::RgbaImage::new(2, 2);
                    let image_id = state.images.save_temporary(&image).unwrap();
                    state
                        .register_reference_temporary_image(
                            ReferenceSurface::Vision,
                            vision_session,
                            &image_id,
                        )
                        .unwrap();
                }
                assert!(state.finish_reference_capture(ReferenceSurface::Vision, vision_session));

                let ocr_generation = state.begin_vision_surface_action("translate").unwrap();
                state.begin_reference_surface(ReferenceSurface::Ocr, ocr_generation);
                let ocr_session = state
                    .begin_reference_image_session(ReferenceSurface::Ocr)
                    .unwrap();
                let ocr_stream = state.begin_reference_stream(ReferenceSurface::Ocr);
                state.suspend_reference_surface(ReferenceSurface::Vision);
                if landed_before_cancel {
                    assert!(state.finish_reference_capture(ReferenceSurface::Ocr, ocr_session));
                    assert_eq!(
                        state.take_suspended_reference_surface(ReferenceSurface::Ocr),
                        Some(ReferenceSurface::Vision)
                    );
                }

                state.cancel_reference_stream(ReferenceSurface::Ocr);
                state
                    .close_reference_image_session(ReferenceSurface::Ocr)
                    .unwrap();
                state.release_reference_surface(ReferenceSurface::Ocr);
                assert_eq!(
                    state.take_suspended_reference_surface(ReferenceSurface::Ocr),
                    (!landed_before_cancel).then_some(ReferenceSurface::Vision)
                );

                assert!(state.reference_surface_active(ReferenceSurface::Vision));
                assert!(!state.reference_surface_active(ReferenceSurface::Ocr));
                assert!(!state.reference_stream_current(ReferenceSurface::Ocr, ocr_stream));
                assert_eq!(
                    state.with_current_reference_surface(
                        ReferenceSurface::Vision,
                        vision_generation,
                        || {
                            state.close_reference_image_session(ReferenceSurface::Vision)?;
                            state.release_reference_surface(ReferenceSurface::Vision);
                            Ok(())
                        }
                    ),
                    Ok(Some(()))
                );
                assert!(!state.reference_surface_active(ReferenceSurface::Vision));
                assert!(!state.reference_surface_active(ReferenceSurface::Ocr));

                let reopened_generation = state.begin_vision_surface_action("chat").unwrap();
                state.begin_reference_surface(ReferenceSurface::Vision, reopened_generation);
                assert!(state.reference_surface_active(ReferenceSurface::Vision));
                state.release_reference_surface(ReferenceSurface::Vision);
            }
        }
    }

    #[test]
    fn queued_ocr_intent_cannot_cover_a_vision_capture_that_started_first() {
        let (state, _directory) = state();
        let vision_generation = state.begin_vision_surface_action("chat").unwrap();
        let queued_ocr = state.begin_vision_surface_action("translate").unwrap();
        state.begin_reference_surface(ReferenceSurface::Vision, vision_generation);
        state
            .begin_reference_image_session(ReferenceSurface::Vision)
            .unwrap();
        assert!(!state.accept_reference_surface_action(ReferenceSurface::Ocr, queued_ocr));
        assert!(!state.reference_surface_active(ReferenceSurface::Ocr));
        assert!(
            state.reference_surface_action_is_current(ReferenceSurface::Vision, vision_generation)
        );
        let newer = state.begin_surface_action();
        assert!(!state.accept_reference_surface_action(ReferenceSurface::Ocr, queued_ocr));
        assert!(state.surface_action_is_current(newer));
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
    fn cleanup_can_join_the_current_surface_generation_without_invalidating_it() {
        let (state, _directory) = state();
        let current = state.begin_surface_action();

        assert_eq!(
            state.with_current_surface_action(current, || Ok::<_, String>("closed")),
            Ok(Some("closed"))
        );
        assert_eq!(
            state.with_current_surface_action(current, || Ok::<_, String>("selection")),
            Ok(Some("selection"))
        );
    }

    #[test]
    fn cleanup_snapshot_is_rejected_after_a_new_surface_intent() {
        let (state, _directory) = state();
        let cleanup = state.begin_surface_action();
        let newer = state.begin_surface_action();
        let mut cleanup_ran = false;

        assert_eq!(
            state.with_current_surface_action(cleanup, || {
                cleanup_ran = true;
                Ok::<_, String>(())
            }),
            Ok(None)
        );
        assert!(!cleanup_ran);
        assert_eq!(
            state.with_current_surface_action(newer, || Ok::<_, String>("newer")),
            Ok(Some("newer"))
        );
    }

    #[test]
    fn ocr_shortcut_is_blocked_until_the_current_capture_has_landed() {
        let (state, _directory) = state();
        let vision_generation = state.begin_surface_action();
        state.begin_vision(vision_generation);
        assert_eq!(state.begin_vision_surface_action("translate"), None);
        assert!(state.surface_action_is_current(vision_generation));

        let image_session = state
            .begin_reference_vision_image_session()
            .expect("image session");
        assert_eq!(state.begin_vision_surface_action("translate"), None);
        assert!(state.surface_action_is_current(vision_generation));
        assert!(state.finish_reference_vision_capture(image_session));

        let ocr_generation = state
            .begin_vision_surface_action("translate")
            .expect("OCR intent");
        assert!(state.surface_action_is_current(ocr_generation));
        assert_ne!(ocr_generation, vision_generation);
    }

    #[test]
    fn a_late_flight_cannot_unlock_ocr_for_a_closed_or_replaced_capture() {
        let (state, _directory) = state();
        let first = state
            .begin_reference_vision_image_session()
            .expect("first image session");
        assert!(!state.reference_vision_capture_ready());
        assert!(state.finish_reference_vision_capture(first));
        assert!(state.reference_vision_capture_ready());

        state
            .close_reference_vision_image_session()
            .expect("close session");
        assert!(!state.finish_reference_vision_capture(first));
        assert!(!state.reference_vision_capture_ready());

        let next = state
            .begin_reference_vision_image_session()
            .expect("next image session");
        assert!(!state.finish_reference_vision_capture(first));
        assert!(!state.reference_vision_capture_ready());
        assert!(state.finish_reference_vision_capture(next));
        assert!(state.reference_vision_capture_ready());
    }

    #[test]
    fn vision_activity_tracks_open_and_close_transitions() {
        let (state, _directory) = state();
        let first_generation = state.begin_surface_action();
        assert!(!state.vision_active());
        assert!(!state.begin_vision(first_generation));
        assert!(state.vision_active());
        assert_eq!(state.vision_surface_generation(), Some(first_generation));

        let replacement_generation = state.begin_surface_action();
        assert!(state.begin_vision(replacement_generation));
        assert_eq!(
            state.vision_surface_generation(),
            Some(replacement_generation)
        );

        state.release_vision();
        assert!(!state.vision_active());
        assert_eq!(state.vision_surface_generation(), None);
    }

    #[test]
    fn repeated_vision_requests_keep_the_existing_session_closable() {
        let (state, _directory) = state();
        let first_generation = state.begin_surface_action();
        assert!(!state.begin_vision(first_generation));
        let stream_generation = state.begin_reference_vision_stream();
        let image_generation = state
            .begin_reference_vision_image_session()
            .expect("image session");

        for _ in 0..8 {
            let generation = state.begin_surface_action();
            assert_eq!(
                state.with_current_surface_action(generation, || {
                    Ok(state.begin_vision(generation))
                }),
                Ok(Some(true))
            );
            let cleanup_generation = state.vision_surface_generation().expect("vision token");
            assert!(state.surface_action_is_current(cleanup_generation));
            assert!(state.reference_vision_stream_current(stream_generation));
            assert_eq!(state.reference_vision_image_session(), Ok(image_generation));
        }

        let cleanup_generation = state.vision_surface_generation().expect("vision token");
        assert_eq!(
            state.with_current_surface_action(cleanup_generation, || {
                state.release_vision();
                Ok(())
            }),
            Ok(Some(()))
        );
        assert!(!state.vision_active());
        assert_eq!(state.vision_surface_generation(), None);

        let reopened_generation = state.begin_surface_action();
        assert!(!state.begin_vision(reopened_generation));
        assert_eq!(state.vision_surface_generation(), Some(reopened_generation));
    }

    #[test]
    fn vision_request_queued_during_open_transfers_cleanup_to_the_latest_intent() {
        let (state, _directory) = state();
        let first_generation = state.begin_surface_action();
        let queued_generation = state
            .with_current_surface_action(first_generation, || {
                let queued_generation = state.begin_surface_action();
                assert!(!state.begin_vision(first_generation));
                Ok(queued_generation)
            })
            .expect("initial open")
            .expect("accepted initial open");

        assert_eq!(
            state.with_current_surface_action(queued_generation, || {
                Ok(state.begin_vision(queued_generation))
            }),
            Ok(Some(true))
        );
        let cleanup_generation = state.vision_surface_generation().expect("vision token");
        assert_eq!(cleanup_generation, queued_generation);

        let translator_generation = state.begin_surface_action();
        assert_eq!(
            state.with_current_surface_action(cleanup_generation, || {
                state.release_vision();
                Ok(())
            }),
            Ok(None)
        );
        assert!(state.vision_active());
        assert!(state.surface_action_is_current(translator_generation));
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
    fn current_reference_stream_actions_run_while_stale_actions_are_skipped() {
        let (state, _directory) = state();
        let first = state.begin_reference_vision_stream();
        let second = state.begin_reference_vision_stream();
        let stale_ran = std::cell::Cell::new(false);

        assert_eq!(
            state.with_current_reference_vision_stream(first, || {
                stale_ran.set(true);
                Ok::<_, String>("stale")
            }),
            Ok(None)
        );
        assert!(!stale_ran.get());
        assert_eq!(
            state.with_current_reference_vision_stream(second, || { Ok::<_, String>("current") }),
            Ok(Some("current"))
        );
    }

    #[test]
    fn cancelling_a_reference_stream_fences_an_authorized_synchronous_action() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{mpsc, Arc};
        use std::thread;

        let (state, directory) = state();
        let state = Arc::new(state);
        let generation = state.begin_reference_vision_stream();
        let order = Arc::new(AtomicUsize::new(0));
        let (action_started_tx, action_started_rx) = mpsc::channel();
        let (release_action_tx, release_action_rx) = mpsc::channel();

        let action_state = Arc::clone(&state);
        let action_order = Arc::clone(&order);
        let action = thread::spawn(move || {
            action_state
                .with_current_reference_vision_stream(generation, || {
                    action_started_tx.send(()).expect("signal action start");
                    release_action_rx.recv().expect("release action");
                    action_order.store(1, Ordering::SeqCst);
                    Ok::<_, String>(())
                })
                .expect("authorized action")
        });
        action_started_rx.recv().expect("action started");

        let cancel_state = Arc::clone(&state);
        let cancel_order = Arc::clone(&order);
        let (cancel_started_tx, cancel_started_rx) = mpsc::channel();
        let cancel = thread::spawn(move || {
            cancel_started_tx.send(()).expect("signal cancel start");
            cancel_state.cancel_reference_vision_stream();
            cancel_order.store(2, Ordering::SeqCst);
        });
        cancel_started_rx.recv().expect("cancel started");
        release_action_tx
            .send(())
            .expect("release authorized action");

        assert_eq!(action.join().expect("action thread"), Some(()));
        cancel.join().expect("cancel thread");
        assert_eq!(order.load(Ordering::SeqCst), 2);
        assert!(!state.reference_vision_stream_current(generation));
        drop(directory);
    }

    #[test]
    fn queued_selection_captures_serialize_and_recheck_their_surface_ticket() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{mpsc, Arc};
        use std::thread;

        let (state, directory) = state();
        let state = Arc::new(state);
        let ticket = state.begin_surface_action();
        let (first_started_tx, first_started_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();

        let first_state = Arc::clone(&state);
        let first = thread::spawn(move || {
            first_state
                .with_current_selection_capture(ticket, || {
                    first_started_tx.send(()).expect("signal first capture");
                    release_first_rx.recv().expect("release first capture");
                    "first"
                })
                .expect("first capture")
        });
        first_started_rx.recv().expect("first capture started");

        let stale_capture_ran = Arc::new(AtomicBool::new(false));
        let second_state = Arc::clone(&state);
        let second_ran = Arc::clone(&stale_capture_ran);
        let (second_queued_tx, second_queued_rx) = mpsc::channel();
        let second = thread::spawn(move || {
            second_queued_tx.send(()).expect("signal queued capture");
            second_state
                .with_current_selection_capture(ticket, || {
                    second_ran.store(true, Ordering::SeqCst);
                    "stale"
                })
                .expect("queued capture")
        });
        second_queued_rx.recv().expect("second capture queued");

        let newer_ticket = state.begin_surface_action();
        release_first_tx.send(()).expect("release first capture");

        assert_eq!(first.join().expect("first capture thread"), Some("first"));
        assert_eq!(second.join().expect("second capture thread"), None);
        assert!(!stale_capture_ran.load(Ordering::SeqCst));
        assert!(state.surface_action_is_current(newer_ticket));
        drop(directory);
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
    fn optimizer_generation_cancels_replaced_requests_and_rejects_stale_commands() {
        let (state, _directory) = state();
        let first = state
            .begin_optimizer_request(10)
            .expect("first optimizer signal");
        assert!(state.optimizer_request_current(10));

        let second = state
            .begin_optimizer_request(11)
            .expect("second optimizer signal");
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(!state.optimizer_request_current(10));
        assert!(state.optimizer_request_current(11));

        assert!(state.cancel_optimizer_request(12));
        assert!(second.is_cancelled());
        assert!(!state.optimizer_request_current(11));
        assert!(state.begin_optimizer_request(12).is_none());
        assert!(!state.cancel_optimizer_request(9));
        assert!(state.begin_optimizer_request(13).is_some());
    }

    #[test]
    fn hiding_the_optimizer_cancels_without_consuming_the_next_frontend_token() {
        let (state, _directory) = state();
        let signal = state
            .begin_optimizer_request(100)
            .expect("active optimization");

        state.cancel_active_optimizer_request();
        assert!(signal.is_cancelled());
        assert!(!state.optimizer_request_current(100));
        assert!(state.begin_optimizer_request(101).is_some());
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
