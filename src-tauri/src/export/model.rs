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
