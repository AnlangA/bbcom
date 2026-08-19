use std::time::Duration;

use bbcom_plugin_broker::{
    BROKER_LONG_TIMEOUT_MS, BROKER_NORMAL_TIMEOUT_MS, InvocationClass, validate_invocation,
};
use bbcom_plugin_contracts::{MAX_FRAME_BYTES, MAX_QUEUE_BYTES};

#[test]
fn protocol_v2_invocation_limits_remain_bounded() {
    const {
        assert!(BROKER_NORMAL_TIMEOUT_MS == 2_000);
        assert!(BROKER_LONG_TIMEOUT_MS >= BROKER_NORMAL_TIMEOUT_MS);
    }
    assert!(
        validate_invocation(
            MAX_FRAME_BYTES,
            MAX_QUEUE_BYTES,
            InvocationClass::Normal,
            Duration::from_millis(BROKER_NORMAL_TIMEOUT_MS),
        )
        .is_ok()
    );
}
