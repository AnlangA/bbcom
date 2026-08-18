use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use bbcom_plugin_contracts::Permission;
use wasmtime::component::{Component, HasSelf, Linker};
use wasmtime::{Config, Engine, Store, Trap};

use crate::bindings::{DeclarativePanel, PanelEvent, Plugin};
use crate::host_state::{StoreState, TrackingLimits};
use crate::policy::{AmbientAuthorityPolicy, HostPolicy};
use crate::{ExecutionFailure, ExecutionFailureKind, HostError, Result, TrustedPluginArtifact};

static PROCESS_HAS_STORE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallKind {
    Normal,
    LongRunning,
}

/// Cloneable, store-free interrupt handle. It can safely be owned by the
/// stdin dispatcher while the runtime thread exclusively owns the Store.
#[derive(Clone)]
pub struct RuntimeInterruptHandle {
    engine: Engine,
    cancellation_requested: Arc<AtomicBool>,
}

impl RuntimeInterruptHandle {
    pub fn interrupt(&self) {
        self.cancellation_requested.store(true, Ordering::Release);
        self.engine.increment_epoch();
    }
}

pub struct PluginEngineFactory {
    engine: Engine,
    policy: HostPolicy,
}

impl PluginEngineFactory {
    pub fn new() -> Result<Self> {
        let policy = HostPolicy::fixed();
        let mut config = Config::new();
        config.wasm_component_model(true);
        config.consume_fuel(true);
        config.epoch_interruption(true);
        config.max_wasm_stack(2 * 1024 * 1024);
        config.memory_reservation(policy.wasm_memory_bytes as u64);
        config.memory_guard_size(0);
        config.memory_reservation_for_growth(0);
        let engine = Engine::new(&config).map_err(|_| HostError::EngineConfiguration)?;
        Ok(Self { engine, policy })
    }

    #[must_use]
    pub const fn policy(&self) -> HostPolicy {
        self.policy
    }

    #[must_use]
    pub const fn ambient_authority(&self) -> AmbientAuthorityPolicy {
        AmbientAuthorityPolicy::NONE
    }

    pub fn load(
        &self,
        artifact: &TrustedPluginArtifact,
        granted_permissions: impl IntoIterator<Item = Permission>,
    ) -> Result<PluginRuntime> {
        self.load_with_uplink(artifact, granted_permissions, None)
    }

    /// `load` with a main-process uplink: serial-write proposal decisions and
    /// G43 session/capture data then round-trip to the trusted launcher
    /// instead of resolving from sidecar-local (empty) state.
    pub fn load_with_uplink(
        &self,
        artifact: &TrustedPluginArtifact,
        granted_permissions: impl IntoIterator<Item = Permission>,
        uplink: Option<std::sync::Arc<crate::uplink::Uplink>>,
    ) -> Result<PluginRuntime> {
        let guard = ProcessStoreGuard::acquire()?;
        let component = Component::from_binary(&self.engine, artifact.component_bytes())
            .map_err(|_| HostError::InvalidComponent)?;
        let permissions: BTreeSet<_> = granted_permissions.into_iter().collect();
        let limits = TrackingLimits::fixed(self.policy.wasm_memory_bytes);
        let mut state = StoreState::new(limits, permissions);
        if let Some(uplink) = uplink {
            state = state.with_uplink(uplink);
        }
        let mut store = Store::new(&self.engine, state);
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(self.policy.fuel_per_call)
            .map_err(|_| HostError::EngineConfiguration)?;
        store.epoch_deadline_trap();
        store.set_epoch_deadline(1);

        // Deliberately use an empty Component linker plus only the generated
        // G40 WIT imports. `wasmtime-wasi` is pinned for packaging compatibility
        // but no WASI function is ever linked into this store.
        let mut linker = Linker::new(&self.engine);
        Plugin::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)
            .map_err(|_| HostError::EngineConfiguration)?;
        let bindings = match Plugin::instantiate(&mut store, &component, &linker) {
            Ok(bindings) => bindings,
            Err(_) if store.data().limits.memory_limit_hit() => {
                return Err(ExecutionFailure {
                    kind: ExecutionFailureKind::MemoryLimit,
                }
                .into());
            }
            Err(_) => return Err(HostError::ComponentInstantiation),
        };
        Ok(PluginRuntime {
            engine: self.engine.clone(),
            cancellation_requested: Arc::new(AtomicBool::new(false)),
            policy: self.policy,
            store,
            bindings,
            closed: false,
            _guard: guard,
        })
    }
}

impl Default for PluginEngineFactory {
    fn default() -> Self {
        Self::new().expect("fixed plugin engine policy must be valid")
    }
}

pub struct PluginRuntime {
    engine: Engine,
    cancellation_requested: Arc<AtomicBool>,
    policy: HostPolicy,
    store: Store<StoreState>,
    bindings: Plugin,
    closed: bool,
    _guard: ProcessStoreGuard,
}

impl PluginRuntime {
    pub fn initialize(&mut self) -> Result<()> {
        self.initialize_with_kind(CallKind::Normal)
    }

