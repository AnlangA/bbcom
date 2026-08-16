//! Durable native-only registry for unsigned plugin sources.

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bbcom_contracts::{PluginSourceHealth, PluginSourceKind, PluginSourceView};
use bbcom_plugin_contracts::{RepositoryConfiguration, RepositoryEndpoint, RepositoryIndex};
use bbcom_plugin_manager::ManualPackageRequest;
use bbcom_plugin_repository::{DownloadedPackage, RepositoryClient};
use serde::{Deserialize, Serialize};

use super::repository::NativeRepositoryFetchPort;

const REGISTRY_SCHEMA: u32 = 1;
const MAX_REGISTRY_BYTES: u64 = 8 * 1024 * 1024;
const AUTO_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceRegistryError {
    Invalid,
    Conflict,
    Missing,
    Io,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceRegistryFile {
    schema: u32,
    sources: Vec<SourceRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceRecord {
    source_id: String,
    kind: PersistedSourceKind,
    display_name: String,
    url: Option<String>,
    enabled: bool,
    watch_enabled: bool,
    health: PersistedSourceHealth,
    last_attempt_ms: Option<u64>,
    last_success_ms: Option<u64>,
    etag: Option<String>,
    last_modified: Option<String>,
    cached_index: Option<RepositoryIndex>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_path: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum PersistedSourceKind {
    Https,
    LocalPackage,
    DevDirectory,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum PersistedSourceHealth {
    Idle,
    Healthy,
    Error,
    Disconnected,
}

pub struct NativePluginSourceRegistry {
    path: PathBuf,
    file: Mutex<SourceRegistryFile>,
}

#[derive(Clone)]
pub(crate) struct WatchedDevDirectory {
    pub source_id: String,
    pub path: PathBuf,
}

impl NativePluginSourceRegistry {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, SourceRegistryError> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| SourceRegistryError::Io)?;
        }
        let file = load_registry(&path)?;
        validate_registry(&file)?;
        Ok(Self {
            path,
            file: Mutex::new(file),
        })
    }

    pub fn views(&self) -> Result<Vec<PluginSourceView>, SourceRegistryError> {
        let file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        Ok(file.sources.iter().map(source_view).collect())
    }

    pub fn indexes(&self) -> Result<Vec<(String, RepositoryIndex)>, SourceRegistryError> {
        let file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        Ok(file
            .sources
            .iter()
            .filter(|source| source.enabled)
            .filter_map(|source| {
                source
                    .cached_index
                    .clone()
                    .map(|index| (source.source_id.clone(), index))
            })
            .collect())
    }

    fn stale_https_source_ids(&self, now: u64) -> Result<Vec<String>, SourceRegistryError> {
        let file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        let max_age_ms = u64::try_from(AUTO_CHECK_INTERVAL.as_millis()).unwrap_or(u64::MAX);
        Ok(file
            .sources
            .iter()
            .filter(|source| source.enabled && matches!(source.kind, PersistedSourceKind::Https))
            .filter(|source| {
                source
                    .last_attempt_ms
                    .is_none_or(|attempt| now.saturating_sub(attempt) >= max_age_ms)
            })
            .map(|source| source.source_id.clone())
            .collect())
    }

    pub fn download_verified(
        &self,
        request: &ManualPackageRequest,
    ) -> Result<DownloadedPackage, SourceRegistryError> {
        let index = {
            let file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
            file.sources
                .iter()
                .find(|source| source.source_id == request.repository_id && source.enabled)
                .and_then(|source| source.cached_index.clone())
                .ok_or(SourceRegistryError::Missing)?
        };
        RepositoryClient::new(NativeRepositoryFetchPort::new())
            .download_package(&index, &request.plugin_id, &request.version)
            .map_err(|_| SourceRegistryError::Io)
    }

    pub fn add_https(
        &self,
        source_id: String,
        url: String,
        enabled: bool,
    ) -> Result<(), SourceRegistryError> {
        let endpoint = RepositoryEndpoint::new(source_id.clone(), url)
            .map_err(|_| SourceRegistryError::Invalid)?;
        let mut file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        if file.sources.iter().any(|source| {
            source.source_id == source_id
                || source.url.as_deref().is_some_and(|url| {
                    RepositoryEndpoint::new("origin-check", url.to_owned())
                        .is_ok_and(|existing| existing.origin() == endpoint.origin())
                })
        }) {
            return Err(SourceRegistryError::Conflict);
        }
        file.sources.push(SourceRecord {
            source_id,
            kind: PersistedSourceKind::Https,
            display_name: endpoint.origin().to_owned(),
            url: Some(endpoint.url().to_owned()),
            enabled,
            watch_enabled: false,
            health: PersistedSourceHealth::Idle,
            last_attempt_ms: None,
            last_success_ms: None,
            etag: None,
            last_modified: None,
            cached_index: None,
            native_path: None,
        });
        persist(&self.path, &file)
    }

    pub fn add_or_update_dev_directory(
        &self,
        plugin_id: &str,
        display_name: String,
        path: PathBuf,
    ) -> Result<(), SourceRegistryError> {
        let source_id = format!("dev-{plugin_id}");
        if plugin_id.is_empty()
            || plugin_id.len() > 128
            || display_name.is_empty()
            || display_name.len() > 128
            || !path.is_absolute()
        {
            return Err(SourceRegistryError::Invalid);
        }
        let mut file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        if let Some(source) = file
            .sources
            .iter_mut()
            .find(|source| source.source_id == source_id)
        {
            if !matches!(source.kind, PersistedSourceKind::DevDirectory) {
                return Err(SourceRegistryError::Conflict);
            }
            source.display_name = display_name;
            source.native_path = Some(path);
            source.health = PersistedSourceHealth::Healthy;
        } else {
            file.sources.push(SourceRecord {
                source_id,
                kind: PersistedSourceKind::DevDirectory,
                display_name,
                url: None,
                enabled: true,
                watch_enabled: false,
                health: PersistedSourceHealth::Healthy,
                last_attempt_ms: None,
                last_success_ms: Some(now_ms()),
                etag: None,
                last_modified: None,
                cached_index: None,
                native_path: Some(path),
            });
        }
        persist(&self.path, &file)
    }

    pub fn remove_dev_directory(&self, plugin_id: &str) -> Result<(), SourceRegistryError> {
        let source_id = format!("dev-{plugin_id}");
        let mut file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        file.sources.retain(|source| {
            source.source_id != source_id
                || !matches!(source.kind, PersistedSourceKind::DevDirectory)
        });
        persist(&self.path, &file)
    }

    pub(crate) fn watched_dev_directories(
        &self,
    ) -> Result<Vec<WatchedDevDirectory>, SourceRegistryError> {
        let file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        Ok(file
            .sources
            .iter()
            .filter(|source| {
                source.enabled
                    && source.watch_enabled
                    && matches!(source.kind, PersistedSourceKind::DevDirectory)
            })
            .filter_map(|source| {
                source.native_path.clone().map(|path| WatchedDevDirectory {
                    source_id: source.source_id.clone(),
                    path,
                })
            })
            .collect())
    }

    pub(crate) fn set_dev_health(
        &self,
        source_id: &str,
        healthy: bool,
    ) -> Result<(), SourceRegistryError> {
        let mut file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        let source = file
            .sources
            .iter_mut()
            .find(|source| source.source_id == source_id)
            .ok_or(SourceRegistryError::Missing)?;
        if !matches!(source.kind, PersistedSourceKind::DevDirectory) {
            return Err(SourceRegistryError::Invalid);
        }
        source.health = if healthy {
            PersistedSourceHealth::Healthy
        } else {
            PersistedSourceHealth::Disconnected
        };
        source.last_attempt_ms = Some(now_ms());
        if healthy {
            source.last_success_ms = Some(now_ms());
        }
        persist(&self.path, &file)
    }

    pub fn update_https(
        &self,
        source_id: &str,
        url: String,
        enabled: bool,
    ) -> Result<(), SourceRegistryError> {
        let endpoint = RepositoryEndpoint::new(source_id.to_owned(), url)
            .map_err(|_| SourceRegistryError::Invalid)?;
        let mut file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        if file.sources.iter().any(|source| {
            source.source_id != source_id
                && source.url.as_deref().is_some_and(|url| {
                    RepositoryEndpoint::new("origin-check", url.to_owned())
                        .is_ok_and(|existing| existing.origin() == endpoint.origin())
                })
        }) {
            return Err(SourceRegistryError::Conflict);
        }
        let source = file
            .sources
            .iter_mut()
            .find(|source| source.source_id == source_id)
            .ok_or(SourceRegistryError::Missing)?;
        if !matches!(source.kind, PersistedSourceKind::Https) {
            return Err(SourceRegistryError::Invalid);
        }
        let changed = source.url.as_deref() != Some(endpoint.url());
        source.url = Some(endpoint.url().to_owned());
        source.display_name = endpoint.origin().to_owned();
        source.enabled = enabled;
        if changed {
            source.cached_index = None;
            source.health = PersistedSourceHealth::Idle;
            source.etag = None;
            source.last_modified = None;
        }
        persist(&self.path, &file)
    }

    pub fn remove(&self, source_id: &str) -> Result<(), SourceRegistryError> {
        let mut file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        let before = file.sources.len();
        file.sources.retain(|source| source.source_id != source_id);
        if file.sources.len() == before {
            return Err(SourceRegistryError::Missing);
        }
        persist(&self.path, &file)
    }

    pub fn set_watch_enabled(
        &self,
        source_id: &str,
        enabled: bool,
    ) -> Result<(), SourceRegistryError> {
        let mut file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        let source = file
            .sources
            .iter_mut()
            .find(|source| source.source_id == source_id)
            .ok_or(SourceRegistryError::Missing)?;
        if !matches!(source.kind, PersistedSourceKind::DevDirectory) {
            return Err(SourceRegistryError::Invalid);
        }
        source.watch_enabled = enabled;
        persist(&self.path, &file)
    }

    /// Refreshes only the index and retains the last-known-good value on any
    /// network or validation failure. Package bytes are never downloaded.
    pub fn refresh(&self, source_id: &str) -> Result<(), SourceRegistryError> {
        let (url, enabled) = {
            let file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
            let source = file
                .sources
                .iter()
                .find(|source| source.source_id == source_id)
                .ok_or(SourceRegistryError::Missing)?;
            if !matches!(source.kind, PersistedSourceKind::Https) {
                return Err(SourceRegistryError::Invalid);
            }
            (
                source.url.clone().ok_or(SourceRegistryError::Invalid)?,
                source.enabled,
            )
        };
        let fetched = if enabled {
            RepositoryEndpoint::new(source_id.to_owned(), url)
                .map_err(|_| SourceRegistryError::Invalid)
                .and_then(|endpoint| {
                    RepositoryConfiguration::new(vec![endpoint])
                        .map_err(|_| SourceRegistryError::Invalid)
                })
                .and_then(|configuration| {
                    RepositoryClient::new(NativeRepositoryFetchPort::new())
                        .fetch_catalog(&configuration)
                        .map_err(|_| SourceRegistryError::Io)
                })
        } else {
            Err(SourceRegistryError::Invalid)
        };
        let now = now_ms();
        let mut file = self.file.lock().map_err(|_| SourceRegistryError::Io)?;
        let source = file
            .sources
            .iter_mut()
            .find(|source| source.source_id == source_id)
            .ok_or(SourceRegistryError::Missing)?;
        source.last_attempt_ms = Some(now);
        match fetched {
            Ok(catalog) => {
                source.cached_index = catalog.repositories.into_iter().next();
                source.last_success_ms = Some(now);
                source.health = PersistedSourceHealth::Healthy;
            }
            Err(_) => source.health = PersistedSourceHealth::Error,
        }
        persist(&self.path, &file)
    }
}

/// Checks enabled HTTPS indexes at most once per 24 hours. This task downloads
/// index metadata only; package download and installation remain command-only.
pub fn spawn_automatic_source_checks(registry: Arc<NativePluginSourceRegistry>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let source_ids = registry
                .stale_https_source_ids(now_ms())
                .unwrap_or_default();
            for source_id in source_ids {
                let source_registry = Arc::clone(&registry);
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    source_registry.refresh(&source_id)
                })
                .await;
            }
        }
    });
}

