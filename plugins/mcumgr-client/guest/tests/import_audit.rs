use std::path::{Path, PathBuf};

use bbcom_plugin_component_audit::{audit_component, audit_source_boundary};

#[test]
fn guest_dependency_and_source_boundary_has_no_ambient_authority() {
    audit_source_boundary(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
}

#[test]
fn built_component_imports_only_the_v2_host_interface() {
    let component = std::env::var_os("BBCOM_MCUMGR_COMPONENT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../target/wasm32-wasip2/release/bbcom_mcumgr_guest.wasm")
        });
    assert!(
        component.is_file(),
        "build the wasm32-wasip2 release component before running import_audit: {}",
        component.display()
    );
    audit_component(&component).unwrap();
}
