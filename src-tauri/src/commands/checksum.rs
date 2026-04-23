use crate::models::checksum_type::ChecksumType;
use crate::models::errors::AppError;
use crate::utils::checksum;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ChecksumRequest {
    pub data: Vec<u8>,
    pub algorithm: ChecksumType,
}

#[derive(Debug, Serialize)]
pub struct ChecksumResponse {
    pub result: String,
}

#[tauri::command]
pub fn calculate_checksum(request: ChecksumRequest) -> Result<ChecksumResponse, AppError> {
    let result = match request.algorithm {
        ChecksumType::Checksum => checksum::calculate_checksum(&request.data),
        ChecksumType::Crc8 => checksum::calculate_crc8(&request.data),
        ChecksumType::Crc16 => checksum::calculate_crc16(&request.data),
        ChecksumType::Crc32 => checksum::calculate_crc32(&request.data),
    };
    Ok(ChecksumResponse { result })
}
