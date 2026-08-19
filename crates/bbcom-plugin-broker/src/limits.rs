use std::time::Duration;

use bbcom_plugin_contracts::{LONG_TASK_TIMEOUT_MS, MAX_FRAME_BYTES, MAX_QUEUE_BYTES};

use crate::{BrokerError, LimitKind, Result};

/// Protocol-v2 normal calls share the host's two-second deadline. Long-running
/// work is admitted only through the separately bounded task path.
pub const BROKER_NORMAL_TIMEOUT_MS: u64 = 2_000;
pub const BROKER_LONG_TIMEOUT_MS: u64 = LONG_TASK_TIMEOUT_MS;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvocationClass {
    Normal,
    LongRunning,
}

/// Validate an already-framed request and its destination queue before it is
/// admitted. Values are rejected as a whole; this function never truncates.
pub fn validate_invocation(
    frame_bytes: usize,
    queued_bytes_after_admission: usize,
    class: InvocationClass,
    timeout: Duration,
) -> Result<()> {
    if frame_bytes == 0 || frame_bytes > MAX_FRAME_BYTES {
        return Err(BrokerError::InvocationLimit(LimitKind::FrameBytes));
    }
    if queued_bytes_after_admission > MAX_QUEUE_BYTES {
        return Err(BrokerError::InvocationLimit(LimitKind::QueueBytes));
    }
    let maximum = match class {
        InvocationClass::Normal => Duration::from_millis(BROKER_NORMAL_TIMEOUT_MS),
        InvocationClass::LongRunning => Duration::from_millis(BROKER_LONG_TIMEOUT_MS),
    };
    if timeout.is_zero() || timeout > maximum {
        return Err(BrokerError::InvocationTimeoutInvalid);
    }
    Ok(())
}
