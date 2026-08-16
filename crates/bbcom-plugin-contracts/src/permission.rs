use std::collections::BTreeSet;

use crate::{ContractError, Result};

/// Single wire contract for plugin capabilities. The enum, its serde renames,
/// and its ordering live in `bbcom-contracts` (which owns TypeScript
/// generation); this crate re-exports it so every plugin-side consumer keeps
/// one import path.
pub use bbcom_contracts::PluginPermission as Permission;

/// Parses the manifest wire form of a capability. `network.*` requests keep
/// their dedicated unavailable-capability error; anything else unknown is an
/// invalid manifest field.
pub fn parse_permission(value: &str) -> Result<Permission> {
    Permission::ALL
        .into_iter()
        .find(|permission| permission.as_str() == value)
        .ok_or_else(|| {
            if value.starts_with("network.") {
                ContractError::UnsupportedCapability {
                    capability: value.to_owned(),
                }
            } else {
                ContractError::InvalidField {
                    field: "requestedCapabilities",
                }
            }
        })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityPlan {
    pub effective: BTreeSet<Permission>,
    pub unavailable: BTreeSet<Permission>,
}

#[must_use]
pub fn capability_plan(declared: &[Permission]) -> CapabilityPlan {
    let effective = declared
        .iter()
        .copied()
        .filter(|permission| permission.is_implemented())
        .collect();
    let unavailable = declared
        .iter()
        .copied()
        .filter(|permission| !permission.is_implemented())
        .collect();
    CapabilityPlan {
        effective,
        unavailable,
    }
}
