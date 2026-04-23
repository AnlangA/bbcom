use crate::models::data_frame::{DataFrame, Direction};
use crate::models::errors::AppError;
use crate::utils::hex;
use std::fs::File;
use std::io::{BufWriter, Write};

pub fn export(frames: &[DataFrame], format: &str, path: &str) -> Result<(), AppError> {
    match format {
        "txt" => export_text(frames, path, false),
        "txt-hex" => export_text(frames, path, false),
        "txt-ascii" => export_text(frames, path, true),
        "csv" => export_csv(frames, path),
        "bin" => export_bin(frames, path),
        _ => Err(AppError::ExportError(format!(
            "unsupported format: {}",
            format
        ))),
    }
}

fn dir_label(d: &Direction) -> &'static str {
    match d {
        Direction::Tx => "TX",
        Direction::Rx => "RX",
    }
}

fn data_to_string(data: &[u8], ascii: bool) -> String {
    if ascii {
        String::from_utf8_lossy(data).to_string()
    } else {
        hex::format_hex(data)
    }
}

fn export_text(frames: &[DataFrame], path: &str, ascii: bool) -> Result<(), AppError> {
    let mut w = BufWriter::new(File::create(path)?);
    for frame in frames {
        let data_str = data_to_string(&frame.data, ascii);
        writeln!(&mut w, "[{}] {} | {}", frame.timestamp, dir_label(&frame.direction), data_str)?;
    }
    Ok(())
}

fn export_csv(frames: &[DataFrame], path: &str) -> Result<(), AppError> {
    let mut w = BufWriter::new(File::create(path)?);
    writeln!(&mut w, "timestamp,direction,data")?;
    for frame in frames {
        let data_str = hex::format_hex(&frame.data);
        let escaped = data_str.replace('"', "\"\"");
        writeln!(&mut w, "{},{},\"{}\"", frame.timestamp, dir_label(&frame.direction), escaped)?;
    }
    Ok(())
}

fn export_bin(frames: &[DataFrame], path: &str) -> Result<(), AppError> {
    let mut w = BufWriter::new(File::create(path)?);
    for frame in frames {
        w.write_all(&frame.data)?;
    }
    Ok(())
}
