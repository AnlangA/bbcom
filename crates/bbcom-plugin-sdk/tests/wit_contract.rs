use std::path::PathBuf;

#[test]
fn protocol_v2_wit_parses_as_the_plugin_world() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../wit/bbcom-plugin-v2");
    let mut resolve = wit_parser::Resolve::default();
    let (package_id, _sources) = resolve.push_dir(&path).expect("protocol-v2 WIT must parse");

    let package = &resolve.packages[package_id];
    assert_eq!(package.name.namespace, "bbcom");
    assert_eq!(package.name.name, "plugin");
    assert_eq!(package.name.version.as_ref().unwrap().major, 2);
    assert!(package.worlds.contains_key("plugin"));
    assert!(package.interfaces.contains_key("types"));
    assert!(package.interfaces.contains_key("host"));
}
