#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(result) = bbcom::plugins::run_plugin_g45_probe_from_environment() {
        if let Err(error) = result {
            eprintln!("plugin G45 probe failed: {error}");
            std::process::exit(2);
        }
        return;
    }
    bbcom::run();
}
