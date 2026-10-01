use keyring::Entry;
use std::collections::{HashMap, HashSet};

const SERVICE: &str = "com.wainia.screenpilot";

pub struct CredentialVault;

const MAX_PROVIDER_KEY_BATCH: usize = 64;
const MAX_PROVIDER_KEYS: usize = 64;
const MAX_PROVIDER_KEY_LENGTH: usize = 16 * 1024;
pub const ADAPTER_CREDENTIAL_SPECS: [(&str, usize); 4] = [
    ("adapter-baidu-ocr", 2),
    ("adapter-baidu-translation", 2),
    ("adapter-tencent-translation", 2),
    ("adapter-caiyun-translation", 1),
];

impl CredentialVault {
    pub fn integration_key() -> Result<Option<String>, String> {
        match Entry::new(SERVICE, "integration-karakeep")
            .map_err(|_| "无法访问集成凭据库")?
            .get_password()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("无法读取集成凭据库".into()),
        }
    }
    pub fn set_integration_key(value: Option<&str>) -> Result<(), String> {
        let entry =
            Entry::new(SERVICE, "integration-karakeep").map_err(|_| "无法访问集成凭据库")?;
        if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
            if value.len() > 16384 {
                return Err("集成密钥超过长度限制".into());
            }
            entry
                .set_password(value.trim())
                .map_err(|_| "无法保存集成密钥".into())
        } else {
            entry
                .delete_credential()
                .or_else(|e| {
                    if matches!(e, keyring::Error::NoEntry) {
                        Ok(())
                    } else {
                        Err(e)
                    }
                })
                .map_err(|_| "无法删除集成密钥".into())
        }
    }
    pub fn integration_keys_for_export() -> Result<HashMap<String, Vec<String>>, String> {
        Ok(Self::integration_key()?
            .map(|key| HashMap::from([("karakeep".into(), vec![key])]))
            .unwrap_or_default())
    }
    pub fn import_all_secrets(
        providers: &HashMap<String, Vec<String>>,
        adapters: &HashMap<String, Vec<String>>,
        integrations: &HashMap<String, Vec<String>>,
        deletions: &[String],
    ) -> Result<(), String> {
        validate_integration_secrets(integrations)?;
        let mut changes = imported_provider_changes(providers, deletions)?;
        validate_adapter_key_batch_shape(adapters)?;
        changes.extend(adapters.clone());
        if let Some(keys) = integrations.get("karakeep") {
            changes.insert("integration-karakeep".into(), keys.clone());
        }
        set_keys_batch_transaction_with(
            &changes,
            &mut |id| {
                if id == "integration-karakeep" {
                    Ok(Self::integration_key()?.into_iter().collect())
                } else {
                    Self::provider_keys(id)
                }
            },
            &mut |id, keys| {
                if id == "integration-karakeep" {
                    Self::set_integration_key(keys.first().map(String::as_str))
                } else {
                    Self::write_provider_keys(id, keys)
                }
            },
        )
    }
    pub fn set_provider_keys(provider_id: &str, keys: &[String]) -> Result<(), String> {
        if let Some(expected_count) = adapter_credential_field_count(provider_id) {
            validate_adapter_key_entry(provider_id, keys, expected_count)?;
        }
        Self::write_provider_keys(provider_id, keys)
    }

    fn write_provider_keys(provider_id: &str, keys: &[String]) -> Result<(), String> {
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
            Self::write_provider_keys(provider_id, keys)
        })
    }

    pub fn adapter_keys_for_export() -> Result<HashMap<String, Vec<String>>, String> {
        let mut values = HashMap::new();
        for (adapter_id, expected_count) in ADAPTER_CREDENTIAL_SPECS {
            let keys = Self::provider_keys(adapter_id)?;
            if keys.is_empty() {
                continue;
            }
            validate_adapter_key_entry(adapter_id, &keys, expected_count)?;
            values.insert(adapter_id.into(), keys);
        }
        Ok(values)
    }

    pub fn set_adapter_keys_batch(changes: &HashMap<String, Vec<String>>) -> Result<(), String> {
        set_adapter_keys_batch_with(changes, Self::provider_keys, |adapter_id, keys| {
            Self::write_provider_keys(adapter_id, keys)
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

pub(crate) fn validate_provider_key_batch_shape(
    changes: &HashMap<String, Vec<String>>,
) -> Result<(), String> {
    if changes.len() > MAX_PROVIDER_KEY_BATCH {
        return Err(format!(
            "Provider key batch exceeds {MAX_PROVIDER_KEY_BATCH} providers"
        ));
    }
    for (provider_id, keys) in changes {
        if adapter_credential_field_count(provider_id).is_some()
            || provider_id.starts_with("integration-")
        {
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

pub fn validate_integration_secrets(values: &HashMap<String, Vec<String>>) -> Result<(), String> {
    if values.iter().any(|(id, keys)| {
        id != "karakeep" || keys.len() != 1 || keys[0].trim().is_empty() || keys[0].len() > 16384
    }) {
        Err("集成凭据格式无效".into())
    } else {
        Ok(())
    }
}

pub(crate) fn validate_imported_provider_key_batch_shape(
    changes: &HashMap<String, Vec<String>>,
) -> Result<(), String> {
    validate_provider_key_batch_shape(changes)?;
    if changes
        .values()
        .any(|keys| keys.is_empty() || keys.iter().any(|key| key.trim().is_empty()))
    {
        return Err("Imported provider credentials must contain only non-empty keys".into());
    }
    Ok(())
}

pub(crate) fn validate_imported_provider_deletions(
    providers: &HashMap<String, Vec<String>>,
    provider_deletion_ids: &[String],
) -> Result<(), String> {
    imported_provider_changes(providers, provider_deletion_ids).map(|_| ())
}

pub fn validate_adapter_key_batch_shape(
    changes: &HashMap<String, Vec<String>>,
) -> Result<(), String> {
    if changes.len() > ADAPTER_CREDENTIAL_SPECS.len() {
        return Err(format!(
            "Adapter credential batch exceeds {} adapters",
            ADAPTER_CREDENTIAL_SPECS.len()
        ));
    }
    for (adapter_id, keys) in changes {
        let expected_count = adapter_credential_field_count(adapter_id)
            .ok_or("Adapter credential id is unsupported")?;
        // An empty entry is the batch transaction's explicit delete marker.
        // Partial non-empty entries remain invalid so a clear cannot silently
        // replace a configured adapter with incomplete credentials.
        if keys.is_empty() {
            continue;
        }
        validate_adapter_key_entry(adapter_id, keys, expected_count)?;
    }
    Ok(())
}

fn adapter_credential_field_count(adapter_id: &str) -> Option<usize> {
    ADAPTER_CREDENTIAL_SPECS
        .iter()
        .find_map(|(id, count)| (*id == adapter_id).then_some(*count))
}

fn validate_adapter_key_entry(
    adapter_id: &str,
    keys: &[String],
    expected_count: usize,
) -> Result<(), String> {
    if keys.len() != expected_count || keys.iter().any(|key| key.trim().is_empty()) {
        return Err(format!(
            "Adapter {adapter_id} requires exactly {expected_count} non-empty credential fields"
        ));
    }
    if keys.iter().any(|key| key.len() > MAX_PROVIDER_KEY_LENGTH) {
        return Err(format!(
            "Adapter credential exceeds {MAX_PROVIDER_KEY_LENGTH} bytes"
        ));
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
    set_keys_batch_transaction_with(changes, &mut read, &mut write)
}

fn set_adapter_keys_batch_with<R, W>(
    changes: &HashMap<String, Vec<String>>,
    mut read: R,
    mut write: W,
) -> Result<(), String>
where
    R: FnMut(&str) -> Result<Vec<String>, String>,
    W: FnMut(&str, &[String]) -> Result<(), String>,
{
    validate_adapter_key_batch_shape(changes)?;
    set_keys_batch_transaction_with(changes, &mut read, &mut write)
}

#[cfg(test)]
fn set_imported_secrets_batch_with<R, W>(
    providers: &HashMap<String, Vec<String>>,
    adapters: &HashMap<String, Vec<String>>,
    provider_deletion_ids: &[String],
    mut read: R,
    mut write: W,
) -> Result<(), String>
where
    R: FnMut(&str) -> Result<Vec<String>, String>,
    W: FnMut(&str, &[String]) -> Result<(), String>,
{
    let mut changes = imported_provider_changes(providers, provider_deletion_ids)?;
    validate_adapter_key_batch_shape(adapters)?;
    changes.extend(adapters.clone());
    set_keys_batch_transaction_with(&changes, &mut read, &mut write)
}

fn imported_provider_changes(
    providers: &HashMap<String, Vec<String>>,
    provider_deletion_ids: &[String],
) -> Result<HashMap<String, Vec<String>>, String> {
    validate_imported_provider_key_batch_shape(providers)?;
    let mut deletion_ids = HashSet::with_capacity(provider_deletion_ids.len());
    let mut changes = providers.clone();
    for provider_id in provider_deletion_ids {
        if !deletion_ids.insert(provider_id.as_str()) {
            return Err("Provider deletion ids must be unique".into());
        }
        if providers.contains_key(provider_id) {
            return Err(
                "Provider credentials cannot be imported and deleted in the same batch".into(),
            );
        }
        changes.insert(provider_id.clone(), Vec::new());
    }
    validate_provider_key_batch_shape(&changes)?;
    Ok(changes)
}

fn set_keys_batch_transaction_with<R, W>(
    changes: &HashMap<String, Vec<String>>,
    read: &mut R,
    write: &mut W,
) -> Result<(), String>
where
    R: FnMut(&str) -> Result<Vec<String>, String>,
    W: FnMut(&str, &[String]) -> Result<(), String>,
{
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
    fn single_adapter_write_cannot_delete_or_partially_replace_credentials() {
        assert_eq!(
            CredentialVault::set_provider_keys("adapter-baidu-ocr", &[]),
            Err("Adapter adapter-baidu-ocr requires exactly 2 non-empty credential fields".into())
        );
        assert_eq!(
            CredentialVault::set_provider_keys(
                "adapter-baidu-ocr",
                &[String::from("api-key"), String::new()]
            ),
            Err("Adapter adapter-baidu-ocr requires exactly 2 non-empty credential fields".into())
        );
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

    #[test]
    fn adapter_batch_validates_shape_before_accessing_the_vault() {
        let reads = Arc::new(Mutex::new(0));
        let writes = Arc::new(Mutex::new(0));
        let read_count = Arc::clone(&reads);
        let write_count = Arc::clone(&writes);
        let changes = HashMap::from([(
            String::from("adapter-baidu-translation"),
            vec![String::from("app-id")],
        )]);

        let result = set_adapter_keys_batch_with(
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

        assert_eq!(
            result,
            Err(
                "Adapter adapter-baidu-translation requires exactly 2 non-empty credential fields"
                    .into()
            )
        );
        assert_eq!(*reads.lock().expect("read lock"), 0);
        assert_eq!(*writes.lock().expect("write lock"), 0);
    }

    #[test]
    fn adapter_batch_accepts_an_empty_entry_as_an_explicit_delete() {
        let store = Arc::new(Mutex::new(HashMap::from([(
            String::from("adapter-baidu-ocr"),
            vec![String::from("old-api"), String::from("old-secret")],
        )])));
        let changes = HashMap::from([(String::from("adapter-baidu-ocr"), Vec::new())]);
        let read_store = Arc::clone(&store);
        let write_store = Arc::clone(&store);

        set_adapter_keys_batch_with(
            &changes,
            move |adapter_id| {
                Ok(read_store
                    .lock()
                    .expect("store lock")
                    .get(adapter_id)
                    .cloned()
                    .unwrap_or_default())
            },
            move |adapter_id, keys| {
                let mut store = write_store.lock().expect("store lock");
                if keys.is_empty() {
                    store.remove(adapter_id);
                } else {
                    store.insert(adapter_id.into(), keys.to_vec());
                }
                Ok(())
            },
        )
        .expect("explicit adapter delete succeeds");

        assert!(store
            .lock()
            .expect("store lock")
            .get("adapter-baidu-ocr")
            .is_none());
    }

    #[test]
    fn adapter_batch_rolls_back_all_touched_adapters_on_failure() {
        let store = Arc::new(Mutex::new(HashMap::from([
            (
                String::from("adapter-baidu-translation"),
                vec![String::from("old-app"), String::from("old-baidu-secret")],
            ),
            (
                String::from("adapter-caiyun-translation"),
                vec![String::from("old-token")],
            ),
        ])));
        let failed = Arc::new(Mutex::new(false));
        let changes = HashMap::from([
            (
                String::from("adapter-baidu-translation"),
                vec![String::from("new-app"), String::from("new-baidu-secret")],
            ),
            (
                String::from("adapter-caiyun-translation"),
                vec![String::from("new-token")],
            ),
        ]);
        let read_store = Arc::clone(&store);
        let write_store = Arc::clone(&store);
        let write_failed = Arc::clone(&failed);

        let result = set_adapter_keys_batch_with(
            &changes,
            move |adapter_id| {
                Ok(read_store
                    .lock()
                    .expect("store lock")
                    .get(adapter_id)
                    .cloned()
                    .unwrap_or_default())
            },
            move |adapter_id, keys| {
                if adapter_id == "adapter-caiyun-translation" {
                    let mut failed = write_failed.lock().expect("failure lock");
                    if !*failed {
                        *failed = true;
                        return Err("adapter write failed for new-token".into());
                    }
                }
                write_store
                    .lock()
                    .expect("store lock")
                    .insert(adapter_id.into(), keys.to_vec());
                Ok(())
            },
        );

        assert_eq!(
            result,
            Err("Provider credentials save failed: adapter write failed for ***".into())
        );
        assert_eq!(
            *store.lock().expect("store lock"),
            HashMap::from([
                (
                    String::from("adapter-baidu-translation"),
                    vec![String::from("old-app"), String::from("old-baidu-secret")],
                ),
                (
                    String::from("adapter-caiyun-translation"),
                    vec![String::from("old-token")],
                ),
            ])
        );
    }

    #[test]
    fn imported_provider_and_adapter_secrets_share_one_rollback_boundary() {
        let store = Arc::new(Mutex::new(HashMap::from([
            (
                String::from("provider-a"),
                vec![String::from("old-provider")],
            ),
            (
                String::from("adapter-caiyun-translation"),
                vec![String::from("old-token")],
            ),
        ])));
        let providers = HashMap::from([(
            String::from("provider-a"),
            vec![String::from("new-provider")],
        )]);
        let adapters = HashMap::from([(
            String::from("adapter-caiyun-translation"),
            vec![String::from("new-token")],
        )]);
        let failed = Arc::new(Mutex::new(false));
        let read_store = Arc::clone(&store);
        let write_store = Arc::clone(&store);
        let write_failed = Arc::clone(&failed);

        let result = set_imported_secrets_batch_with(
            &providers,
            &adapters,
            &[],
            move |credential_id| {
                Ok(read_store
                    .lock()
                    .expect("store lock")
                    .get(credential_id)
                    .cloned()
                    .unwrap_or_default())
            },
            move |credential_id, keys| {
                if credential_id == "provider-a" {
                    let mut failed = write_failed.lock().expect("failure lock");
                    if !*failed {
                        *failed = true;
                        return Err("provider write failed for new-provider".into());
                    }
                }
                write_store
                    .lock()
                    .expect("store lock")
                    .insert(credential_id.into(), keys.to_vec());
                Ok(())
            },
        );

        assert_eq!(
            result,
            Err("Provider credentials save failed: provider write failed for ***".into())
        );
        assert_eq!(
            *store.lock().expect("store lock"),
            HashMap::from([
                (
                    String::from("provider-a"),
                    vec![String::from("old-provider")]
                ),
                (
                    String::from("adapter-caiyun-translation"),
                    vec![String::from("old-token")],
                ),
            ])
        );
    }

    #[test]
    fn imported_secrets_delete_removed_provider_credentials() {
        let store = Arc::new(Mutex::new(HashMap::from([(
            String::from("removed-provider"),
            vec![String::from("old-secret")],
        )])));
        let providers = HashMap::new();
        let adapters = HashMap::new();
        let provider_deletion_ids = vec![String::from("removed-provider")];
        let read_store = Arc::clone(&store);
        let write_store = Arc::clone(&store);

        set_imported_secrets_batch_with(
            &providers,
            &adapters,
            &provider_deletion_ids,
            move |credential_id| {
                Ok(read_store
                    .lock()
                    .expect("store lock")
                    .get(credential_id)
                    .cloned()
                    .unwrap_or_default())
            },
            move |credential_id, keys| {
                let mut store = write_store.lock().expect("store lock");
                if keys.is_empty() {
                    store.remove(credential_id);
                } else {
                    store.insert(credential_id.into(), keys.to_vec());
                }
                Ok(())
            },
        )
        .expect("imported secret deletion succeeds");

        assert!(!store
            .lock()
            .expect("store lock")
            .contains_key("removed-provider"));
    }

    #[test]
    fn imported_secret_deletion_validation_rejects_unsafe_ambiguous_ids() {
        let providers =
            HashMap::from([(String::from("provider-a"), vec![String::from("new-secret")])]);

        assert_eq!(
            validate_imported_provider_deletions(&providers, &[String::from("provider-a")]),
            Err("Provider credentials cannot be imported and deleted in the same batch".into())
        );
        assert_eq!(
            validate_imported_provider_deletions(
                &HashMap::new(),
                &[String::from("duplicate"), String::from("duplicate")]
            ),
            Err("Provider deletion ids must be unique".into())
        );
        assert_eq!(
            validate_imported_provider_deletions(
                &HashMap::new(),
                &[String::from("adapter-caiyun-translation")]
            ),
            Err("Provider key batch cannot modify adapter credentials".into())
        );
        assert_eq!(
            validate_imported_provider_deletions(&HashMap::new(), &[String::from("../unsafe")]),
            Err("Provider id is not safe for credential storage".into())
        );
    }

    #[test]
    fn imported_secret_deletion_rolls_back_when_a_later_adapter_write_fails() {
        let store = Arc::new(Mutex::new(HashMap::from([
            (
                String::from("0-removed-provider"),
                vec![String::from("old-provider-secret")],
            ),
            (
                String::from("adapter-caiyun-translation"),
                vec![String::from("old-token")],
            ),
        ])));
        let providers = HashMap::new();
        let adapters = HashMap::from([(
            String::from("adapter-caiyun-translation"),
            vec![String::from("new-token")],
        )]);
        let provider_deletion_ids = vec![String::from("0-removed-provider")];
        let failed = Arc::new(Mutex::new(false));
        let read_store = Arc::clone(&store);
        let write_store = Arc::clone(&store);
        let write_failed = Arc::clone(&failed);

        let result = set_imported_secrets_batch_with(
            &providers,
            &adapters,
            &provider_deletion_ids,
            move |credential_id| {
                Ok(read_store
                    .lock()
                    .expect("store lock")
                    .get(credential_id)
                    .cloned()
                    .unwrap_or_default())
            },
            move |credential_id, keys| {
                if credential_id == "adapter-caiyun-translation" {
                    let mut failed = write_failed.lock().expect("failure lock");
                    if !*failed {
                        *failed = true;
                        return Err("adapter write failed for new-token".into());
                    }
                }
                let mut store = write_store.lock().expect("store lock");
                if keys.is_empty() {
                    store.remove(credential_id);
                } else {
                    store.insert(credential_id.into(), keys.to_vec());
                }
                Ok(())
            },
        );

        assert_eq!(
            result,
            Err("Provider credentials save failed: adapter write failed for ***".into())
        );
        assert_eq!(
            *store.lock().expect("store lock"),
            HashMap::from([
                (
                    String::from("0-removed-provider"),
                    vec![String::from("old-provider-secret")],
                ),
                (
                    String::from("adapter-caiyun-translation"),
                    vec![String::from("old-token")],
                ),
            ])
        );
    }
}
