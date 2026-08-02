use keyring::Entry;
use std::collections::HashMap;

const SERVICE: &str = "com.wainia.screenpilot";

pub struct CredentialVault;

const MAX_PROVIDER_KEY_BATCH: usize = 64;
const MAX_PROVIDER_KEYS: usize = 64;
const MAX_PROVIDER_KEY_LENGTH: usize = 16 * 1024;
const ADAPTER_CREDENTIAL_IDS: [&str; 4] = [
    "adapter-baidu-ocr",
    "adapter-baidu-translation",
    "adapter-tencent-translation",
    "adapter-caiyun-translation",
];

impl CredentialVault {
    pub fn set_provider_keys(provider_id: &str, keys: &[String]) -> Result<(), String> {
        let entry = Self::entry(provider_id)?;
        let filtered = keys
            .iter()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if filtered.is_empty() {
            return entry
                .delete_credential()
                .or_else(|error| {
                    if matches!(error, keyring::Error::NoEntry) {
                        Ok(())
                    } else {
                        Err(error)
                    }
                })
                .map_err(|error| error.to_string());
        }
        let json = serde_json::to_string(&filtered).map_err(|error| error.to_string())?;
        entry.set_password(&json).map_err(|error| error.to_string())
    }

    pub fn provider_keys(provider_id: &str) -> Result<Vec<String>, String> {
        let entry = Self::entry(provider_id)?;
        match entry.get_password() {
            Ok(value) => serde_json::from_str(&value).map_err(|error| error.to_string()),
            Err(keyring::Error::NoEntry) => Ok(Vec::new()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn provider_key_count(provider_id: &str) -> Result<usize, String> {
        Self::provider_keys(provider_id).map(|keys| keys.len())
    }

    pub fn delete_provider_keys(provider_id: &str) -> Result<(), String> {
        Self::entry(provider_id)?
            .delete_credential()
            .or_else(|error| {
                if matches!(error, keyring::Error::NoEntry) {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|error| error.to_string())
    }

    pub fn set_provider_keys_batch(changes: &HashMap<String, Vec<String>>) -> Result<(), String> {
        set_provider_keys_batch_with(changes, Self::provider_keys, |provider_id, keys| {
            Self::set_provider_keys(provider_id, keys)
        })
    }

    fn entry(provider_id: &str) -> Result<Entry, String> {
        if provider_id.is_empty()
            || provider_id.len() > 80
            || !provider_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err("Provider id is not safe for credential storage".into());
        }
        Entry::new(SERVICE, &format!("provider-{provider_id}")).map_err(|error| error.to_string())
    }
}

fn validate_provider_key_batch_shape(changes: &HashMap<String, Vec<String>>) -> Result<(), String> {
    if changes.len() > MAX_PROVIDER_KEY_BATCH {
        return Err(format!(
            "Provider key batch exceeds {MAX_PROVIDER_KEY_BATCH} providers"
        ));
    }
    for (provider_id, keys) in changes {
        if ADAPTER_CREDENTIAL_IDS.contains(&provider_id.as_str()) {
            return Err("Provider key batch cannot modify adapter credentials".into());
        }
        if provider_id.is_empty()
            || provider_id.len() > 80
            || !provider_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err("Provider id is not safe for credential storage".into());
        }
        let non_empty = keys.iter().filter(|key| !key.trim().is_empty()).count();
        if non_empty > MAX_PROVIDER_KEYS {
            return Err(format!(
                "Provider key batch exceeds {MAX_PROVIDER_KEYS} keys"
            ));
        }
        if keys.iter().any(|key| key.len() > MAX_PROVIDER_KEY_LENGTH) {
            return Err(format!(
                "Provider key exceeds {MAX_PROVIDER_KEY_LENGTH} bytes"
            ));
        }
    }
    Ok(())
}

fn redact_provider_key_values(message: &str, changes: &HashMap<String, Vec<String>>) -> String {
    changes.values().fold(message.to_string(), |current, keys| {
        keys.iter()
            .filter(|key| !key.is_empty())
            .fold(current, |text, key| text.replace(key, "***"))
    })
}

fn set_provider_keys_batch_with<R, W>(
    changes: &HashMap<String, Vec<String>>,
    mut read: R,
    mut write: W,
) -> Result<(), String>
where
    R: FnMut(&str) -> Result<Vec<String>, String>,
    W: FnMut(&str, &[String]) -> Result<(), String>,
{
    validate_provider_key_batch_shape(changes)?;
    let mut provider_ids = changes.keys().collect::<Vec<_>>();
    provider_ids.sort_unstable();
    let mut previous = HashMap::with_capacity(provider_ids.len());
    for provider_id in &provider_ids {
        previous.insert((*provider_id).clone(), read(provider_id)?);
    }
    let mut touched = Vec::with_capacity(provider_ids.len());
    for provider_id in provider_ids {
        touched.push(provider_id.clone());
        let keys = changes
            .get(provider_id)
            .ok_or_else(|| "Provider credentials batch changed during validation".to_string())?;
        if let Err(error) = write(provider_id, keys) {
            let rollback_errors = touched
                .iter()
                .rev()
                .filter_map(|id| {
                    previous
                        .get(id)
                        .and_then(|keys| write(id, keys).err())
                        .map(|rollback_error| {
                            format!(
                                "{id}: {}",
                                redact_provider_key_values(&rollback_error, changes)
                            )
                        })
                })
                .collect::<Vec<_>>();
            let failure = redact_provider_key_values(&error, changes);
            if rollback_errors.is_empty() {
                return Err(format!("Provider credentials save failed: {failure}"));
            }
            return Err(format!(
                "Provider credentials save failed: {failure}; rollback failed: {}",
                rollback_errors.join("; ")
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn rejects_unsafe_credential_identifiers() {
        assert!(CredentialVault::entry("../shared").is_err());
        assert!(CredentialVault::entry("provider:other").is_err());
        assert!(CredentialVault::entry("safe_provider-2").is_ok());
    }

    #[test]
    fn batch_saves_all_providers() {
        let store = Arc::new(Mutex::new(HashMap::from([
            (String::from("a"), vec![String::from("old-a")]),
            (String::from("b"), vec![String::from("old-b")]),
        ])));
        let changes = HashMap::from([
            (String::from("a"), vec![String::from("new-a")]),
            (String::from("b"), vec![String::from("new-b")]),
        ]);
        let read_store = Arc::clone(&store);
        let write_store = Arc::clone(&store);
        set_provider_keys_batch_with(
            &changes,
            move |provider_id| {
                Ok(read_store
                    .lock()
                    .expect("store lock")
                    .get(provider_id)
                    .cloned()
                    .unwrap_or_default())
            },
            move |provider_id, keys| {
                write_store
                    .lock()
                    .expect("store lock")
                    .insert(provider_id.into(), keys.to_vec());
                Ok(())
            },
        )
        .expect("batch succeeds");
        assert_eq!(
            *store.lock().expect("store lock"),
            HashMap::from([
                (String::from("a"), vec![String::from("new-a")]),
                (String::from("b"), vec![String::from("new-b")]),
            ])
        );
    }

    #[test]
    fn batch_rolls_back_when_a_write_fails() {
        let store = Arc::new(Mutex::new(HashMap::from([
            (String::from("a"), vec![String::from("old-a")]),
            (String::from("b"), vec![String::from("old-b")]),
        ])));
        let failed = Arc::new(Mutex::new(false));
        let changes = HashMap::from([
            (String::from("a"), vec![String::from("new-a")]),
            (String::from("b"), vec![String::from("new-b")]),
        ]);
        let read_store = Arc::clone(&store);
        let write_store = Arc::clone(&store);
        let write_failed = Arc::clone(&failed);
        let result = set_provider_keys_batch_with(
            &changes,
            move |provider_id| {
                Ok(read_store
                    .lock()
                    .expect("store lock")
                    .get(provider_id)
                    .cloned()
                    .unwrap_or_default())
            },
            move |provider_id, keys| {
                if provider_id == "b" {
                    let mut failed = write_failed.lock().expect("failure lock");
                    if !*failed {
                        *failed = true;
                        return Err("midway failure: new-b".into());
                    }
                }
                write_store
                    .lock()
                    .expect("store lock")
                    .insert(provider_id.into(), keys.to_vec());
                Ok(())
            },
        );
        assert_eq!(
            result,
            Err("Provider credentials save failed: midway failure: ***".into())
        );
        assert_eq!(
            *store.lock().expect("store lock"),
            HashMap::from([
                (String::from("a"), vec![String::from("old-a")]),
                (String::from("b"), vec![String::from("old-b")]),
            ])
        );
    }

    #[test]
    fn batch_reports_rollback_failures() {
        let store = Arc::new(Mutex::new(HashMap::from([
            (String::from("a"), vec![String::from("old-a")]),
            (String::from("b"), vec![String::from("old-b")]),
        ])));
        let changes = HashMap::from([
            (String::from("a"), vec![String::from("new-a")]),
            (String::from("b"), vec![String::from("new-b")]),
        ]);
        let write_count = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
        let read_store = Arc::clone(&store);
        let write_store = Arc::clone(&store);
        let counts = Arc::clone(&write_count);
        let result = set_provider_keys_batch_with(
            &changes,
            move |provider_id| {
                Ok(read_store
                    .lock()
                    .expect("store lock")
                    .get(provider_id)
                    .cloned()
                    .unwrap_or_default())
            },
            move |provider_id, keys| {
                let mut counts = counts.lock().expect("count lock");
                let count = counts.entry(provider_id.into()).or_default();
                *count += 1;
                if provider_id == "b" && *count == 1 {
                    return Err("midway failure".into());
                }
                if provider_id == "a" && keys == [String::from("old-a")] {
                    return Err("rollback unavailable".into());
                }
                write_store
                    .lock()
                    .expect("store lock")
                    .insert(provider_id.into(), keys.to_vec());
                Ok(())
            },
        );
        assert_eq!(
            result,
            Err("Provider credentials save failed: midway failure; rollback failed: a: rollback unavailable".into())
        );
        assert_eq!(
            store.lock().expect("store lock").get("a"),
            Some(&vec![String::from("new-a")])
        );
    }

    #[test]
    fn batch_validation_happens_before_reads_or_writes() {
        let reads = Arc::new(Mutex::new(0));
        let writes = Arc::new(Mutex::new(0));
        let read_count = Arc::clone(&reads);
        let write_count = Arc::clone(&writes);
        let changes = HashMap::from([(String::from("../unsafe"), Vec::new())]);
        let result = set_provider_keys_batch_with(
            &changes,
            move |_| {
                *read_count.lock().expect("read lock") += 1;
                Ok(Vec::new())
            },
            move |_, _| {
                *write_count.lock().expect("write lock") += 1;
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(*reads.lock().expect("read lock"), 0);
        assert_eq!(*writes.lock().expect("write lock"), 0);
    }

    #[test]
    fn batch_rejects_adapter_credentials() {
        let changes = HashMap::from([(
            String::from("adapter-baidu-ocr"),
            vec![String::from("secret")],
        )]);
        assert_eq!(
            validate_provider_key_batch_shape(&changes),
            Err("Provider key batch cannot modify adapter credentials".into())
        );
    }
}
