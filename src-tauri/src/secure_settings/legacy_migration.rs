//! Legacy plaintext JSON store migration helpers.
//!
//! The v0.5 security contract moved the AI API key from a plaintext
//! `secure-settings.json` in the app data directory into the OS keyring. These
//! helpers read that legacy file and erase only the API-key field, only after
//! an OS-durable write has been verified by the caller.

use std::fs;
use std::path::{Path, PathBuf};

pub(super) const LEGACY_AI_API_KEY_FIELD: &str = "ai-api-key";

pub(super) fn legacy_store_path_from_dir(app_data_dir: Option<PathBuf>) -> Option<PathBuf> {
    app_data_dir.map(|dir| dir.join("secure-settings.json"))
}

pub(super) fn read_legacy_store_value(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()?
        .get(LEGACY_AI_API_KEY_FIELD)?
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

/// Remove only the old API-key field after a verified OS-keyring migration.
/// Any unrelated legacy-store values are deliberately retained.
pub(super) fn remove_legacy_store_value(path: &Path) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if object.remove(LEGACY_AI_API_KEY_FIELD).is_none() {
        return;
    }
    let Ok(serialized) = serde_json::to_vec(&value) else {
        return;
    };
    let temporary = path.with_extension("json.bbcom-migrating");
    if fs::write(&temporary, serialized).is_ok() {
        let _ = fs::rename(temporary, path);
    }
}

#[cfg(test)]
pub(super) fn legacy_path(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "bbcom-secure-settings-{label}-{}-{nanos}.json",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_file_helpers_read_only_the_api_key_and_preserve_other_settings() {
        let path = legacy_path("helpers");
        fs::write(&path, r#"{"ai-api-key":"legacy-secret","theme":"dark"}"#).unwrap();
        assert_eq!(
            read_legacy_store_value(&path).as_deref(),
            Some("legacy-secret")
        );
        remove_legacy_store_value(&path);
        let remaining: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(remaining.get(LEGACY_AI_API_KEY_FIELD).is_none());
        assert_eq!(remaining["theme"], "dark");

        fs::write(&path, r#"{"ai-api-key":"   "}"#).unwrap();
        assert_eq!(read_legacy_store_value(&path), None);
        fs::write(&path, "not-json").unwrap();
        assert_eq!(read_legacy_store_value(&path), None);
        remove_legacy_store_value(&path);

        // Every malformed/irrelevant legacy shape is a no-op: migration must
        // never delete unrelated content while trying to erase one key.
        remove_legacy_store_value(&legacy_path("does-not-exist"));
        fs::write(&path, "[]").unwrap();
        remove_legacy_store_value(&path);
        assert_eq!(fs::read_to_string(&path).unwrap(), "[]");
        fs::write(&path, r#"{"other":"preserved"}"#).unwrap();
        remove_legacy_store_value(&path);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
            serde_json::json!({"other":"preserved"})
        );
        fs::remove_file(path).ok();
    }
}
