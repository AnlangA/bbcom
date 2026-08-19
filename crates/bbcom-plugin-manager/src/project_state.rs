use std::collections::BTreeSet;

use bbcom_contracts::{MAX_PLUGIN_STATE_BYTES, MAX_WORKSPACE_PLUGIN_STATE_BYTES};

use crate::{ManagerErrorCode, OpaqueProjectPluginState, Result};

pub const MAX_PLUGIN_PROJECT_STATE_BYTES: usize = MAX_PLUGIN_STATE_BYTES;
pub const MAX_PROJECT_PLUGIN_STATE_BYTES: usize = MAX_WORKSPACE_PLUGIN_STATE_BYTES;

pub(crate) fn validate_project_states(states: &[OpaqueProjectPluginState]) -> Result<()> {
    let mut plugin_ids = BTreeSet::new();
    let mut total = 0_usize;
    for state in states {
        OpaqueProjectPluginState::new_with_versions(
            state.plugin_id.clone(),
            Vec::new(),
            state.api_generation,
            state.schema_version,
        )?;
        if !plugin_ids.insert(state.plugin_id.as_str()) {
            return Err(ManagerErrorCode::ProjectStateInvalid.into());
        }
        if state.bytes.len() > MAX_PLUGIN_PROJECT_STATE_BYTES {
            return Err(ManagerErrorCode::ProjectStateLimitExceeded.into());
        }
        total = total
            .checked_add(state.bytes.len())
            .ok_or(ManagerErrorCode::ProjectStateLimitExceeded)?;
        if total > MAX_PROJECT_PLUGIN_STATE_BYTES {
            return Err(ManagerErrorCode::ProjectStateLimitExceeded.into());
        }
    }
    Ok(())
}