fn load_registry(path: &Path) -> Result<SourceRegistryFile, SourceRegistryError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SourceRegistryFile {
                schema: REGISTRY_SCHEMA,
                sources: Vec::new(),
            });
        }
        Err(_) => return Err(SourceRegistryError::Io),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_REGISTRY_BYTES
    {
        return Err(SourceRegistryError::Invalid);
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| SourceRegistryError::Io)?)
        .map_err(|_| SourceRegistryError::Invalid)
}

fn validate_registry(file: &SourceRegistryFile) -> Result<(), SourceRegistryError> {
    if file.schema != REGISTRY_SCHEMA {
        return Err(SourceRegistryError::Invalid);
    }
    let mut ids = BTreeSet::new();
    let mut origins = BTreeSet::new();
    for source in &file.sources {
        if !ids.insert(source.source_id.as_str()) {
            return Err(SourceRegistryError::Conflict);
        }
        if matches!(source.kind, PersistedSourceKind::Https) {
            let endpoint = RepositoryEndpoint::new(
                source.source_id.clone(),
                source.url.clone().ok_or(SourceRegistryError::Invalid)?,
            )
            .map_err(|_| SourceRegistryError::Invalid)?;
            if !origins.insert(endpoint.origin().to_owned()) || source.watch_enabled {
                return Err(SourceRegistryError::Conflict);
            }
            if let Some(index) = &source.cached_index {
                index.validate().map_err(|_| SourceRegistryError::Invalid)?;
                if index.origin != endpoint.origin() {
                    return Err(SourceRegistryError::Invalid);
                }
            }
        }
    }
    Ok(())
}

