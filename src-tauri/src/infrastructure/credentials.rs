use keyring::Entry;

const SERVICE: &str = "com.wainia.screenpilot";

pub struct CredentialVault;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_credential_identifiers() {
        assert!(CredentialVault::entry("../shared").is_err());
        assert!(CredentialVault::entry("provider:other").is_err());
        assert!(CredentialVault::entry("safe_provider-2").is_ok());
    }
}
