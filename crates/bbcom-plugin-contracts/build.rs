fn main() -> Result<(), Box<dyn std::error::Error>> {
    const PROTO: &str = "proto/bbcom_plugin_host_v1.proto";
    println!("cargo:rerun-if-changed={PROTO}");
    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config.compile_protos(&[PROTO], &["proto"])?;
    Ok(())
}
