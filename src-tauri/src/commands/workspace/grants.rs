//! Short-lived source/target path grants for project import/export.
//!
//! The renderer can never hand Rust a native path: it only receives an
//! opaque grant id minted after a native file dialog confirms the user's
//! choice. Grants are single-use, kind-bound, and TTL-evicted.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::utils::window::require_main_window_label;
use bbcom_contracts::{
    AppErrorCode, IpcError, ProjectSourceGrantResponse, ProjectTargetGrantResponse,
    RequestProjectSourceGrantRequest, RequestProjectTargetGrantRequest,
};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::{
    WorkspaceManager, cancelled, io_failure, project_display_name, random_opaque_id,
    validate_opaque_id, validate_project_file_name, validate_project_path,
};

#[cfg(test)]
use super::temporary_root;

const PROJECT_GRANT_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PROJECT_GRANTS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProjectGrantKind {
    Source,
    Target,
}

#[derive(Debug)]
pub(super) struct ProjectGrant {
    kind: ProjectGrantKind,
    path: PathBuf,
    issued_at: Instant,
}

impl WorkspaceManager {
    async fn issue_grant(
        &self,
        kind: ProjectGrantKind,
        path: PathBuf,
        operation: &'static str,
    ) -> Result<String, IpcError> {
        let mut grants = self.grants.lock().await;
        grants.retain(|_, grant| grant.issued_at.elapsed() <= PROJECT_GRANT_TTL);
        if grants.len() >= MAX_PROJECT_GRANTS {
            return Err(IpcError::new(
                AppErrorCode::LimitExceeded,
                "error.limit_exceeded",
                false,
                operation,
            )
            .with_field("grantId")
            .with_size(MAX_PROJECT_GRANTS, grants.len().saturating_add(1)));
        }
        for _ in 0..4 {
            let grant_id = random_opaque_id("project-grant", operation)?;
            if grants.contains_key(&grant_id) {
                continue;
            }
            grants.insert(
                grant_id.clone(),
                ProjectGrant {
                    kind,
                    path: path.clone(),
                    issued_at: Instant::now(),
                },
            );
            return Ok(grant_id);
        }
        Err(IpcError::new(
            AppErrorCode::Busy,
            "error.busy",
            true,
            operation,
        ))
    }

    pub(super) async fn consume_grant(
        &self,
        grant_id: &str,
        expected_kind: ProjectGrantKind,
        operation: &'static str,
    ) -> Result<PathBuf, IpcError> {
        validate_opaque_id(grant_id, "grantId", operation)?;
        let mut grants = self.grants.lock().await;
        grants.retain(|_, grant| grant.issued_at.elapsed() <= PROJECT_GRANT_TTL);
        let grant = grants
            .remove(grant_id)
            .ok_or_else(|| IpcError::invalid_input(operation, "grantId"))?;
        if grant.kind != expected_kind {
            return Err(IpcError::security_denied(operation));
        }
        Ok(grant.path)
    }
}

