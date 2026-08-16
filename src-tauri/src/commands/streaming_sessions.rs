//! Shared core for the backend-owned streaming session managers.
//!
//! Both the export manager ([`crate::export::session`]) and the auto-log
//! manager ([`crate::commands::log`]) run the same lifecycle: a random
//! 128-bit hex session id, bounded admission through a semaphore, a table of
//! per-session mutexes keyed by id, and a best-effort TTL sweep that never
//! waits behind a session doing disk work. This module owns those mechanics;
//! each manager keeps only its format-, target-, and disposal-specific
//! behavior through the [`StreamingSession`] hooks.

use crate::models::errors::AppError;
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::io::ErrorKind;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, MutexGuard, OwnedSemaphorePermit, Semaphore};

/// One backend-owned streaming session admitted through a
/// [`StreamingSessionTable`].
pub(crate) trait StreamingSession {
    /// Backend-owned resources detached when the session expires. The table
    /// releases them after the identity-checked removal so a manager can
    /// dispose of files while holding no session lock.
    type Detached: Send;

    fn last_activity(&self) -> Instant;

    /// Seal one expired candidate while its lock is held, so an Arc cloned
    /// before the sweep can no longer write through it.
    fn seal_expired(&mut self);

    /// Take the session's writer (and any other disposable resource) out.
    fn detach_expired(&mut self) -> Self::Detached;
}

/// Per-manager naming for session ids and their stable error shapes.
pub(crate) struct StreamingSessionNaming {
    /// Stable IPC error field carrying the session id ("exportId"/"logId").
    pub(crate) id_field: &'static str,
    /// Noun inserted into internal id error prose ("export"/"auto-log").
    pub(crate) noun: &'static str,
    /// Error text used when an id is not a live session anymore.
    pub(crate) unknown_message: &'static str,
}

pub(crate) type SharedStreamingSession<S> = Arc<Mutex<S>>;

/// Bounded table of live streaming sessions.
///
/// Admission is reserved through a semaphore before any side effect, so a
/// burst of begin calls shares one capacity decision instead of racing on a
/// stale map length. Reserved ids guard the setup window between id
/// allocation and insertion.
pub(crate) struct StreamingSessionTable<S> {
    sessions: Mutex<HashMap<String, SharedStreamingSession<S>>>,
    reserved_ids: Mutex<HashSet<String>>,
    slots: Arc<Semaphore>,
    max_active: usize,
    session_ttl: Duration,
    naming: StreamingSessionNaming,
}

