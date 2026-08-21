use std::fmt::Write as _;
use std::sync::{Mutex, MutexGuard};

use crate::utils::window::require_main_window_label;
use bbcom_contracts::{
    AppErrorCode, IpcError, ShutdownCancellation, ShutdownConfirmation, ShutdownDecisionState,
    ShutdownDrainResult, ShutdownState,
};
use tauri::{AppHandle, State, WebviewWindow};

const SUBMIT_OPERATION: &str = "submit_shutdown_report";
const CONFIRM_OPERATION: &str = "confirm_exit";
const CANCEL_OPERATION: &str = "cancel_exit";

#[derive(Default)]
struct ShutdownGateInner {
    active_attempt_id: Option<String>,
    last_result: Option<ShutdownDrainResult>,
    exiting: bool,
}

/// Native authority for the one active prevented-close attempt.
#[derive(Default)]
pub struct ShutdownGate {
    inner: Mutex<ShutdownGateInner>,
}

impl ShutdownGate {
    pub fn begin_close_attempt(&self) -> Result<Option<String>, IpcError> {
        let mut inner = self.lock("shutdown_close_request")?;
        if inner.exiting {
            return Ok(None);
        }
        if let Some(attempt_id) = &inner.active_attempt_id {
            return Ok(Some(attempt_id.clone()));
        }
        let attempt_id = random_attempt_id()?;
        inner.active_attempt_id = Some(attempt_id.clone());
        inner.last_result = None;
        Ok(Some(attempt_id))
    }

    pub fn is_exiting(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.exiting)
            .unwrap_or(false)
    }

    fn submit(&self, result: ShutdownDrainResult) -> Result<(), IpcError> {
        validate_drain_result(&result)?;
        let mut inner = self.lock(SUBMIT_OPERATION)?;
        validate_active_attempt(&inner, &result.attempt_id, SUBMIT_OPERATION)?;
        if let Some(previous) = &inner.last_result
            && result.round < previous.round
        {
            return Err(IpcError::invalid_input(SUBMIT_OPERATION, "round")
                .with_request_id(result.attempt_id));
        }
        inner.last_result = Some(result);
        Ok(())
    }

    fn cancel(&self, cancellation: &ShutdownCancellation) -> Result<(), IpcError> {
        validate_report_attempt(
            &cancellation.attempt_id,
            &cancellation.report.attempt_id,
            CANCEL_OPERATION,
        )?;
        if cancellation.report.state != ShutdownState::Cancelled {
            return Err(IpcError::invalid_input(CANCEL_OPERATION, "report.state")
                .with_request_id(cancellation.attempt_id.clone()));
        }
        let mut inner = self.lock(CANCEL_OPERATION)?;
        validate_active_attempt(&inner, &cancellation.attempt_id, CANCEL_OPERATION)?;
        if inner.last_result.is_none() {
            return Err(IpcError::invalid_input(CANCEL_OPERATION, "result")
                .with_request_id(cancellation.attempt_id.clone()));
        }
        inner.active_attempt_id = None;
        inner.last_result = None;
        Ok(())
    }

    fn confirm(&self, confirmation: &ShutdownConfirmation) -> Result<(), IpcError> {
        validate_report_attempt(
            &confirmation.attempt_id,
            &confirmation.report.attempt_id,
            CONFIRM_OPERATION,
        )?;
        if confirmation.report.state != ShutdownState::Confirmed {
            return Err(IpcError::invalid_input(CONFIRM_OPERATION, "report.state")
                .with_request_id(confirmation.attempt_id.clone()));
        }
        let mut inner = self.lock(CONFIRM_OPERATION)?;
        validate_active_attempt(&inner, &confirmation.attempt_id, CONFIRM_OPERATION)?;
        let result = inner.last_result.as_ref().ok_or_else(|| {
            IpcError::invalid_input(CONFIRM_OPERATION, "result")
                .with_request_id(confirmation.attempt_id.clone())
        })?;
        let valid_decision = matches!(
            (confirmation.forced, result.state),
            (false, ShutdownDecisionState::Ready)
                | (
                    true,
                    ShutdownDecisionState::TimedOut | ShutdownDecisionState::Failed
                )
        );
        if !valid_decision {
            return Err(IpcError::invalid_input(CONFIRM_OPERATION, "forced")
                .with_request_id(confirmation.attempt_id.clone()));
        }
        inner.exiting = true;
        Ok(())
    }

    fn lock(&self, operation: &'static str) -> Result<MutexGuard<'_, ShutdownGateInner>, IpcError> {
        self.inner
            .lock()
            .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, operation))
    }
}

#[tauri::command]
pub fn submit_shutdown_report(
    window: WebviewWindow,
    state: State<'_, ShutdownGate>,
    result: ShutdownDrainResult,
) -> Result<(), IpcError> {
    require_main_window_label(window.label(), SUBMIT_OPERATION)?;
    state.submit(result)
}

