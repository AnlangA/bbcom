fn main() -> Result<(), Box<dyn std::error::Error>> {
    const PROTOS: [&str; 1] = ["proto/bbcom_plugin_host_v2.proto"];
    for proto in PROTOS {
        println!("cargo:rerun-if-changed={proto}");
    }
    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config.compile_protos(&PROTOS, &["proto"])?;
    Ok(())
}
