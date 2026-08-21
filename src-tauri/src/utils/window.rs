//! Shared main-window identity for the command boundary guards.

use crate::models::ipc_error::IpcError;

/// Label of the one webview window trusted with native authority (file
/// grants, workspaces, settings, shutdown).
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

/// Reject any caller that is not the main window before it reaches a
/// manager, mapping to the stable security denial for the operation.
pub(crate) fn require_main_window_label(
    label: &str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if label == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err(IpcError::security_denied(operation))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ipc_error::AppErrorCode;

    #[test]
    fn only_the_main_window_label_is_accepted() {
        assert!(require_main_window_label(MAIN_WINDOW_LABEL, "test").is_ok());
        for denied in ["ai-assistant", "untrusted", ""] {
            let error = require_main_window_label(denied, "test").unwrap_err();
            assert_eq!(error.code, AppErrorCode::SecurityDenied);
            assert_eq!(error.operation, "test");
        }
    }
}
