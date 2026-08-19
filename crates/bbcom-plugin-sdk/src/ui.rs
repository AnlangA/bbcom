use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::limits::{MAX_UI_DOCUMENT_BYTES, MAX_UI_NODES};
use crate::{ContractError, Result};

#[derive(Clone, Debug, PartialEq)]
pub struct UiNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub order: u32,
    pub kind: UiNodeKind,
}

#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum UiNodeKind {
    Column,
    Row,
    Group {
        title: String,
    },
    Tabs {
        selected_child_id: String,
    },
    Text {
        text: String,
    },
    Badge {
        text: String,
        tone: String,
    },
    KeyValue {
        entries: Vec<(String, String)>,
    },
    Progress {
        value: u32,
        maximum: u32,
        label: String,
    },
    Log {
        text: String,
        language: Option<String>,
    },
    Code {
        text: String,
        language: Option<String>,
    },
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
        page: u32,
        page_size: u32,
        total_rows: u64,
    },
    Input {
        label: String,
        value: String,
        placeholder: String,
        disabled: bool,
    },
    NumberInput {
        label: String,
        value: f64,
        minimum: Option<f64>,
        maximum: Option<f64>,
        step: Option<f64>,
        disabled: bool,
    },
    Select {
        label: String,
        value: String,
        options: Vec<(String, String)>,
        disabled: bool,
    },
    Toggle {
        label: String,
        checked: bool,
        disabled: bool,
    },
    Button {
        label: String,
        disabled: bool,
    },
    DangerousButton {
        label: String,
        disabled: bool,
        /// Mandatory host-rendered confirmation. The WIT button record keeps
        /// this optional so ordinary buttons share the wire shape, but this
        /// SDK cannot construct a dangerous action without confirmation text.
        confirmation: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceDocument {
    pub surface_id: String,
    pub revision: u64,
    pub root_node_id: String,
    pub nodes: Vec<UiNode>,
}

pub struct SurfaceBuilder {
    document: SurfaceDocument,
    estimated_bytes: usize,
}

impl SurfaceBuilder {
    pub fn new(
        surface_id: impl Into<String>,
        revision: u64,
        root_kind: UiNodeKind,
    ) -> Result<Self> {
        if revision == 0 {
            return Err(ContractError::InvalidInput);
        }
        let surface_id = surface_id.into();
        validate_id(&surface_id)?;
        let root_id = "root".to_string();
        let root = UiNode {
            id: root_id.clone(),
            parent_id: None,
            order: 0,
            kind: root_kind,
        };
        validate_kind(&root.kind)?;
        let estimated_bytes = estimate_node_bytes(&root) + surface_id.len();
        Ok(Self {
            document: SurfaceDocument {
                surface_id,
                revision,
                root_node_id: root_id,
                nodes: alloc::vec![root],
            },
            estimated_bytes,
        })
    }

    pub fn push(
        &mut self,
        parent_id: &str,
        id: impl Into<String>,
        order: u32,
        kind: UiNodeKind,
    ) -> Result<&mut Self> {
        let id = id.into();
        validate_id(&id)?;
        validate_kind(&kind)?;
        if self.document.nodes.len() >= MAX_UI_NODES {
            return Err(ContractError::LimitExceeded);
        }
        if self.document.nodes.iter().any(|node| node.id == id) {
            return Err(ContractError::InvalidInput);
        }
        if !self.document.nodes.iter().any(|node| node.id == parent_id) {
            return Err(ContractError::NotFound);
        }
        let node = UiNode {
            id,
            parent_id: Some(parent_id.to_string()),
            order,
            kind,
        };
        let next_size = self
            .estimated_bytes
            .checked_add(estimate_node_bytes(&node))
            .ok_or(ContractError::LimitExceeded)?;
        if next_size > MAX_UI_DOCUMENT_BYTES {
            return Err(ContractError::LimitExceeded);
        }
        self.estimated_bytes = next_size;
        self.document.nodes.push(node);
        Ok(self)
    }

    pub fn text(
        &mut self,
        parent: &str,
        id: &str,
        order: u32,
        text: impl Into<String>,
    ) -> Result<&mut Self> {
        self.push(parent, id, order, UiNodeKind::Text { text: text.into() })
    }

    pub fn button(
        &mut self,
        parent: &str,
        id: &str,
        order: u32,
        label: impl Into<String>,
    ) -> Result<&mut Self> {
        self.push(
            parent,
            id,
            order,
            UiNodeKind::Button {
                label: label.into(),
                disabled: false,
            },
        )
    }

    pub fn dangerous_button(
        &mut self,
        parent: &str,
        id: &str,
        order: u32,
        label: impl Into<String>,
        confirmation: impl Into<String>,
    ) -> Result<&mut Self> {
        self.push(
            parent,
            id,
            order,
            UiNodeKind::DangerousButton {
                label: label.into(),
                disabled: false,
                confirmation: confirmation.into(),
            },
        )
    }

    pub fn progress(
        &mut self,
        parent: &str,
        id: &str,
        order: u32,
        value: u32,
        maximum: u32,
        label: impl Into<String>,
    ) -> Result<&mut Self> {
        self.push(
            parent,
            id,
            order,
            UiNodeKind::Progress {
                value,
                maximum,
                label: label.into(),
            },
        )
    }

    pub fn build(self) -> Result<SurfaceDocument> {
        validate_document(&self.document)?;
        Ok(self.document)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PatchOperation {
    Upsert(UiNode),
    Remove(String),
    SetRoot(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct SurfacePatch {
    pub surface_id: String,
    pub base_revision: u64,
    pub next_revision: u64,
    pub operations: Vec<PatchOperation>,
}

impl SurfacePatch {
    pub fn new(
        surface_id: impl Into<String>,
        base_revision: u64,
        next_revision: u64,
        operations: Vec<PatchOperation>,
    ) -> Result<Self> {
        let surface_id = surface_id.into();
        validate_id(&surface_id)?;
        if base_revision == 0 || next_revision <= base_revision || operations.is_empty() {
            return Err(ContractError::InvalidInput);
        }
        if operations.len() > MAX_UI_NODES {
            return Err(ContractError::LimitExceeded);
        }
        for operation in &operations {
            match operation {
                PatchOperation::Upsert(node) => {
                    validate_id(&node.id)?;
                    validate_kind(&node.kind)?;
                }
                PatchOperation::Remove(id) | PatchOperation::SetRoot(id) => validate_id(id)?,
            }
        }
        Ok(Self {
            surface_id,
            base_revision,
            next_revision,
            operations,
        })
    }
}

pub fn validate_document(document: &SurfaceDocument) -> Result<()> {
    validate_id(&document.surface_id)?;
    validate_id(&document.root_node_id)?;
    if document.revision == 0 || document.nodes.is_empty() {
        return Err(ContractError::InvalidInput);
    }
    if document.nodes.len() > MAX_UI_NODES {
        return Err(ContractError::LimitExceeded);
    }
    let mut roots = 0_usize;
    let mut estimated = document.surface_id.len();
    for (index, node) in document.nodes.iter().enumerate() {
        validate_id(&node.id)?;
        validate_kind(&node.kind)?;
        if document.nodes[..index]
            .iter()
            .any(|other| other.id == node.id)
        {
            return Err(ContractError::InvalidInput);
        }
        match &node.parent_id {
            None => roots += 1,
            Some(parent) if parent == &node.id => return Err(ContractError::InvalidInput),
            Some(parent)
                if !document
                    .nodes
                    .iter()
                    .any(|candidate| &candidate.id == parent) =>
            {
                return Err(ContractError::NotFound);
            }
            Some(_) => {}
        }
        estimated = estimated
            .checked_add(estimate_node_bytes(node))
            .ok_or(ContractError::LimitExceeded)?;
    }
    let root = document
        .nodes
        .iter()
        .find(|node| node.id == document.root_node_id);
    if roots != 1 || !matches!(root, Some(node) if node.parent_id.is_none()) {
        return Err(ContractError::InvalidInput);
    }
    if has_parent_cycle(document) {
        return Err(ContractError::InvalidInput);
    }
    if estimated > MAX_UI_DOCUMENT_BYTES {
        return Err(ContractError::LimitExceeded);
    }
    Ok(())
}

fn has_parent_cycle(document: &SurfaceDocument) -> bool {
    for node in &document.nodes {
        let mut cursor = node;
        for _ in 0..document.nodes.len() {
            let Some(parent_id) = cursor.parent_id.as_ref() else {
                break;
            };
            let Some(parent) = document
                .nodes
                .iter()
                .find(|candidate| &candidate.id == parent_id)
            else {
                break;
            };
            if parent.id == node.id {
                return true;
            }
            cursor = parent;
        }
    }
    false
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':'))
    {
        Err(ContractError::InvalidInput)
    } else {
        Ok(())
    }
}

fn validate_kind(kind: &UiNodeKind) -> Result<()> {
    match kind {
        UiNodeKind::Progress { value, maximum, .. } if *maximum == 0 || value > maximum => {
            Err(ContractError::InvalidInput)
        }
        UiNodeKind::Table {
            columns,
            rows,
            page_size,
            total_rows,
            ..
        } if columns.is_empty()
            || *page_size == 0
            || rows.len() > *page_size as usize
            || rows.len() as u64 > *total_rows
            || rows.iter().any(|row| row.len() != columns.len()) =>
        {
            Err(ContractError::InvalidInput)
        }
        UiNodeKind::NumberInput {
            minimum: Some(min),
            maximum: Some(max),
            ..
        } if min > max => Err(ContractError::InvalidInput),
        UiNodeKind::DangerousButton { confirmation, .. }
            if confirmation.is_empty() || confirmation.len() > 1_024 =>
        {
            Err(ContractError::InvalidInput)
        }
        _ => Ok(()),
    }
}

fn estimate_node_bytes(node: &UiNode) -> usize {
    let base = node.id.len() + node.parent_id.as_ref().map_or(0, String::len) + 32;
    base + match &node.kind {
        UiNodeKind::Column | UiNodeKind::Row => 0,
        UiNodeKind::Group { title } => title.len(),
        UiNodeKind::Tabs { selected_child_id } => selected_child_id.len(),
        UiNodeKind::Text { text } => text.len(),
        UiNodeKind::Badge { text, tone } => text.len() + tone.len(),
        UiNodeKind::KeyValue { entries } => entries.iter().map(|(a, b)| a.len() + b.len()).sum(),
        UiNodeKind::Progress { label, .. }
        | UiNodeKind::Button { label, .. }
        | UiNodeKind::Toggle { label, .. }
        | UiNodeKind::NumberInput { label, .. } => label.len(),
        UiNodeKind::DangerousButton {
            label,
            confirmation,
            ..
        } => label.len() + confirmation.len(),
        UiNodeKind::Log { text, language } | UiNodeKind::Code { text, language } => {
            text.len() + language.as_ref().map_or(0, String::len)
        }
        UiNodeKind::Table { columns, rows, .. } => {
            columns.iter().map(String::len).sum::<usize>()
                + rows.iter().flatten().map(String::len).sum::<usize>()
        }
        UiNodeKind::Input {
            label,
            value,
            placeholder,
            ..
        } => label.len() + value.len() + placeholder.len(),
        UiNodeKind::Select {
            label,
            value,
            options,
            ..
        } => {
            label.len()
                + value.len()
                + options
                    .iter()
                    .map(|(option, title)| option.len() + title.len())
                    .sum::<usize>()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_creates_a_valid_stable_tree() {
        let mut builder = SurfaceBuilder::new("overview", 1, UiNodeKind::Column).unwrap();
        builder
            .text("root", "status", 0, "Connected")
            .unwrap()
            .progress("root", "upload", 1, 25, 100, "Firmware")
            .unwrap()
            .dangerous_button(
                "root",
                "erase",
                2,
                "Erase",
                "Erase all application storage? This cannot be undone.",
            )
            .unwrap();
        let document = builder.build().unwrap();
        assert_eq!(document.nodes.len(), 4);
        assert_eq!(document.root_node_id, "root");
    }

    #[test]
    fn invalid_tables_and_revision_conflicts_fail_closed() {
        let mut builder = SurfaceBuilder::new("files", 1, UiNodeKind::Column).unwrap();
        assert!(matches!(
            builder.push(
                "root",
                "table",
                0,
                UiNodeKind::Table {
                    columns: alloc::vec!["name".into()],
                    rows: alloc::vec![alloc::vec!["a".into()], alloc::vec!["b".into()]],
                    page: 0,
                    page_size: 1,
                    total_rows: 2,
                },
            ),
            Err(ContractError::InvalidInput)
        ));
        assert_eq!(
            SurfacePatch::new(
                "files",
                2,
                2,
                alloc::vec![PatchOperation::Remove("table".into())]
            ),
            Err(ContractError::InvalidInput)
        );
    }

    #[test]
    fn dangerous_buttons_require_host_confirmation_text() {
        let mut builder = SurfaceBuilder::new("firmware", 1, UiNodeKind::Column).unwrap();
        assert!(matches!(
            builder.dangerous_button("root", "erase", 0, "Erase", ""),
            Err(ContractError::InvalidInput)
        ));
    }
}