    pub fn initialize_with_kind(&mut self, kind: CallKind) -> Result<()> {
        self.ensure_open()?;
        let panel = self.execute(kind, |store, bindings| bindings.call_initialize(store))?;
        let panel = panel.map_err(|_| HostError::PluginRejected)?;
        self.store.data_mut().publish_returned_panel(panel);
        Ok(())
    }

    pub fn restore_persisted_state(
        &mut self,
        plugin_storage: &[u8],
        project_state: Option<Vec<u8>>,
    ) -> Result<()> {
        self.ensure_open()?;
        self.store
            .data_mut()
            .restore_persisted_state(plugin_storage, project_state)
            .map_err(|_| HostError::PluginRejected)?;
        Ok(())
    }

    #[must_use]
    pub fn persisted_state(&self) -> (Vec<u8>, Option<Vec<u8>>) {
        self.store.data().persisted_state()
    }

    /// Delivers a declarative-panel event to the plugin and publishes the
    /// returned panel. Mirrors the initialize contract: guest errors surface
    /// as `PluginRejected` without partial state.
    pub fn handle_panel_event(&mut self, event: PanelEvent) -> Result<()> {
        self.ensure_open()?;
        let panel = self.execute(CallKind::Normal, |store, bindings| {
            bindings.call_handle_panel_event(store, &event)
        })?;
        let panel = panel.map_err(|_| HostError::PluginRejected)?;
        self.store.data_mut().publish_returned_panel(panel);
        Ok(())
    }

    /// Drains the most recently published panel for embedders and tests.
    pub fn take_published_panel(&mut self) -> Option<DeclarativePanel> {
        self.store.data_mut().take_published_panel()
    }

    pub fn shutdown(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.execute(CallKind::Normal, |store, bindings| {
            bindings.call_shutdown(store)
        })?;
        self.closed = true;
        Ok(())
    }

    pub fn interrupt(&self) {
        self.cancellation_requested.store(true, Ordering::Release);
        self.engine.increment_epoch();
    }

    pub fn prepare_interruptible_call(&self) {
        self.cancellation_requested.store(false, Ordering::Release);
    }

    #[must_use]
    pub fn interrupt_handle(&self) -> RuntimeInterruptHandle {
        RuntimeInterruptHandle {
            engine: self.engine.clone(),
            cancellation_requested: Arc::clone(&self.cancellation_requested),
        }
    }

    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.closed
    }

    fn execute<T>(
        &mut self,
        kind: CallKind,
        invoke: impl FnOnce(&mut Store<StoreState>, &Plugin) -> wasmtime::Result<T>,
    ) -> Result<T> {
        self.store.data_mut().limits.reset_memory_limit_hit();
        self.store
            .set_fuel(self.policy.fuel_per_call)
            .map_err(|_| HostError::EngineConfiguration)?;
        self.store.set_epoch_deadline(1);
        if self.cancellation_requested.load(Ordering::Acquire) {
            // A cancellation may have arrived after stdin registered the
            // request but before this Store installed its epoch deadline.
            self.engine.increment_epoch();
        }
        let duration = match kind {
            CallKind::Normal => self.policy.call_timeout,
            CallKind::LongRunning => self.policy.long_task_timeout,
        };
        let deadline = DeadlineGuard::arm(self.engine.clone(), duration)?;
        let result = invoke(&mut self.store, &self.bindings);
        let timed_out = deadline.finish();
        self.cancellation_requested.store(false, Ordering::Release);
        match result {
            Ok(value) => Ok(value),
            Err(error) => Err(classify_execution_error(
                &error,
                timed_out,
                self.store.data().limits.memory_limit_hit(),
            )
            .into()),
        }
    }

    fn ensure_open(&self) -> Result<()> {
        if self.closed {
            Err(HostError::Closed)
        } else {
            Ok(())
        }
    }
}

impl Drop for PluginRuntime {
    fn drop(&mut self) {
        if !self.closed {
            // Drop must remain bounded. A cooperative WIT shutdown is attempted
            // by `Sidecar`; abrupt pipe/process termination drops the Store,
            // which releases all component resources without running guest code.
            self.engine.increment_epoch();
            self.closed = true;
        }
    }
}

struct ProcessStoreGuard;

impl ProcessStoreGuard {
    fn acquire() -> Result<Self> {
        PROCESS_HAS_STORE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| HostError::ProcessAlreadyHosting)?;
        Ok(Self)
    }
}

impl Drop for ProcessStoreGuard {
    fn drop(&mut self) {
        PROCESS_HAS_STORE.store(false, Ordering::Release);
    }
}

