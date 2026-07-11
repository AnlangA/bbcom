use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExportFormat {
    #[serde(alias = "txt")]
    TxtHex,
    TxtAscii,
    Csv,
    Jsonl,
    Bin,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::TxtHex | Self::TxtAscii => "txt",
            Self::Csv => "csv",
            Self::Jsonl => "jsonl",
            Self::Bin => "bin",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::TxtHex | Self::TxtAscii => "txt",
            Self::Csv => "csv",
            Self::Jsonl => "jsonl",
            Self::Bin => "bin",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_export_format_has_a_fixed_extension_label_and_wire_value() {
        let cases = [
            (ExportFormat::TxtHex, "txt-hex", "txt", "txt"),
            (ExportFormat::TxtAscii, "txt-ascii", "txt", "txt"),
            (ExportFormat::Csv, "csv", "csv", "csv"),
            (ExportFormat::Jsonl, "jsonl", "jsonl", "jsonl"),
            (ExportFormat::Bin, "bin", "bin", "bin"),
        ];
        for (format, wire, extension, label) in cases {
            assert_eq!(
                serde_json::to_string(&format).unwrap(),
                format!("\"{wire}\"")
            );
            assert_eq!(format.extension(), extension);
            assert_eq!(format.label(), label);
        }
        assert_eq!(
            serde_json::from_str::<ExportFormat>("\"txt\"").unwrap(),
            ExportFormat::TxtHex
        );
    }
}