#[tauri::command]
pub async fn request_project_source_grant(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: RequestProjectSourceGrantRequest,
) -> Result<ProjectSourceGrantResponse, IpcError> {
    const OPERATION: &str = "request_project_source_grant";
    require_main_window_label(window.label(), OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    // The native dialog blocks until the user chooses; keep it off the async
    // runtime workers (and the UI thread) on a blocking-pool thread.
    let selected = tauri::async_runtime::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .add_filter("bbcom project", &["bbcom"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| io_failure(OPERATION, true))?
    .ok_or_else(|| cancelled(OPERATION))?;
    let path = selected
        .into_path()
        .map_err(|_| IpcError::invalid_input(OPERATION, "source"))?;
    validate_project_path(&path, true, OPERATION)?;
    let display_name = project_display_name(&path, OPERATION)?;
    let source_grant_id = manager
        .issue_grant(ProjectGrantKind::Source, path, OPERATION)
        .await?;
    Ok(ProjectSourceGrantResponse {
        request_id: request.request_id,
        source_grant_id,
        display_name,
    })
}

#[tauri::command]
pub async fn request_project_target_grant(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: RequestProjectTargetGrantRequest,
) -> Result<ProjectTargetGrantResponse, IpcError> {
    const OPERATION: &str = "request_project_target_grant";
    require_main_window_label(window.label(), OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    validate_project_file_name(&request.suggested_name, OPERATION)?;
    let suggested_name = request.suggested_name.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .add_filter("bbcom project", &["bbcom"])
            .set_file_name(&suggested_name)
            .blocking_save_file()
    })
    .await
    .map_err(|_| io_failure(OPERATION, true))?
    .ok_or_else(|| cancelled(OPERATION))?;
    let mut path = selected
        .into_path()
        .map_err(|_| IpcError::invalid_input(OPERATION, "destination"))?;
    if path.extension().is_none() {
        path.set_extension("bbcom");
    }
    validate_project_path(&path, false, OPERATION)?;
    let display_name = project_display_name(&path, OPERATION)?;
    let target_grant_id = manager
        .issue_grant(ProjectGrantKind::Target, path, OPERATION)
        .await?;
    Ok(ProjectTargetGrantResponse {
        request_id: request.request_id,
        target_grant_id,
        display_name,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[tokio::test]
    async fn project_grants_are_kind_bound_single_use_and_capacity_limited() {
        let root = temporary_root("grant-lifecycle");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let source_path = root.join("source.bbcom");

        let wrong_kind = manager
            .issue_grant(ProjectGrantKind::Source, source_path.clone(), "test")
            .await
            .expect("issue source grant");
        let denied = manager
            .consume_grant(&wrong_kind, ProjectGrantKind::Target, "test")
            .await
            .unwrap_err();
        assert_eq!(denied.code, AppErrorCode::SecurityDenied);
        assert!(
            manager
                .consume_grant(&wrong_kind, ProjectGrantKind::Source, "test")
                .await
                .is_err(),
            "a kind mismatch must consume the capability"
        );

        let source = manager
            .issue_grant(ProjectGrantKind::Source, source_path.clone(), "test")
            .await
            .expect("issue source grant");
        assert_eq!(
            manager
                .consume_grant(&source, ProjectGrantKind::Source, "test")
                .await
                .expect("consume source grant"),
            source_path
        );
        assert!(
            manager
                .consume_grant(&source, ProjectGrantKind::Source, "test")
                .await
                .is_err()
        );

        for index in 0..MAX_PROJECT_GRANTS {
            manager
                .issue_grant(
                    ProjectGrantKind::Target,
                    root.join(format!("target-{index}.bbcom")),
                    "test",
                )
                .await
                .expect("fill grant registry");
        }
        let limited = manager
            .issue_grant(
                ProjectGrantKind::Target,
                root.join("overflow.bbcom"),
                "test",
            )
            .await
            .unwrap_err();
        assert_eq!(limited.code, AppErrorCode::LimitExceeded);
        assert_eq!(limited.limit, Some(MAX_PROJECT_GRANTS));

        manager.grants.lock().await.clear();
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[tokio::test]
    async fn expired_project_grants_are_removed_before_resolution_and_issue() {
        let root = temporary_root("grant-expiry");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let expired_id = "expired-project-grant".to_owned();
        manager.grants.lock().await.insert(
            expired_id.clone(),
            ProjectGrant {
                kind: ProjectGrantKind::Source,
                path: root.join("expired.bbcom"),
                issued_at: Instant::now()
                    .checked_sub(PROJECT_GRANT_TTL + Duration::from_secs(1))
                    .expect("past instant"),
            },
        );

        let expired = manager
            .consume_grant(&expired_id, ProjectGrantKind::Source, "test")
            .await
            .unwrap_err();
        assert_eq!(expired.code, AppErrorCode::InvalidInput);
        let replacement = manager
            .issue_grant(
                ProjectGrantKind::Source,
                root.join("replacement.bbcom"),
                "test",
            )
            .await
            .expect("expired entry no longer consumes capacity");
        assert!(replacement.starts_with("project-grant-"));

        manager.grants.lock().await.clear();
        fs::remove_dir_all(root).expect("remove test root");
    }
}
