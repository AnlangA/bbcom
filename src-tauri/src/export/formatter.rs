use crate::export::ExportFormat;
use crate::models::data_frame::{DataFrame, Direction};
use crate::models::errors::AppError;
use crate::utils::hex;
use crate::utils::timestamp;
use std::io::Write as _;

pub(crate) fn append_header(buf: &mut Vec<u8>, format: ExportFormat) {
    if format == ExportFormat::Csv {
        buf.extend_from_slice(b"timestamp,direction,data\n");
    }
}

/// Encode a bounded frame chunk into `buf`. Callers control chunk size so
/// formatter memory is proportional to one batch rather than the full export.
pub(crate) fn append_frames(
    buf: &mut Vec<u8>,
    frames: &[DataFrame],
    format: ExportFormat,
    path: &str,
) -> Result<(), AppError> {
    for frame in frames {
        match format {
            ExportFormat::Jsonl => {
                serde_json::to_writer(&mut *buf, frame).map_err(|e| AppError::ExportError {
                    message: e.to_string(),
                    format: format.label().to_string(),
                    path: path.to_string(),
                    kind: std::io::ErrorKind::InvalidData,
                })?;
                buf.push(b'\n');
            }
            ExportFormat::TxtHex | ExportFormat::TxtAscii => {
                writeln!(
                    buf,
                    "[{}] {} | {}",
                    timestamp::format_timestamp(frame.timestamp),
                    dir_label(&frame.direction),
                    data_to_string(&frame.data, format == ExportFormat::TxtAscii)
                )
                .map_err(|e| encode_error(e, format, path))?;
            }
            ExportFormat::Csv => {
                writeln!(
                    buf,
                    "{},{},\"{}\"",
                    timestamp::format_timestamp(frame.timestamp),
                    dir_label(&frame.direction),
                    hex::format_hex(&frame.data)
                )
                .map_err(|e| encode_error(e, format, path))?;
            }
            ExportFormat::Bin => buf.extend_from_slice(&frame.data),
        }
    }
    Ok(())
}

fn encode_error(error: std::io::Error, format: ExportFormat, path: &str) -> AppError {
    AppError::ExportError {
        message: error.to_string(),
        format: format.label().to_string(),
        path: path.to_string(),
        kind: error.kind(),
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

#[cfg(test)]
mod tests {
    use super::*;

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

    fn encoded(format: ExportFormat) -> Vec<u8> {
        let mut output = Vec::new();
        append_header(&mut output, format);
        append_frames(&mut output, &frames(), format, "backend-owned-target").unwrap();
        output
    }

    #[test]
    fn exports_txt_hex() {
        let content = String::from_utf8(encoded(ExportFormat::TxtHex)).unwrap();

        assert!(content.contains("TX | 41 42"));
        assert!(content.contains("RX | 43 44"));
    }

    #[test]
    fn exports_txt_ascii() {
        let content = String::from_utf8(encoded(ExportFormat::TxtAscii)).unwrap();

        // 0x41/0x42 = "AB", 0x43/0x44 = "CD" — ASCII payload, not hex pairs
        assert!(content.contains("TX | AB"));
        assert!(content.contains("RX | CD"));
        assert!(!content.contains("TX | 41 42"));
    }

    #[test]
    fn exports_csv() {
        let content = String::from_utf8(encoded(ExportFormat::Csv)).unwrap();

        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "timestamp,direction,data");
        assert!(lines[1].ends_with(",TX,\"41 42\""));
        assert!(lines[2].ends_with(",RX,\"43 44\""));

        let error = encode_error(
            std::io::Error::new(std::io::ErrorKind::StorageFull, "writer full"),
            ExportFormat::Csv,
            "backend-owned-target",
        );
        assert!(matches!(
            error,
            AppError::ExportError {
                format,
                path,
                kind: std::io::ErrorKind::StorageFull,
                ..
            } if format == "csv" && path == "backend-owned-target"
        ));
    }

    #[test]
    fn exports_jsonl_with_uppercase_direction() {
        let content = String::from_utf8(encoded(ExportFormat::Jsonl)).unwrap();

        assert!(content.contains("\"direction\":\"TX\""));
        assert!(content.contains("\"direction\":\"RX\""));
    }

    #[test]
    fn exports_bin_concatenated_payloads() {
        let content = encoded(ExportFormat::Bin);

        assert_eq!(content, vec![0x41, 0x42, 0x43, 0x44]);
    }
}

#[cfg(test)]
mod ipc_sim_tests {
    use crate::commands::export::{AppendExportBatchRequest, BeginExportRequest};
    use crate::commands::file_grants::{FileGrantManager, SaveTargetPurpose};
    use crate::export::session::ExportSessionManager;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SIM_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn frontend_begin_payload(format: &str, token: &str) -> String {
        serde_json::json!({
            "format": format,
            "token": token,
            "expectedFrames": 1,
            "expectedRawBytes": 5
        })
        .to_string()
    }

    // Tauri's IPC serializer converts the Uint8Array to a JSON array via Array.from.
    // "Hello" -> [72,101,108,108,111].
    fn frontend_append_payload(export_id: &str) -> String {
        serde_json::json!({
            "exportId": export_id,
            "frames": [{
                "id": "1",
                "direction": "TX",
                "timestamp": 0.0,
                "data": [72, 101, 108, 108, 111]
            }]
        })
        .to_string()
    }

    async fn run_frontend_export(format: &str, ext: &str) -> Vec<u8> {
        let mut path = std::env::temp_dir();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let c = SIM_COUNTER.fetch_add(1, Ordering::Relaxed);
        path.push(format!("bbcom-ipc-sim-{nanos}-{c}.{ext}"));
        let purpose = match format {
            "txt-hex" => SaveTargetPurpose::ExportTxtHex,
            "txt-ascii" => SaveTargetPurpose::ExportTxtAscii,
            "csv" => SaveTargetPurpose::ExportCsv,
            "jsonl" => SaveTargetPurpose::ExportJsonl,
            "bin" => SaveTargetPurpose::ExportBin,
            other => panic!("unsupported test export format: {other}"),
        };
        let grants = FileGrantManager::default();
        let token = grants.issue(purpose, path.clone()).await.unwrap();

        let begin: BeginExportRequest =
            serde_json::from_str(&frontend_begin_payload(format, &token))
                .expect("begin payload must deserialize");
        let target = grants
            .consume_export(&begin.token, begin.format)
            .await
            .unwrap();
        let manager = ExportSessionManager::default();
        let export_id = manager.begin(begin.format, target).await.unwrap();
        let append: AppendExportBatchRequest =
            serde_json::from_str(&frontend_append_payload(&export_id))
                .expect("append payload must deserialize");
        manager
            .append(&append.export_id, &append.frames)
            .await
            .unwrap();
        manager.finish(&export_id).await.unwrap();
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
