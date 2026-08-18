fn main() {
    #[cfg(target_os = "windows")]
    if let Err(error) = bbcom_plugin_host::process_child_policy::enforce() {
        eprintln!("{error}");
        std::process::exit(1);
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    #[cfg(target_os = "macos")]
    if let Err(error) = bbcom_plugin_host::process_memory_limit::enforce_additional_address_space(
        bbcom_plugin_contracts::HOST_PROCESS_MEMORY_LIMIT_BYTES,
    ) {
        eprintln!("{}", error.code());
        std::process::exit(1);
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(code) = bbcom_plugin_host::native_sandbox_probe::run_if_requested(&arguments) {
        std::process::exit(code);
    }
    if let Err(error) = bbcom_plugin_host::sidecar::run_from_environment() {
        eprintln!("{}", error.code());
        std::process::exit(1);
    }
}
