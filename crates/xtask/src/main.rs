use std::env;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_OUTPUT: &str = "src/generated/ipc-contracts.ts";

fn main() {
    if let Err(error) = run(env::args_os().skip(1)) {
        eprintln!("xtask: {error}");
        std::process::exit(1);
    }
}

fn run<I, S>(args: I) -> Result<(), Box<dyn Error>>
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString>,
{
    let options = parse_args(args)?;
    let generated = bbcom_contracts::render_typescript();

    if options.check {
        let current = fs::read_to_string(&options.output).map_err(|error| {
            format!(
                "bindings check could not read {}: {error}; run `cargo run -p xtask -- bindings`",
                options.output.display()
            )
        })?;
        if current != generated {
            return Err(format!(
                "{} is stale; run `cargo run -p xtask -- bindings`",
                options.output.display()
            )
            .into());
        }
        println!("bindings are current: {}", options.output.display());
        return Ok(());
    }

    write_if_changed(&options.output, generated.as_bytes())?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct Options {
    check: bool,
    output: PathBuf,
}

fn parse_args<I, S>(args: I) -> Result<Options, Box<dyn Error>>
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString>,
{
    let mut args = args.into_iter().map(Into::into);
    let Some(command) = args.next() else {
        return Err(usage().into());
    };
    if command != "bindings" {
        return Err(format!("unknown xtask command {command:?}\n{}", usage()).into());
    }

    let mut check = false;
    let mut output = None;
    while let Some(argument) = args.next() {
        if argument == "--check" {
            if check {
                return Err("--check may be specified only once".into());
            }
            check = true;
            continue;
        }
        if argument == "--output" {
            if output.is_some() {
                return Err("--output may be specified only once".into());
            }
            let Some(value) = args.next() else {
                return Err("--output requires a path".into());
            };
            if value.is_empty() {
                return Err("--output path must not be empty".into());
            }
            output = Some(PathBuf::from(value));
            continue;
        }
        return Err(format!("unknown bindings option {argument:?}\n{}", usage()).into());
    }

    Ok(Options {
        check,
        output: output.unwrap_or_else(default_output),
    })
}

fn default_output() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(DEFAULT_OUTPUT)
}

fn write_if_changed(path: &Path, contents: &[u8]) -> Result<(), Box<dyn Error>> {
    match fs::read(path) {
        Ok(current) if current == contents => {
            println!("bindings unchanged: {}", path.display());
            return Ok(());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let parent = path
        .parent()
        .ok_or_else(|| format!("output path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)?;
    fs::write(path, contents)?;
    println!("wrote bindings: {}", path.display());
    Ok(())
}

fn usage() -> &'static str {
    "usage: cargo run -p xtask -- bindings [--check] [--output <path>]"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_order_independent_binding_flags() {
        assert_eq!(
            parse_args(["bindings", "--output", "custom.ts", "--check"]).expect("valid args"),
            Options {
                check: true,
                output: PathBuf::from("custom.ts")
            }
        );
        assert!(parse_args(["bindings", "--check", "--check"]).is_err());
        assert!(parse_args(["unknown"]).is_err());
        assert_eq!(
            parse_args(["bindings"]).expect("default output"),
            Options {
                check: false,
                output: default_output(),
            }
        );

        let missing = std::env::temp_dir().join(format!(
            "bbcom-bindings-check-missing-{}-{}.ts",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        ));
        assert!(run(["bindings", "--check", "--output", missing.to_str().unwrap()]).is_err());
        assert!(
            !missing.exists(),
            "check mode must not create a missing binding"
        );

        write_if_changed(&missing, b"generated").expect("create generated binding");
        write_if_changed(&missing, b"generated").expect("leave matching binding unchanged");
        assert_eq!(
            fs::read(&missing).expect("read generated binding"),
            b"generated"
        );
        fs::remove_file(&missing).expect("remove generated binding");

        assert!(write_if_changed(Path::new(""), b"generated").is_err());
    }
}
