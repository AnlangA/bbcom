use std::env;
use std::fs;
use std::path::PathBuf;

const AMBIENT_IMPORT: &str = r#"  (type $ambient-network
    (instance
      (export "resolve" (func (result string)))))
  (import "wasi:sockets/network@0.2.0"
    (instance $ambient-socket (type $ambient-network)))
"#;

fn main() {
    if let Err(error) = run() {
        eprintln!("component-to-wat: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let input = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let output = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let ambient = match arguments.next() {
        None => false,
        Some(flag) if flag == "--ambient-import" => true,
        Some(_) => return Err(usage()),
    };
    if arguments.next().is_some() {
        return Err(usage());
    }

    let mut wat = wasmprinter::print_file(&input)
        .map_err(|error| format!("print {}: {error}", input.display()))?;
    if ambient {
        let tail = wat
            .strip_prefix("(component\n")
            .ok_or_else(|| "printer output is not a Component".to_string())?;
        wat = format!("(component\n{AMBIENT_IMPORT}{tail}");
    }
    fs::write(&output, wat).map_err(|error| format!("write {}: {error}", output.display()))?;
    Ok(())
}

fn usage() -> String {
    "usage: bbcom-component-to-wat <component.wasm> <output.wat> [--ambient-import]".to_string()
}
