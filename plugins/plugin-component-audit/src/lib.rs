use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use wasmparser::{ComponentTypeRef, Parser, Payload, TypeRef, Validator, WasmFeatures};

const EXPECTED_HOST: &str = "bbcom:plugin/host@2.0.0";
const EXPECTED_TYPES: &str = "bbcom:plugin/types@2.0.0";
const REQUIRED_EXPORTS: [&str; 5] = [
    "initialize",
    "handle-event",
    "run-command",
    "migrate-state",
    "shutdown",
];

pub fn audit_source_boundary(crate_root: &Path) -> Result<(), String> {
    let manifest = fs::read_to_string(crate_root.join("Cargo.toml"))
        .map_err(|error| format!("read guest Cargo.toml: {error}"))?;
    for forbidden in ["serialport =", "tokio =", "async-std =", "wasi ="] {
        if manifest.to_ascii_lowercase().contains(forbidden) {
            return Err(format!(
                "guest dependency manifest contains forbidden authority marker {forbidden}"
            ));
        }
    }

    for entry in fs::read_dir(crate_root.join("src"))
        .map_err(|error| format!("read guest sources: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("read guest source entry: {error}"))?
            .path();
        if path.extension().and_then(|value| value.to_str()) != Some("rs") {
            continue;
        }
        let source = fs::read_to_string(&path)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        for forbidden in [
            "use std::fs",
            "use std::net",
            "use std::process",
            "use std::env",
            "serialport::",
            "wasi::",
            "tauri::",
        ] {
            if source.contains(forbidden) {
                return Err(format!(
                    "{} contains forbidden authority marker {forbidden}",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

pub fn audit_component(component: &Path) -> Result<(), String> {
    let bytes = fs::read(component)
        .map_err(|error| format!("read component {}: {error}", component.display()))?;
    Validator::new_with_features(WasmFeatures::all())
        .validate_all(&bytes)
        .map_err(|error| format!("invalid WebAssembly component: {error}"))?;

    let mut component_imports = BTreeSet::new();
    let mut imported_types = BTreeSet::new();
    let mut core_imports = BTreeSet::new();
    let mut component_exports = BTreeSet::new();
    let mut declared_memories = Vec::new();
    for payload in Parser::new(0).parse_all(&bytes) {
        match payload.map_err(|error| format!("parse component: {error}"))? {
            Payload::ComponentImportSection(section) => {
                for import in section {
                    let import = import.map_err(|error| format!("component import: {error}"))?;
                    match import.ty {
                        ComponentTypeRef::Type(_) => {
                            imported_types.insert(import.name.name.to_string());
                        }
                        _ => {
                            component_imports.insert(import.name.name.to_string());
                        }
                    }
                }
            }
            Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    let import = import.map_err(|error| format!("core import: {error}"))?;
                    if matches!(import.ty, TypeRef::Memory(_)) {
                        return Err("component imports linear memory".to_string());
                    }
                    core_imports.insert((import.module.to_string(), import.name.to_string()));
                }
            }
            Payload::MemorySection(section) => {
                for memory in section {
                    declared_memories
                        .push(memory.map_err(|error| format!("memory declaration: {error}"))?);
                }
            }
            Payload::ComponentExportSection(section) => {
                for export in section {
                    component_exports.insert(
                        export
                            .map_err(|error| format!("component export: {error}"))?
                            .name
                            .name
                            .to_string(),
                    );
                }
            }
            _ => {}
        }
    }

    let expected = BTreeSet::from([EXPECTED_HOST.to_string(), EXPECTED_TYPES.to_string()]);
    if component_imports != expected {
        return Err(format!(
            "unexpected component imports: {component_imports:?}"
        ));
    }
    if !imported_types.contains("contract-error") || !imported_types.contains("host-context") {
        return Err(format!("missing WIT type aliases: {imported_types:?}"));
    }
    if core_imports.is_empty()
        || !core_imports
            .iter()
            .all(|(module, _)| module.is_empty() || module == EXPECTED_HOST)
    {
        return Err(format!("unexpected core imports: {core_imports:?}"));
    }
    if declared_memories.len() != 1 {
        return Err(format!(
            "expected one private linear memory, found {}",
            declared_memories.len()
        ));
    }
    let memory = declared_memories[0];
    let page_bytes = 1_u64 << memory.page_size_log2.unwrap_or(16);
    if memory.memory64
        || memory.shared
        || memory.initial.saturating_mul(page_bytes) > 64 * 1024 * 1024
    {
        return Err(format!("invalid or oversized guest memory: {memory:?}"));
    }
    for required in REQUIRED_EXPORTS {
        if !component_exports.contains(required) {
            return Err(format!(
                "missing guest export {required}; observed {component_exports:?}"
            ));
        }
    }
    for name in component_imports
        .iter()
        .chain(core_imports.iter().map(|(module, _)| module))
        .chain(core_imports.iter().map(|(_, name)| name))
    {
        let lower = name.to_ascii_lowercase();
        for forbidden in [
            "wasi",
            "filesystem",
            "socket",
            "network",
            "serialport",
            "tauri",
            "environment",
            "process",
        ] {
            if lower.contains(forbidden) {
                return Err(format!("forbidden import {name}"));
            }
        }
    }
    Ok(())
}
