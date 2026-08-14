fn main() {
    if let Err(error) = bbcom_plugin_host::sidecar::run_from_environment() {
        eprintln!("{}", error.code());
        std::process::exit(1);
    }
}
