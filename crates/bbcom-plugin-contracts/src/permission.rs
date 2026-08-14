use std::collections::BTreeSet;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::{ContractError, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Permission {
    #[serde(rename = "ui.panel")]
    UiPanel,
    #[serde(rename = "plugin.storage")]
    PluginStorage,
    #[serde(rename = "session.metadata.read")]
    SessionMetadataRead,
    #[serde(rename = "session.capture.read")]
    SessionCaptureRead,
    #[serde(rename = "project.settings.read-write")]
    ProjectSettingsReadWrite,
    #[serde(rename = "serial.ports.read")]
    SerialPortsRead,
    #[serde(rename = "serial.control")]
    SerialControl,
    #[serde(rename = "serial.write-proposal")]
    SerialWriteProposal,
    #[serde(rename = "ai.conversation.read")]
    AiConversationRead,
    #[serde(rename = "ai.request")]
    AiRequest,
    #[serde(rename = "file.open-save")]
    FileOpenSave,
    #[serde(rename = "clipboard")]
    Clipboard,
    #[serde(rename = "notification")]
    Notification,
}

impl Permission {
    pub const ALL: [Self; 13] = [
        Self::UiPanel,
        Self::PluginStorage,
        Self::SessionMetadataRead,
        Self::SessionCaptureRead,
        Self::ProjectSettingsReadWrite,
        Self::SerialPortsRead,
        Self::SerialControl,
        Self::SerialWriteProposal,
        Self::AiConversationRead,
        Self::AiRequest,
        Self::FileOpenSave,
        Self::Clipboard,
        Self::Notification,
    ];

    #[must_use]
    pub const fn is_implicit(self) -> bool {
        matches!(self, Self::UiPanel | Self::PluginStorage)
    }

    #[must_use]
    pub const fn is_per_request_only(self) -> bool {
        matches!(self, Self::SerialWriteProposal)
    }

    #[must_use]
    pub const fn risk(self) -> PermissionRisk {
        match self {
            Self::UiPanel | Self::PluginStorage | Self::Notification => PermissionRisk::Low,
            Self::SessionMetadataRead | Self::SerialPortsRead | Self::Clipboard => {
                PermissionRisk::Medium
            }
            Self::SessionCaptureRead
            | Self::ProjectSettingsReadWrite
            | Self::SerialControl
            | Self::SerialWriteProposal
            | Self::AiConversationRead
            | Self::AiRequest
            | Self::FileOpenSave => PermissionRisk::High,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UiPanel => "ui.panel",
            Self::PluginStorage => "plugin.storage",
            Self::SessionMetadataRead => "session.metadata.read",
            Self::SessionCaptureRead => "session.capture.read",
            Self::ProjectSettingsReadWrite => "project.settings.read-write",
            Self::SerialPortsRead => "serial.ports.read",
            Self::SerialControl => "serial.control",
            Self::SerialWriteProposal => "serial.write-proposal",
            Self::AiConversationRead => "ai.conversation.read",
            Self::AiRequest => "ai.request",
            Self::FileOpenSave => "file.open-save",
            Self::Clipboard => "clipboard",
            Self::Notification => "notification",
        }
    }
}

impl fmt::Display for Permission {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Permission {
    type Err = ContractError;

    fn from_str(value: &str) -> Result<Self> {
        Self::ALL
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum PermissionRisk {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RiskCombination {
    CaptureWithExternalSink,
    ConversationWithExternalSink,
    SerialControlAndWriteProposal,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AuthorizationKey {
    pub plugin_id: String,
    pub publisher_identity: String,
    pub plugin_major: u64,
    pub workspace_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionPlan {
    pub implicit: BTreeSet<Permission>,
    pub requires_approval: BTreeSet<Permission>,
    pub maximum_risk: PermissionRisk,
    pub risk_combinations: BTreeSet<RiskCombination>,
}

pub fn permission_plan(requested: &[Permission]) -> PermissionPlan {
    let implicit: BTreeSet<_> = [Permission::UiPanel, Permission::PluginStorage]
        .into_iter()
        .collect();
    let requires_approval: BTreeSet<_> = requested
        .iter()
        .copied()
        .filter(|permission| !permission.is_implicit())
        .collect();
    let mut maximum_risk = implicit
        .iter()
        .chain(requires_approval.iter())
        .map(|permission| permission.risk())
        .max()
        .unwrap_or(PermissionRisk::Low);
    let has_external_sink = requires_approval.contains(&Permission::FileOpenSave)
        || requires_approval.contains(&Permission::Clipboard)
        || requires_approval.contains(&Permission::AiRequest);
    let mut risk_combinations = BTreeSet::new();
    if has_external_sink && requires_approval.contains(&Permission::SessionCaptureRead) {
        risk_combinations.insert(RiskCombination::CaptureWithExternalSink);
    }
    if has_external_sink && requires_approval.contains(&Permission::AiConversationRead) {
        risk_combinations.insert(RiskCombination::ConversationWithExternalSink);
    }
    if requires_approval.contains(&Permission::SerialControl)
        && requires_approval.contains(&Permission::SerialWriteProposal)
    {
        risk_combinations.insert(RiskCombination::SerialControlAndWriteProposal);
    }
    if !risk_combinations.is_empty() {
        maximum_risk = PermissionRisk::Critical;
    }
    PermissionPlan {
        implicit,
        requires_approval,
        maximum_risk,
        risk_combinations,
    }
}

pub fn validate_persistent_grant(permission: Permission) -> Result<()> {
    if permission.is_per_request_only() {
        Err(ContractError::SerialProposalNotPersistable)
    } else {
        Ok(())
    }
}
