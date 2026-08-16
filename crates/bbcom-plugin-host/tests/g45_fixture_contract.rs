use std::fs;

use bbcom_plugin_contracts::Permission;
use bbcom_plugin_host::{PluginEngineFactory, TrustedPluginArtifact};
use sha2::{Digest, Sha256};
use wasmtime::component::Component;
use wasmtime::{Config, Engine};

/// The host allows one live component store per process; the two tests
/// share this lock instead of racing the process-wide guard.
static HOST_STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn reviewed_fixture_sources_compile_match_the_v1_world_and_reach_each_runtime_boundary() {
    let _serial = HOST_STORE_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let fixtures = [
        (
            "primary",
            include_bytes!(
                "../../../tests/fixtures/plugins/malicious/g45-malicious.component.wasm"
            )
            .as_slice(),
            None,
        ),
        (
            "trap",
            include_bytes!("../../../tests/fixtures/plugins/malicious/g45-trap.component.wat")
                .as_slice(),
            Some("PLUGIN_TRAP"),
        ),
        (
            "runaway",
            include_bytes!("../../../tests/fixtures/plugins/malicious/g45-runaway.component.wat")
                .as_slice(),
            Some("PLUGIN_FUEL_EXHAUSTED"),
        ),
        (
            "memory",
            include_bytes!("../../../tests/fixtures/plugins/malicious/g45-memory.component.wat")
                .as_slice(),
            Some("PLUGIN_MEMORY_LIMIT"),
        ),
    ];
    let factory = PluginEngineFactory::new().expect("fixed engine policy");
    let mut config = Config::new();
    config.wasm_component_model(true);
    let validation_engine = Engine::new(&config).expect("validation engine");
    for (name, source, expected_error) in fixtures {
        let directory = tempfile::tempdir().expect("fixture root");
        fs::create_dir(directory.path().join("component")).expect("component directory");
        let compiled = wat::parse_bytes(source).expect("reviewed Component text");
        Component::from_binary(&validation_engine, &compiled)
            .unwrap_or_else(|error| panic!("{name} Component validation failed: {error:?}"));
        let digest: String = Sha256::digest(&compiled)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        fs::write(directory.path().join("component/plugin.wasm"), &compiled)
            .expect("compiled fixture");
        let manifest = format!(
            "id = \"dev.bbcom.g45-fixture\"\nname = \"G45 {name}\"\nversion = \"1.0.0\"\napi = \"^1.0\"\nrequested-capabilities = []\n\n[component]\npath = \"component/plugin.wasm\"\nsha256 = \"{digest}\"\n\n[publisher]\nname = \"bbcom G45\"\nidentity = \"publisher:bbcom-g45\"\nwebsite = \"https://example.invalid\"\n"
        );
        let artifact = TrustedPluginArtifact::load(directory.path(), &manifest)
            .expect("trusted fixture artifact");
        let mut runtime = factory
            .load(&artifact, [Permission::UiPanel, Permission::PluginStorage])
            .expect("fixture matches bbcom:plugin/plugin@1.0.0");
        match expected_error {
            None => {
                runtime
                    .initialize()
                    .expect("primary fixture produced a declarative panel");
                runtime.shutdown().expect("clean fixture shutdown");
            }
            Some(expected) => {
                assert_eq!(
                    runtime
                        .initialize()
                        .expect_err("adversarial boundary")
                        .code(),
                    expected
                );
            }
        }
    }
}

#[test]
fn ambient_fixture_fails_only_because_its_wasi_import_is_unlinked() {
    let _serial = HOST_STORE_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    const AMBIENT_IMPORT: &str = "  (import \"wasi:sockets/network@0.2.0\" (instance $ambient-socket (type $ambient-network)))\n";

    let source = std::str::from_utf8(include_bytes!(
        "../../../tests/fixtures/plugins/malicious/g45-ambient-import.component.wat"
    ))
    .expect("reviewed ambient fixture is UTF-8");
    assert_eq!(
        source.matches("(import ").count(),
        1,
        "ambient fixture must contain exactly one Component import"
    );
    assert!(
        source.contains(AMBIENT_IMPORT),
        "ambient fixture must import only the reviewed WASI socket instance"
    );

    let factory = PluginEngineFactory::new().expect("fixed engine policy");
    let mut config = Config::new();
    config.wasm_component_model(true);
    let validation_engine = Engine::new(&config).expect("validation engine");
    let compiled = wat::parse_bytes(source.as_bytes()).expect("reviewed ambient Component text");
    Component::from_binary(&validation_engine, &compiled)
        .expect("ambient fixture is a structurally valid Component");
    let artifact = trusted_fixture_artifact("ambient", &compiled);
    let error = match factory.load(&artifact, [Permission::UiPanel, Permission::PluginStorage]) {
        Err(error) => error,
        Ok(_) => panic!("ambient fixture unexpectedly linked its WASI import"),
    };
    assert_eq!(error.code(), "PLUGIN_COMPONENT_INVALID");

    let without_import = source.replacen(AMBIENT_IMPORT, "", 1);
    assert_eq!(
        without_import.matches("(import ").count(),
        0,
        "control fixture must differ only by removal of the ambient import"
    );
    let compiled_without_import = wat::parse_bytes(without_import.as_bytes())
        .expect("ambient control Component text without import");
    Component::from_binary(&validation_engine, &compiled_without_import)
        .expect("ambient control is a structurally valid Component");
    let artifact_without_import =
        trusted_fixture_artifact("ambient-without-import", &compiled_without_import);
    let _runtime = factory
        .load(
            &artifact_without_import,
            [Permission::UiPanel, Permission::PluginStorage],
        )
        .expect("the otherwise-identical Component links once the ambient import is removed");
}

fn trusted_fixture_artifact(name: &str, component: &[u8]) -> TrustedPluginArtifact {
    let directory = tempfile::tempdir().expect("fixture root");
    fs::create_dir(directory.path().join("component")).expect("component directory");
    fs::write(directory.path().join("component/plugin.wasm"), component).expect("compiled fixture");
    let digest: String = Sha256::digest(component)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let manifest = format!(
        "id = \"dev.bbcom.g45-fixture\"\nname = \"G45 {name}\"\nversion = \"1.0.0\"\napi = \"^1.0\"\nrequested-capabilities = []\n\n[component]\npath = \"component/plugin.wasm\"\nsha256 = \"{digest}\"\n\n[publisher]\nname = \"bbcom G45\"\nidentity = \"publisher:bbcom-g45\"\nwebsite = \"https://example.invalid\"\n"
    );
    TrustedPluginArtifact::load(directory.path(), &manifest).expect("trusted fixture artifact")
}