struct DeadlineGuard {
    state: Arc<(Mutex<bool>, Condvar)>,
    timed_out: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl DeadlineGuard {
    fn arm(engine: Engine, timeout: Duration) -> Result<Self> {
        let state = Arc::new((Mutex::new(false), Condvar::new()));
        let timed_out = Arc::new(AtomicBool::new(false));
        let thread_state = Arc::clone(&state);
        let thread_timed_out = Arc::clone(&timed_out);
        let join = thread::Builder::new()
            .name("bbcom-plugin-deadline".to_owned())
            .spawn(move || {
                let (lock, condition) = &*thread_state;
                let cancelled = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                let (cancelled, wait) = condition
                    .wait_timeout_while(cancelled, timeout, |cancelled| !*cancelled)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if wait.timed_out() && !*cancelled {
                    thread_timed_out.store(true, Ordering::Release);
                    engine.increment_epoch();
                }
            })
            .map_err(|_| HostError::EngineConfiguration)?;
        Ok(Self {
            state,
            timed_out,
            join: Some(join),
        })
    }

    fn finish(mut self) -> bool {
        self.cancel_and_join();
        self.timed_out.load(Ordering::Acquire)
    }

    fn cancel_and_join(&mut self) {
        let (lock, condition) = &*self.state;
        *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        condition.notify_one();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for DeadlineGuard {
    fn drop(&mut self) {
        self.cancel_and_join();
    }
}

fn classify_execution_error(
    error: &wasmtime::Error,
    timed_out: bool,
    memory_limit_hit: bool,
) -> ExecutionFailure {
    let kind = if memory_limit_hit {
        ExecutionFailureKind::MemoryLimit
    } else if timed_out {
        ExecutionFailureKind::Timeout
    } else {
        match error.downcast_ref::<Trap>() {
            Some(Trap::OutOfFuel) => ExecutionFailureKind::FuelExhausted,
            Some(Trap::Interrupt) => ExecutionFailureKind::Timeout,
            _ => ExecutionFailureKind::Trap,
        }
    };
    ExecutionFailure { kind }
}

#[cfg(test)]
mod tests {
    use wasmtime::ResourceLimiter;
    use wasmtime::component::{Component, Linker};

    use super::*;

    #[test]
    fn classifies_trap_fuel_timeout_and_memory_without_exposing_raw_errors() {
        let trap = wasmtime::Error::from(Trap::UnreachableCodeReached);
        assert_eq!(
            classify_execution_error(&trap, false, false).kind,
            ExecutionFailureKind::Trap
        );
        let fuel = wasmtime::Error::from(Trap::OutOfFuel);
        assert_eq!(
            classify_execution_error(&fuel, false, false).kind,
            ExecutionFailureKind::FuelExhausted
        );
        let interrupt = wasmtime::Error::from(Trap::Interrupt);
        assert_eq!(
            classify_execution_error(&interrupt, true, false).kind,
            ExecutionFailureKind::Timeout
        );
        assert_eq!(
            classify_execution_error(&trap, false, true).kind,
            ExecutionFailureKind::MemoryLimit
        );
    }

    #[test]
    fn store_limiter_marks_growth_beyond_exact_memory_cap() {
        let mut limits = TrackingLimits::fixed(bbcom_plugin_contracts::WASM_MEMORY_LIMIT_BYTES);
        assert_eq!(limits.memories(), 1);
        assert_eq!(
            limits.memory_limit_bytes(),
            bbcom_plugin_contracts::WASM_MEMORY_LIMIT_BYTES
        );
        assert!(
            limits
                .memory_growing(0, bbcom_plugin_contracts::WASM_MEMORY_LIMIT_BYTES, None)
                .expect("at limit")
        );
        assert!(
            limits
                .memory_growing(
                    bbcom_plugin_contracts::WASM_MEMORY_LIMIT_BYTES,
                    bbcom_plugin_contracts::WASM_MEMORY_LIMIT_BYTES + 65_536,
                    None
                )
                .is_err()
        );
        assert!(limits.memory_limit_hit());
    }

    #[test]
    fn engine_uses_exact_memory_contract_and_instantiates_a_component() {
        const MEMORY_LIMIT: usize = bbcom_plugin_contracts::WASM_MEMORY_LIMIT_BYTES;

        let factory = PluginEngineFactory::new().expect("engine");
        assert_eq!(factory.policy().wasm_memory_bytes, 64 * 1024 * 1024);
        assert_eq!(factory.policy().wasm_memory_bytes, MEMORY_LIMIT);
        assert_eq!(factory.engine.get_memory_reservation(), MEMORY_LIMIT as u64);
        assert_eq!(factory.engine.get_memory_guard_size(), 0);
        assert_eq!(factory.engine.get_memory_reservation_for_growth(), 0);

        let component_bytes = wat::parse_str("(component)").expect("valid component fixture");
        let component = Component::from_binary(&factory.engine, &component_bytes)
            .expect("component accepted by configured engine");
        let mut store = Store::new(&factory.engine, ());
        Linker::new(&factory.engine)
            .instantiate(&mut store, &component)
            .expect("component instantiated with exact memory configuration");
    }

    #[test]
    fn deadline_is_cancelled_after_fast_call_and_fires_after_timeout() {
        let factory = PluginEngineFactory::new().expect("engine");
        let fast =
            DeadlineGuard::arm(factory.engine.clone(), Duration::from_secs(1)).expect("deadline");
        assert!(!fast.finish());

        let elapsed =
            DeadlineGuard::arm(factory.engine, Duration::from_millis(1)).expect("deadline");
        std::thread::sleep(Duration::from_millis(5));
        assert!(elapsed.finish());
    }
}