#[tauri::command]
pub fn cancel_exit(
    window: WebviewWindow,
    state: State<'_, ShutdownGate>,
    cancellation: ShutdownCancellation,
) -> Result<(), IpcError> {
    require_main_window_label(window.label(), CANCEL_OPERATION)?;
    state.cancel(&cancellation)
}

#[tauri::command]
pub fn confirm_exit(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ShutdownGate>,
    confirmation: ShutdownConfirmation,
) -> Result<(), IpcError> {
    require_main_window_label(window.label(), CONFIRM_OPERATION)?;
    state.confirm(&confirmation)?;
    app.exit(0);
    Ok(())
}

fn validate_active_attempt(
    inner: &ShutdownGateInner,
    attempt_id: &str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if inner.exiting || inner.active_attempt_id.as_deref() != Some(attempt_id) {
        return Err(
            IpcError::invalid_input(operation, "attemptId").with_request_id(attempt_id.to_owned())
        );
    }
    Ok(())
}

fn validate_drain_result(result: &ShutdownDrainResult) -> Result<(), IpcError> {
    validate_attempt_id(&result.attempt_id, SUBMIT_OPERATION)?;
    validate_report_attempt(
        &result.attempt_id,
        &result.report.attempt_id,
        SUBMIT_OPERATION,
    )?;
    let expected_state = match result.state {
        ShutdownDecisionState::Ready => ShutdownState::Ready,
        ShutdownDecisionState::TimedOut => ShutdownState::TimedOut,
        ShutdownDecisionState::Failed => ShutdownState::Failed,
    };
    if result.report.state != expected_state
        || result.needs_decision != (result.state != ShutdownDecisionState::Ready)
        || !result.requires_confirm_exit
    {
        return Err(IpcError::invalid_input(SUBMIT_OPERATION, "state")
            .with_request_id(result.attempt_id.clone()));
    }
    if result.report.participants.len() > 64 {
        return Err(IpcError::invalid_input(SUBMIT_OPERATION, "participants")
            .with_request_id(result.attempt_id.clone()));
    }
    Ok(())
}

fn validate_report_attempt(
    attempt_id: &str,
    report_attempt_id: &str,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_attempt_id(attempt_id, operation)?;
    if report_attempt_id != attempt_id {
        return Err(IpcError::invalid_input(operation, "report.attemptId")
            .with_request_id(attempt_id.to_owned()));
    }
    Ok(())
}

fn validate_attempt_id(attempt_id: &str, operation: &'static str) -> Result<(), IpcError> {
    if attempt_id.len() != 32
        || !attempt_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(IpcError::invalid_input(operation, "attemptId"));
    }
    Ok(())
}

