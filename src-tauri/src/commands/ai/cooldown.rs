//! Rate-limit guard for AI requests. A single global cooldown prevents a user
//! (or a runaway client loop) from spamming the Z.ai endpoint. The mutex holds
//! the instant of the last accepted request; callers acquire it before any
//! network work so validation failures short-circuit without consuming budget.

use std::sync::LazyLock;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::models::errors::AppError;

/// Cooldown window between accepted AI requests. Tuned so a human typing
/// follow-ups is never throttled, but a tight retry loop is.
pub(crate) const AI_COOLDOWN_SECS: u64 = 2;

static LAST_AI_REQUEST: LazyLock<Mutex<std::time::Instant>> = LazyLock::new(|| {
    Mutex::new(std::time::Instant::now() - Duration::from_secs(AI_COOLDOWN_SECS + 1))
});

/// Returns `Ok(())` if enough time has passed since the last accepted request,
/// recording the attempt; otherwise returns an `AppError::AiError` describing
/// the remaining wait. Holds the lock only for the duration of the check — it
/// does NOT cover the network call, so a slow request does not stall other
/// callers.
pub(crate) async fn enforce_ai_cooldown() -> Result<(), AppError> {
    let mut last = LAST_AI_REQUEST.lock().await;
    let elapsed = last.elapsed();
    if elapsed < Duration::from_secs(AI_COOLDOWN_SECS) {
        let remaining = Duration::from_secs(AI_COOLDOWN_SECS) - elapsed;
        tracing::debug!(
            "AI request rate-limited; {:.1}s of cooldown remaining",
            remaining.as_secs_f64()
        );
        return Err(AppError::AiError {
            message: format!("请求过于频繁，请等待 {} 秒后重试", remaining.as_secs() + 1),
        });
    }
    *last = std::time::Instant::now();
    Ok(())
}
