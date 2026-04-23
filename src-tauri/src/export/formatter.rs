use crate::models::data_frame::{DataFrame, Direction};
use crate::models::errors::AppError;
use crate::utils::hex;
use tokio::fs::File;
use tokio::io::{AsyncWriteExt, BufWriter};

pub async fn export(frames: &[DataFrame], format: &str, path: &str) -> Result<(), AppError> {
    match format {
        "txt" | "txt-hex" => export_text(frames, path, false).await,
        "txt-ascii" => export_text(frames, path, true).await,
        "csv" => export_csv(frames, path).await,
        "bin" => export_bin(frames, path).await,
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

async fn export_text(frames: &[DataFrame], path: &str, ascii: bool) -> Result<(), AppError> {
    let file = File::create(path).await.map_err(AppError::from)?;
    let mut w = BufWriter::new(file);
    for frame in frames {
        let data_str = data_to_string(&frame.data, ascii);
        let line = format!("[{}] {} | {}\n", frame.timestamp, dir_label(&frame.direction), data_str);
        w.write_all(line.as_bytes()).await.map_err(AppError::from)?;
    }
    w.flush().await.map_err(AppError::from)?;
    Ok(())
}

async fn export_csv(frames: &[DataFrame], path: &str) -> Result<(), AppError> {
    let file = File::create(path).await.map_err(AppError::from)?;
    let mut w = BufWriter::new(file);
    w.write_all(b"timestamp,direction,data\n").await.map_err(AppError::from)?;
    for frame in frames {
        let data_str = hex::format_hex(&frame.data);
        let escaped = data_str.replace('"', "\"\"");
        let line = format!("{},{},\"{}\"\n", frame.timestamp, dir_label(&frame.direction), escaped);
        w.write_all(line.as_bytes()).await.map_err(AppError::from)?;
    }
    w.flush().await.map_err(AppError::from)?;
    Ok(())
}

async fn export_bin(frames: &[DataFrame], path: &str) -> Result<(), AppError> {
    let file = File::create(path).await.map_err(AppError::from)?;
    let mut w = BufWriter::new(file);
    for frame in frames {
        w.write_all(&frame.data).await.map_err(AppError::from)?;
    }
    w.flush().await.map_err(AppError::from)?;
    Ok(())
}