fn random_attempt_id() -> Result<String, IpcError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| {
        IpcError::new(
            AppErrorCode::Busy,
            "error.busy",
            true,
            "shutdown_close_request",
        )
    })?;
    let mut id = String::with_capacity(32);
    for byte in random {
        write!(&mut id, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use bbcom_contracts::{
        ShutdownParticipantMessageKey, ShutdownParticipantReport, ShutdownParticipantStatus,
        ShutdownReport,
    };

    use super::*;

    fn result(attempt_id: &str, state: ShutdownDecisionState) -> ShutdownDrainResult {
        let report_state = match state {
            ShutdownDecisionState::Ready => ShutdownState::Ready,
            ShutdownDecisionState::TimedOut => ShutdownState::TimedOut,
            ShutdownDecisionState::Failed => ShutdownState::Failed,
        };
        ShutdownDrainResult {
            attempt_id: attempt_id.to_owned(),
            round: 0,
            state,
            needs_decision: state != ShutdownDecisionState::Ready,
            requires_confirm_exit: true,
            report: ShutdownReport {
                attempt_id: attempt_id.to_owned(),
                state: report_state,
                elapsed_ms: 1,
                participants: vec![ShutdownParticipantReport {
                    name: "workspace-flush".to_owned(),
                    priority: 100,
                    status: ShutdownParticipantStatus::Completed,
                    elapsed_ms: 1,
                    message_key: ShutdownParticipantMessageKey::Completed,
                }],
            },
        }
    }

    #[test]
    fn gate_reuses_one_attempt_and_requires_matching_ready_confirmation() {
        let gate = ShutdownGate::default();
        let attempt_id = gate.begin_close_attempt().unwrap().unwrap();
        assert_eq!(
            gate.begin_close_attempt().unwrap(),
            Some(attempt_id.clone())
        );
        gate.submit(result(&attempt_id, ShutdownDecisionState::Ready))
            .unwrap();
        let confirmation = ShutdownConfirmation {
            attempt_id: attempt_id.clone(),
            forced: false,
            report: ShutdownReport {
                attempt_id,
                state: ShutdownState::Confirmed,
                elapsed_ms: 2,
                participants: Vec::new(),
            },
        };
        gate.confirm(&confirmation).unwrap();
        assert!(gate.is_exiting());
        assert_eq!(gate.begin_close_attempt().unwrap(), None);
    }

    #[test]
    fn cancel_clears_attempt_while_force_requires_a_non_ready_result() {
        let gate = ShutdownGate::default();
        let first = gate.begin_close_attempt().unwrap().unwrap();
        gate.submit(result(&first, ShutdownDecisionState::TimedOut))
            .unwrap();
        gate.cancel(&ShutdownCancellation {
            attempt_id: first.clone(),
            report: ShutdownReport {
                attempt_id: first,
                state: ShutdownState::Cancelled,
                elapsed_ms: 2,
                participants: Vec::new(),
            },
        })
        .unwrap();
        let second = gate.begin_close_attempt().unwrap().unwrap();
        assert_ne!(second.len(), 0);
        gate.submit(result(&second, ShutdownDecisionState::Ready))
            .unwrap();
        let forced = ShutdownConfirmation {
            attempt_id: second.clone(),
            forced: true,
            report: ShutdownReport {
                attempt_id: second,
                state: ShutdownState::Confirmed,
                elapsed_ms: 2,
                participants: Vec::new(),
            },
        };
        assert!(gate.confirm(&forced).is_err());
    }

    #[test]
    fn drain_result_validation_rejects_malformed_and_inconsistent_reports() {
        let attempt_id = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            validate_attempt_id("invalid", "test").unwrap_err().field,
            Some("attemptId")
        );
        assert!(validate_attempt_id(attempt_id, "test").is_ok());

        let mut mismatched = result(attempt_id, ShutdownDecisionState::Ready);
        mismatched.report.attempt_id = "fedcba9876543210fedcba9876543210".to_owned();
        assert_eq!(
            validate_drain_result(&mismatched).unwrap_err().field,
            Some("report.attemptId")
        );

        let mut wrong_state = result(attempt_id, ShutdownDecisionState::Ready);
        wrong_state.report.state = ShutdownState::Failed;
        assert_eq!(
            validate_drain_result(&wrong_state).unwrap_err().field,
            Some("state")
        );
        let mut wrong_decision = result(attempt_id, ShutdownDecisionState::TimedOut);
        wrong_decision.needs_decision = false;
        assert!(validate_drain_result(&wrong_decision).is_err());
        let mut missing_confirmation = result(attempt_id, ShutdownDecisionState::Failed);
        missing_confirmation.requires_confirm_exit = false;
        assert!(validate_drain_result(&missing_confirmation).is_err());

        let participant = result(attempt_id, ShutdownDecisionState::Ready)
            .report
            .participants
            .pop()
            .expect("participant");
        let mut oversized = result(attempt_id, ShutdownDecisionState::Ready);
        oversized.report.participants = vec![participant; 65];
        assert_eq!(
            validate_drain_result(&oversized).unwrap_err().field,
            Some("participants")
        );
    }

    #[test]
    fn shutdown_gate_rejects_stale_rounds_and_requires_explicit_decisions() {
        let gate = ShutdownGate::default();
        let attempt_id = gate.begin_close_attempt().unwrap().unwrap();
        let cancellation = ShutdownCancellation {
            attempt_id: attempt_id.clone(),
            report: ShutdownReport {
                attempt_id: attempt_id.clone(),
                state: ShutdownState::Cancelled,
                elapsed_ms: 1,
                participants: Vec::new(),
            },
        };
        assert_eq!(
            gate.cancel(&cancellation).unwrap_err().field,
            Some("result")
        );

        let mut later = result(&attempt_id, ShutdownDecisionState::Failed);
        later.round = 2;
        gate.submit(later).expect("submit later round");
        let mut stale = result(&attempt_id, ShutdownDecisionState::Failed);
        stale.round = 1;
        assert_eq!(gate.submit(stale).unwrap_err().field, Some("round"));

        let normal = ShutdownConfirmation {
            attempt_id: attempt_id.clone(),
            forced: false,
            report: ShutdownReport {
                attempt_id: attempt_id.clone(),
                state: ShutdownState::Confirmed,
                elapsed_ms: 2,
                participants: Vec::new(),
            },
        };
        assert_eq!(gate.confirm(&normal).unwrap_err().field, Some("forced"));
        let forced = ShutdownConfirmation {
            forced: true,
            ..normal
        };
        gate.confirm(&forced).expect("force failed shutdown");
        assert!(gate.is_exiting());
        assert!(
            gate.submit(result(&attempt_id, ShutdownDecisionState::Ready))
                .is_err()
        );

        let wrong_report = ShutdownCancellation {
            attempt_id: "0123456789abcdef0123456789abcdef".to_owned(),
            report: ShutdownReport {
                attempt_id: "fedcba9876543210fedcba9876543210".to_owned(),
                state: ShutdownState::Ready,
                elapsed_ms: 1,
                participants: Vec::new(),
            },
        };
        assert_eq!(
            gate.cancel(&wrong_report).unwrap_err().field,
            Some("report.attemptId")
        );
    }
}