impl<S> StreamingSessionTable<S> {
    pub(crate) fn new(
        max_active: usize,
        session_ttl: Duration,
        naming: StreamingSessionNaming,
    ) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            reserved_ids: Mutex::new(HashSet::new()),
            slots: Arc::new(Semaphore::new(max_active)),
            max_active,
            session_ttl,
            naming,
        }
    }

    /// Reserve one admission slot before touching the filesystem, mapping a
    /// full table to the manager's stable limit error.
    pub(crate) fn acquire_slot(&self) -> Result<OwnedSemaphorePermit, AppError> {
        Arc::clone(&self.slots)
            .try_acquire_owned()
            .map_err(|_| limit_error(self.naming.id_field, self.max_active, self.max_active + 1))
    }

    #[cfg(test)]
    pub(crate) fn available_permits(&self) -> usize {
        self.slots.available_permits()
    }

    /// Look up one live session, failing with the manager's stable
    /// unknown-id error.
    pub(crate) async fn get(&self, id: &str) -> Result<SharedStreamingSession<S>, AppError> {
        self.sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| validation_error(self.naming.id_field, self.naming.unknown_message))
    }

    /// Insert a prepared session, returning any replaced entry.
    pub(crate) async fn insert(
        &self,
        id: String,
        session: SharedStreamingSession<S>,
    ) -> Option<SharedStreamingSession<S>> {
        self.sessions.lock().await.insert(id, session)
    }

    /// Remove one session by id.
    pub(crate) async fn remove(&self, id: &str) -> Option<SharedStreamingSession<S>> {
        self.sessions.lock().await.remove(id)
    }

    /// Remove `shared` only while it is still the entry registered under
    /// `id`, leaving a newer replacement untouched.
    pub(crate) async fn remove_current(
        &self,
        id: &str,
        shared: &SharedStreamingSession<S>,
    ) -> bool {
        let mut sessions = self.sessions.lock().await;
        let is_current = sessions
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, shared));
        if is_current {
            sessions.remove(id);
        }
        is_current
    }

    /// Ids and Arcs currently registered; the map lock is released before the
    /// caller observes the snapshot.
    pub(crate) async fn snapshot(&self) -> Vec<(String, SharedStreamingSession<S>)> {
        self.sessions
            .lock()
            .await
            .iter()
            .map(|(id, session)| (id.clone(), Arc::clone(session)))
            .collect()
    }

    #[cfg(test)]
    pub(crate) async fn len(&self) -> usize {
        self.sessions.lock().await.len()
    }

    #[cfg(test)]
    pub(crate) async fn is_empty(&self) -> bool {
        self.sessions.lock().await.is_empty()
    }

    /// Lock the session map directly; tests use this to assert contention
    /// behavior between the map lock and the per-session mutexes.
    #[cfg(test)]
    pub(crate) async fn lock_map(
        &self,
    ) -> MutexGuard<'_, HashMap<String, SharedStreamingSession<S>>> {
        self.sessions.lock().await
    }

    /// Allocate a fresh random id, guarded against re-use while a begin is
    /// still setting its session up.
    pub(crate) async fn reserve_new_id(&self) -> Result<String, AppError> {
        for _ in 0..8 {
            let id = random_session_id_hex(self.naming.noun)?;
            if self.sessions.lock().await.contains_key(&id) {
                continue;
            }
            if self.reserved_ids.lock().await.insert(id.clone()) {
                return Ok(id);
            }
        }
        Err(AppError::IoError {
            message: format!(
                "failed to allocate a unique {} session id",
                self.naming.noun
            ),
            kind: ErrorKind::Other,
        })
    }

    /// Release a reserved id once its session was inserted or setup failed.
    pub(crate) async fn release_reserved(&self, id: &str) {
        self.reserved_ids.lock().await.remove(id);
    }
}

impl<S: StreamingSession> StreamingSessionTable<S> {
    /// Expire one locked candidate: seal it, detach its resources, and remove
    /// it from the table with an identity check. Returns `None` when the
    /// candidate is still fresh; otherwise reports whether the registered
    /// entry was actually this session.
    ///
    /// The caller retains the session lock across the identity-checked
    /// removal: an append that already cloned this Arc must observe the seal
    /// before it can touch the writer, while a newer session reusing the same
    /// id remains untouched.
    pub(crate) async fn expire_locked_candidate(
        &self,
        id: &str,
        shared: &SharedStreamingSession<S>,
        session: &mut MutexGuard<'_, S>,
        now: Instant,
    ) -> Option<(bool, <S as StreamingSession>::Detached)> {
        if now.saturating_duration_since(session.last_activity()) < self.session_ttl {
            return None;
        }
        session.seal_expired();
        let detached = session.detach_expired();
        let removed = self.remove_current(id, shared).await;
        Some((removed, detached))
    }

    /// Best-effort TTL sweep. A session holding its mutex is actively
    /// writing/flushing; it is skipped rather than made to wait behind that
    /// disk I/O and can be reconsidered on the next begin. Detached resources
    /// are returned for manager-specific disposal after the sweep.
    pub(crate) async fn sweep_expired(&self) -> (usize, Vec<<S as StreamingSession>::Detached>) {
        let now = Instant::now();
        let mut count = 0;
        let mut detached = Vec::new();
        for (id, shared) in self.snapshot().await {
            let Ok(mut session) = shared.try_lock() else {
                continue;
            };
            let Some((removed, resources)) = self
                .expire_locked_candidate(&id, &shared, &mut session, now)
                .await
            else {
                continue;
            };
            drop(session);
            if removed {
                count += 1;
            }
            detached.push(resources);
        }
        (count, detached)
    }
}

