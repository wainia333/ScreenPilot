use super::AppSettings;

pub trait SettingsEffects {
    fn apply_startup(&mut self, settings: &AppSettings) -> Result<(), String>;
    fn replace_runtime(&mut self, settings: &AppSettings) -> Result<(), String>;
    fn register_shortcuts(
        &mut self,
        previous: &AppSettings,
        next: &AppSettings,
    ) -> Result<(), String>;
    fn persist(&mut self, settings: &AppSettings) -> Result<(), String>;
    fn update_tray(&mut self, settings: &AppSettings) -> Result<(), String>;
}

pub fn save_transaction<E: SettingsEffects>(
    effects: &mut E,
    previous: &AppSettings,
    next: &AppSettings,
) -> Result<(), String> {
    next.validate()?;
    let result = effects
        .apply_startup(next)
        .and_then(|()| effects.replace_runtime(next))
        .and_then(|()| effects.register_shortcuts(previous, next))
        .and_then(|()| effects.persist(next))
        .and_then(|()| effects.update_tray(next));
    if let Err(error) = result {
        let rollback_errors = [
            effects.apply_startup(previous),
            effects.replace_runtime(previous),
            effects.register_shortcuts(next, previous),
            effects.persist(previous),
            effects.update_tray(previous),
        ]
        .into_iter()
        .filter_map(Result::err)
        .collect::<Vec<_>>();
        if rollback_errors.is_empty() {
            return Err(error);
        }
        return Err(format!(
            "{error}; rollback failed: {}",
            rollback_errors.join("; ")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::settings::InterfaceLanguage;

    #[derive(Default)]
    struct FakeEffects {
        fail_at: Option<&'static str>,
        calls: Vec<String>,
        tray_languages: Vec<InterfaceLanguage>,
    }

    impl FakeEffects {
        fn record(&mut self, name: &'static str, settings: &AppSettings) -> Result<(), String> {
            self.calls
                .push(format!("{name}:{}", settings.retry.attempts));
            if self.fail_at == Some(name) && settings.retry.attempts == 4 {
                return Err(format!("{name} failed"));
            }
            Ok(())
        }
    }

    impl SettingsEffects for FakeEffects {
        fn apply_startup(&mut self, settings: &AppSettings) -> Result<(), String> {
            self.record("startup", settings)
        }

        fn replace_runtime(&mut self, settings: &AppSettings) -> Result<(), String> {
            self.record("runtime", settings)
        }

        fn register_shortcuts(
            &mut self,
            _previous: &AppSettings,
            next: &AppSettings,
        ) -> Result<(), String> {
            self.record("shortcuts", next)
        }

        fn persist(&mut self, settings: &AppSettings) -> Result<(), String> {
            self.record("persist", settings)
        }

        fn update_tray(&mut self, settings: &AppSettings) -> Result<(), String> {
            self.tray_languages.push(settings.language);
            self.record("tray", settings)
        }
    }

    #[test]
    fn rolls_back_every_effect_after_each_failure_stage() {
        for stage in ["startup", "runtime", "shortcuts", "persist", "tray"] {
            let previous = AppSettings::default();
            let mut next = previous.clone();
            next.retry.attempts = 4;
            let mut effects = FakeEffects {
                fail_at: Some(stage),
                calls: Vec::new(),
                tray_languages: Vec::new(),
            };
            assert_eq!(
                save_transaction(&mut effects, &previous, &next).unwrap_err(),
                format!("{stage} failed")
            );
            assert!(effects.calls.ends_with(&[
                "startup:3".into(),
                "runtime:3".into(),
                "shortcuts:3".into(),
                "persist:3".into(),
                "tray:3".into(),
            ]));
        }
    }

    #[test]
    fn saves_the_new_interface_language_before_rebuilding_the_tray() {
        let previous = AppSettings::default();
        let mut next = previous.clone();
        next.language = InterfaceLanguage::En;
        let mut effects = FakeEffects::default();

        save_transaction(&mut effects, &previous, &next).expect("language save succeeds");

        assert_eq!(effects.tray_languages, vec![InterfaceLanguage::En]);
    }
}
