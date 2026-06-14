use crate::commands::export::ExportFormat;
use crate::models::data_frame::{DataFrame, Direction};
use crate::models::errors::AppError;
use crate::utils::hex;
use crate::utils::timestamp;
use tokio::fs::File;
use tokio::io::{AsyncWriteExt, BufWriter};

pub async fn export(
    frames: &[DataFrame],
    format: &ExportFormat,
    path: &str,
) -> Result<(), AppError> {
    match format {
        ExportFormat::TxtHex => export_text(frames, path, false).await,
        ExportFormat::TxtAscii => export_text(frames, path, true).await,
        ExportFormat::Csv => export_csv(frames, path).await,
        ExportFormat::Jsonl => export_jsonl(frames, path).await,
        ExportFormat::Bin => export_bin(frames, path).await,
    }
}

async fn export_jsonl(frames: &[DataFrame], path: &str) -> Result<(), AppError> {
    let file = File::create(path).await.map_err(AppError::from)?;
    let mut w = BufWriter::new(file);
    for frame in frames {
        let line = serde_json::to_string(frame).map_err(|e| AppError::ExportError {
            message: e.to_string(),
            format: "jsonl".to_string(),
            path: path.to_string(),
        })?;
        w.write_all(line.as_bytes()).await.map_err(AppError::from)?;
        w.write_all(b"\n").await.map_err(AppError::from)?;
    }
    w.flush().await.map_err(AppError::from)?;
    Ok(())
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
        let line = format!(
            "[{}] {} | {}\n",
            timestamp::format_timestamp(frame.timestamp),
            dir_label(&frame.direction),
            data_str
        );
        w.write_all(line.as_bytes()).await.map_err(AppError::from)?;
    }
    w.flush().await.map_err(AppError::from)?;
    Ok(())
}

async fn export_csv(frames: &[DataFrame], path: &str) -> Result<(), AppError> {
    let file = File::create(path).await.map_err(AppError::from)?;
    let mut w = BufWriter::new(file);
    w.write_all(b"timestamp,direction,data\n")
        .await
        .map_err(AppError::from)?;
    for frame in frames {
        let data_str = hex::format_hex(&frame.data);
        let escaped = data_str.replace('"', "\"\"");
        let line = format!(
            "{},{},\"{}\"\n",
            timestamp::format_timestamp(frame.timestamp),
            dir_label(&frame.direction),
            escaped
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    // Monotonic counter guarantees unique temp paths even when two parallel tests
    // sample the same nanosecond timestamp (e.g. exports_txt_hex / exports_txt_ascii).
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn frames() -> Vec<DataFrame> {
        vec![
            DataFrame {
                id: "1".to_string(),
                direction: Direction::Tx,
                timestamp: 0.0,
                data: vec![0x41, 0x42],
            },
            DataFrame {
                id: "2".to_string(),
                direction: Direction::Rx,
                timestamp: 1.0,
                data: vec![0x43, 0x44],
            },
        ]
    }

    fn temp_path(ext: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        path.push(format!(
            "bbcom-export-{}-{nanos}-{counter}.{ext}",
            std::process::id()
        ));
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn exports_txt_hex() {
        let path = temp_path("txt");
        export(&frames(), &ExportFormat::TxtHex, &path)
            .await
            .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).ok();

        assert!(content.contains("TX | 41 42"));
        assert!(content.contains("RX | 43 44"));
    }

    #[tokio::test]
    async fn exports_txt_ascii() {
        let path = temp_path("txt");
        export(&frames(), &ExportFormat::TxtAscii, &path)
            .await
            .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).ok();

        // 0x41/0x42 = "AB", 0x43/0x44 = "CD" — ASCII payload, not hex pairs
        assert!(content.contains("TX | AB"));
        assert!(content.contains("RX | CD"));
        assert!(!content.contains("TX | 41 42"));
    }

    #[tokio::test]
    async fn exports_csv() {
        let path = temp_path("csv");
        export(&frames(), &ExportFormat::Csv, &path).await.unwrap();
        let content = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).ok();

        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "timestamp,direction,data");
        assert!(lines[1].ends_with(",TX,\"41 42\""));
        assert!(lines[2].ends_with(",RX,\"43 44\""));
    }

    #[tokio::test]
    async fn exports_jsonl_with_uppercase_direction() {
        let path = temp_path("jsonl");
        export(&frames(), &ExportFormat::Jsonl, &path)
            .await
            .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).ok();

        assert!(content.contains("\"direction\":\"TX\""));
        assert!(content.contains("\"direction\":\"RX\""));
    }

    #[tokio::test]
    async fn exports_bin_concatenated_payloads() {
        let path = temp_path("bin");
        export(&frames(), &ExportFormat::Bin, &path).await.unwrap();
        let content = fs::read(&path).unwrap();
        fs::remove_file(&path).ok();

        assert_eq!(content, vec![0x41, 0x42, 0x43, 0x44]);
    }
}

#[cfg(test)]
mod ipc_sim_tests {
    use crate::commands::export::ExportRequest;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SIM_COUNTER: AtomicU64 = AtomicU64::new(0);

    // EXACT JSON the frontend sends via invoke('export_data', { request: {...} }).
    // Tauri's IPC serializer converts the Uint8Array to a JSON array via Array.from.
    // "Hello" -> [72,101,108,108,111].
    fn frontend_payload(format: &str, path: &str) -> String {
        let data = r#"[{"id":"1","direction":"TX","timestamp":0.0,"data":[72,101,108,108,111]}]"#;
        format!(r#"{{"frames":{data},"format":"{format}","path":"{path}"}}"#)
    }

    async fn run_frontend_export(format: &str, ext: &str) -> Vec<u8> {
        let mut path = std::env::temp_dir();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let c = SIM_COUNTER.fetch_add(1, Ordering::Relaxed);
        path.push(format!("bbcom-ipc-sim-{nanos}-{c}.{ext}"));
        let path_str = path.to_string_lossy().to_string();

        let json = frontend_payload(format, &path_str);
        let req: ExportRequest = serde_json::from_str(&json).expect("IPC payload must deserialize");
        super::export(&req.frames, &req.format, &path_str)
            .await
            .unwrap();
        let bytes = fs::read(&path).unwrap();
        fs::remove_file(&path).ok();
        bytes
    }

    #[tokio::test]
    async fn txt_hex_is_not_raw_binary() {
        let bytes = run_frontend_export("txt-hex", "txt").await;
        let s = String::from_utf8(bytes.clone()).unwrap();
        // TXT-HEX must contain hex pairs, NOT the raw "Hello" bytes.
        assert!(s.contains("48 65 6C 6C 6F"), "got: {s}");
        assert!(!s.contains("Hello"), "raw text leaked into hex export: {s}");
    }

    #[tokio::test]
    async fn txt_ascii_is_decoded_text() {
        let bytes = run_frontend_export("txt-ascii", "txt").await;
        let s = String::from_utf8(bytes).unwrap();
        // TXT-ASCII must decode the bytes back to readable "Hello".
        assert!(s.contains("Hello"), "expected decoded text, got: {s}");
    }

    #[tokio::test]
    async fn bin_is_raw_bytes() {
        let bytes = run_frontend_export("bin", "bin").await;
        // BIN is the ONLY format that should be raw bytes.
        assert_eq!(bytes, vec![b'H', b'e', b'l', b'l', b'o']);
    }
}