/// 128 bits of OS randomness as 32 lowercase hex characters.
pub(crate) fn random_session_id_hex(noun: &'static str) -> Result<String, AppError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|error| AppError::IoError {
        message: format!("failed to obtain randomness for {noun} session id: {error}"),
        kind: ErrorKind::Other,
    })?;
    let mut id = String::with_capacity(random.len() * 2);
    for byte in random {
        write!(&mut id, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(id)
}

pub(crate) fn is_lower_hex(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// A session id is exactly 32 lowercase hex characters.
pub(crate) fn validate_hex_session_id(
    id: &str,
    field: &'static str,
    noun: &'static str,
) -> Result<(), AppError> {
    if id.len() != 32 || !is_lower_hex(id, 32) {
        return Err(validation_error(
            field,
            format!("invalid {noun} session id"),
        ));
    }
    Ok(())
}

pub(crate) fn validation_error(field: &str, message: impl Into<String>) -> AppError {
    AppError::ValidationError {
        message: message.into(),
        field: field.to_string(),
    }
}

pub(crate) fn limit_error(field: &str, limit: usize, actual: usize) -> AppError {
    AppError::LimitError {
        message: format!("{field} exceeds its limit"),
        field: field.to_string(),
        limit,
        actual,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Session {
        last_activity: Instant,
        sealed: bool,
    }

    impl StreamingSession for Session {
        type Detached = u32;

        fn last_activity(&self) -> Instant {
            self.last_activity
        }

        fn seal_expired(&mut self) {
            self.sealed = true;
            self.last_activity = Instant::now();
        }

        fn detach_expired(&mut self) -> Self::Detached {
            7
        }
    }

    fn table(ttl: Duration) -> StreamingSessionTable<Session> {
        StreamingSessionTable::new(
            2,
            ttl,
            StreamingSessionNaming {
                id_field: "testId",
                noun: "test",
                unknown_message: "unknown or finished test session",
            },
        )
    }

    #[tokio::test]
    async fn ids_are_random_hex_and_strictly_validated() {
        let first = random_session_id_hex("test").unwrap();
        let second = random_session_id_hex("test").unwrap();
        assert_eq!(first.len(), 32);
        assert_ne!(first, second);
        assert!(validate_hex_session_id(&first, "testId", "test").is_ok());
        assert!(validate_hex_session_id("test-1", "testId", "test").is_err());
        assert!(validate_hex_session_id("A".repeat(32).as_str(), "testId", "test").is_err());
    }

    #[tokio::test]
    async fn admission_capacity_and_reservation_guard_id_reuse() {
        let table = table(Duration::from_secs(60));
        let first = table.reserve_new_id().await.unwrap();
        let second = table.reserve_new_id().await.unwrap();
        assert_ne!(first, second);
        table.release_reserved(&first).await;
        assert_eq!(table.len().await, 0);
        assert!(table.is_empty().await);
    }

    #[tokio::test]
    async fn admission_capacity_bounds_concurrent_sessions() {
        let table = table(Duration::from_secs(60));
        let first = table.acquire_slot().unwrap();
        let second = table.acquire_slot().unwrap();
        let rejected = table.acquire_slot().unwrap_err();
        assert!(matches!(
            rejected,
            AppError::LimitError {
                field,
                limit: 2,
                actual: 3,
                ..
            } if field == "testId"
        ));
        drop(first);
        drop(second);
        assert_eq!(table.available_permits(), 2);
    }

    #[tokio::test]
    async fn sweep_seals_expires_and_skips_fresh_or_busy_sessions() {
        let ttl = Duration::from_secs(60);
        let table = table(ttl);
        let expired = "0".repeat(32);
        let fresh = "1".repeat(32);
        table
            .insert(
                expired.clone(),
                Arc::new(Mutex::new(Session {
                    last_activity: Instant::now() - ttl - Duration::from_secs(1),
                    sealed: false,
                })),
            )
            .await;
        table
            .insert(
                fresh.clone(),
                Arc::new(Mutex::new(Session {
                    last_activity: Instant::now(),
                    sealed: false,
                })),
            )
            .await;

        let busy = table.get(&fresh).await.unwrap();
        let held = busy.lock().await;
        let (count, detached) = table.sweep_expired().await;
        assert_eq!(count, 1);
        assert_eq!(detached, vec![7]);
        assert!(table.get(&expired).await.is_err());
        assert!(table.get(&fresh).await.is_ok());
        drop(held);

        let shared = table.get(&fresh).await.unwrap();
        let mut session = shared.lock().await;
        session.last_activity = Instant::now() - ttl - Duration::from_secs(1);
        assert!(
            table
                .expire_locked_candidate(&fresh, &shared, &mut session, Instant::now())
                .await
                .is_some()
        );
        assert!(session.sealed);
        drop(session);
        assert!(table.get(&fresh).await.is_err());
    }
}
