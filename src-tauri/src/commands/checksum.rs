use crate::models::errors::AppError;
use crate::utils::checksum;
use bbcom_contracts::MAX_CHECKSUM_DATA_BYTES as MAX_CHECKSUM_DATA;
pub use bbcom_contracts::{ChecksumRequest, ChecksumResponse, ChecksumType};
use bbcom_contracts::{DataB64Error, decode_data_b64};

#[tauri::command]
pub fn calculate_checksum(mut request: ChecksumRequest) -> Result<ChecksumResponse, AppError> {
    let data = resolve_request_data(&mut request)?;
    if data.len() > MAX_CHECKSUM_DATA {
        return Err(AppError::ValidationError {
            message: format!(
                "data too large: {} bytes (max {})",
                data.len(),
                MAX_CHECKSUM_DATA
            ),
            field: "data".to_string(),
        });
    }

    let result = match request.algorithm {
        ChecksumType::Checksum => checksum::calculate_checksum(&data),
        ChecksumType::Crc8 => checksum::calculate_crc8(&data),
        ChecksumType::Crc16 => checksum::calculate_crc16(&data),
        ChecksumType::Crc16Modbus => checksum::calculate_crc16_modbus(&data),
        ChecksumType::Crc32 => checksum::calculate_crc32(&data),
    };
    Ok(ChecksumResponse { result })
}

/// Materialize the checksum input from the `dataB64` channel (if used). The
/// byte limit is enforced before the payload is decoded, so an oversized
/// request is rejected without allocating its buffer.
fn resolve_request_data(request: &mut ChecksumRequest) -> Result<Vec<u8>, AppError> {
    let Some(encoded) = request.data_b64.take() else {
        return Ok(std::mem::take(&mut request.data));
    };
    if !request.data.is_empty() {
        return Err(AppError::ValidationError {
            message: "exactly one of data and dataB64 must carry the payload".to_string(),
            field: "data".to_string(),
        });
    }
    decode_data_b64(&encoded, MAX_CHECKSUM_DATA).map_err(|error| match error {
        DataB64Error::LimitExceeded { limit, actual } => AppError::ValidationError {
            message: format!("data too large: {actual} bytes (max {limit})"),
            field: "data".to_string(),
        },
        DataB64Error::BothChannels | DataB64Error::InvalidBase64 => AppError::ValidationError {
            message: error.to_string(),
            field: "data".to_string(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bbcom_contracts::encode_data_b64;

    fn req(algo: ChecksumType, data: &[u8]) -> ChecksumRequest {
        ChecksumRequest {
            data: data.to_vec(),
            data_b64: None,
            algorithm: algo,
        }
    }

    fn req_b64(algo: ChecksumType, data: &[u8]) -> ChecksumRequest {
        ChecksumRequest {
            data: Vec::new(),
            data_b64: Some(encode_data_b64(data)),
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
            calculate_checksum(req(ChecksumType::Crc16Modbus, b"123456789"))
                .unwrap()
                .result,
            "374B"
        );
        assert_eq!(
            calculate_checksum(req(ChecksumType::Crc32, b"123456789"))
                .unwrap()
                .result,
            "CBF43926"
        );
    }

    #[test]
    fn base64_channel_matches_the_number_array_channel() {
        assert_eq!(
            calculate_checksum(req_b64(ChecksumType::Crc16, b"123456789"))
                .unwrap()
                .result,
            "906E"
        );
        assert_eq!(
            calculate_checksum(req_b64(ChecksumType::Checksum, &[]))
                .unwrap()
                .result,
            "00"
        );
    }

    #[test]
    fn rejects_payloads_using_both_channels_or_malformed_base64() {
        let mut both = req_b64(ChecksumType::Crc32, &[1]);
        both.data = vec![1];
        assert!(matches!(
            calculate_checksum(both).unwrap_err(),
            AppError::ValidationError { field, .. } if field == "data"
        ));
        let malformed = ChecksumRequest {
            data: Vec::new(),
            data_b64: Some("not base64!".to_string()),
            algorithm: ChecksumType::Crc32,
        };
        assert!(matches!(
            calculate_checksum(malformed).unwrap_err(),
            AppError::ValidationError { field, .. } if field == "data"
        ));
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
    fn accepts_base64_data_at_exactly_the_limit() {
        // Boundary: the pre-decode length check must not reject an at-limit
        // payload arriving over the base64 channel.
        let resp = calculate_checksum(req_b64(
            ChecksumType::Checksum,
            &vec![0u8; MAX_CHECKSUM_DATA],
        ))
        .unwrap();
        assert_eq!(resp.result, "00");
    }

    #[test]
    fn rejects_oversized_base64_before_decoding() {
        let err = calculate_checksum(req_b64(
            ChecksumType::Crc32,
            &vec![0u8; MAX_CHECKSUM_DATA + 1],
        ))
        .unwrap_err();
        assert!(matches!(
            err,
            AppError::ValidationError { message, field } if field == "data" && message.contains("too large")
        ));
    }

    #[test]
    fn handles_empty_data() {
        let resp = calculate_checksum(req(ChecksumType::Checksum, &[])).unwrap();
        assert_eq!(resp.result, "00");
    }
}