fn persist(path: &Path, file: &SourceRegistryFile) -> Result<(), SourceRegistryError> {
    validate_registry(file)?;
    let bytes = serde_json::to_vec_pretty(file).map_err(|_| SourceRegistryError::Io)?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err(SourceRegistryError::Invalid);
    }
    let parent = path.parent().ok_or(SourceRegistryError::Io)?;
    let temporary = parent.join(".plugin-sources-v2.json.part");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(&temporary)
        .map_err(|_| SourceRegistryError::Io)?;
    output
        .write_all(&bytes)
        .and_then(|_| output.sync_all())
        .map_err(|_| SourceRegistryError::Io)?;
    fs::rename(&temporary, path).map_err(|_| SourceRegistryError::Io)?;
    OpenOptions::new()
        .read(true)
        .open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| SourceRegistryError::Io)
}

fn source_view(source: &SourceRecord) -> PluginSourceView {
    PluginSourceView {
        source_id: source.source_id.clone(),
        kind: match source.kind {
            PersistedSourceKind::Https => PluginSourceKind::Https,
            PersistedSourceKind::LocalPackage => PluginSourceKind::LocalPackage,
            PersistedSourceKind::DevDirectory => PluginSourceKind::DevDirectory,
        },
        display_name: source.display_name.clone(),
        url: source.url.clone(),
        enabled: source.enabled,
        watch_enabled: source.watch_enabled,
        health: match source.health {
            PersistedSourceHealth::Idle => PluginSourceHealth::Idle,
            PersistedSourceHealth::Healthy => PluginSourceHealth::Healthy,
            PersistedSourceHealth::Error => PluginSourceHealth::Error,
            PersistedSourceHealth::Disconnected => PluginSourceHealth::Disconnected,
        },
        last_attempt_ms: source.last_attempt_ms,
        last_success_ms: source.last_success_ms,
        etag: source.etag.clone(),
        last_modified: source.last_modified.clone(),
    }
}

fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_persists_strict_https_sources_without_credentials() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("plugin-sources-v2.json");
        let registry = NativePluginSourceRegistry::open(&path).unwrap();
        registry
            .add_https(
                "example".to_owned(),
                "https://plugins.example.com/index.json".to_owned(),
                true,
            )
            .unwrap();
        assert_eq!(registry.views().unwrap().len(), 1);
        assert_eq!(
            registry.add_https(
                "bad".to_owned(),
                "https://user@plugins.example.com/index.json".to_owned(),
                true,
            ),
            Err(SourceRegistryError::Invalid)
        );
        assert_eq!(
            NativePluginSourceRegistry::open(path)
                .unwrap()
                .views()
                .unwrap()[0]
                .source_id,
            "example"
        );
    }
}
