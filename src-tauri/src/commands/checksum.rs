use crate::models::checksum_type::ChecksumType;
use crate::models::errors::AppError;
use crate::utils::checksum;
use serde::{Deserialize, Serialize};

const MAX_CHECKSUM_DATA: usize = 1_048_576;

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
    if request.data.len() > MAX_CHECKSUM_DATA {
        return Err(AppError::ValidationError {
            message: format!(
                "data too large: {} bytes (max {})",
                request.data.len(),
                MAX_CHECKSUM_DATA
            ),
            field: "data".to_string(),
        });
    }

    let result = match request.algorithm {
        ChecksumType::Checksum => checksum::calculate_checksum(&request.data),
        ChecksumType::Crc8 => checksum::calculate_crc8(&request.data),
        ChecksumType::Crc16 => checksum::calculate_crc16(&request.data),
        ChecksumType::Crc32 => checksum::calculate_crc32(&request.data),
    };
    Ok(ChecksumResponse { result })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(algo: ChecksumType, data: &[u8]) -> ChecksumRequest {
        ChecksumRequest {
            data: data.to_vec(),
            algorithm: algo,
        }
    }

    #[test]
    fn dispatches_each_algorithm_correctly() {
        assert_eq!(
            calculate_checksum(req(ChecksumType::Checksum, &[0x01, 0x02, 0x03]))
                .unwrap()
                .result,
            "06"
        );
        assert_eq!(
            calculate_checksum(req(ChecksumType::Crc8, &[0x31, 0x32, 0x33]))
                .unwrap()
                .result,
            "C0"
        );
        assert_eq!(
            calculate_checksum(req(ChecksumType::Crc16, b"123456789"))
                .unwrap()
                .result,
            "906E"
        );
        assert_eq!(
            calculate_checksum(req(ChecksumType::Crc32, b"123456789"))
                .unwrap()
                .result,
            "CBF43926"
        );
    }

    #[test]
    fn rejects_oversized_data() {
        let err = calculate_checksum(req(ChecksumType::Crc32, &vec![0u8; MAX_CHECKSUM_DATA + 1]))
            .unwrap_err();
        assert!(matches!(
            err,
            AppError::ValidationError { field, .. } if field == "data"
        ));
    }

    #[test]
    fn accepts_data_at_exactly_the_limit() {
        // Boundary: exactly MAX_CHECKSUM_DATA bytes must be accepted, not rejected.
        let resp =
            calculate_checksum(req(ChecksumType::Checksum, &vec![0u8; MAX_CHECKSUM_DATA])).unwrap();
        assert_eq!(resp.result, "00");
    }

    #[test]
    fn handles_empty_data() {
        let resp = calculate_checksum(req(ChecksumType::Checksum, &[])).unwrap();
        assert_eq!(resp.result, "00");
    }
}
