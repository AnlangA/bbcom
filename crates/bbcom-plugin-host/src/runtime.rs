use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use bbcom_plugin_contracts::generated_v2::Capability;
use wasmtime::component::{Component, HasSelf, Linker};
use wasmtime::{Config, Engine, Store, Trap};

use crate::authorization::{
    DenyAuthorization, PluginAuthorizationGate, PluginLaunchContext, authorization_request,
};
use crate::bindings::Plugin;
use crate::bindings::bbcom::plugin::types as wit;
use crate::host_state::{ActivityTracker, RuntimeBinding, StoreState, TrackingLimits};
use crate::policy::{AmbientAuthorityPolicy, HostPolicy};
use crate::uplink::CapabilityRpc;
use crate::{ExecutionFailure, ExecutionFailureKind, HostError, Result, TrustedPluginArtifact};

static PROCESS_HAS_STORE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallKind {
    Initialize,
    Normal,
    LongRunning,
}

#[derive(Clone)]
pub struct RuntimeInterruptHandle {
    engine: Engine,
    cancellation_requested: Arc<AtomicBool>,
    rpc: Arc<CapabilityRpc>,
}

impl RuntimeInterruptHandle {
    pub fn interrupt(&self) {
        self.cancellation_requested.store(true, Ordering::Release);
        self.rpc.cancel_all();
        self.engine.increment_epoch();
    }
}

pub struct PluginEngineFactory {
    pub(crate) engine: Engine,
    policy: HostPolicy,
    authorization: Arc<dyn PluginAuthorizationGate>,
}

impl PluginEngineFactory {
    pub fn new() -> Result<Self> {
        Self::with_authorization_gate(Arc::new(DenyAuthorization))
    }

    pub fn with_authorization_gate(
        authorization: Arc<dyn PluginAuthorizationGate>,
    ) -> Result<Self> {
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
        Ok(Self {
            engine,
            policy,
            authorization,
        })
    }

    #[must_use]
    pub const fn policy(&self) -> HostPolicy {
        self.policy
    }
    #[must_use]
    pub const fn ambient_authority(&self) -> AmbientAuthorityPolicy {
        AmbientAuthorityPolicy::NONE
    }

    /// The only instantiation path. Authorization and manifest/capability
    /// equality are checked before `Component::from_binary` sees guest bytes.
    pub fn load_authorized(
        &self,
        artifact: &TrustedPluginArtifact,
        launch: &PluginLaunchContext,
        granted: impl IntoIterator<Item = Capability>,
        rpc: Arc<CapabilityRpc>,
    ) -> Result<PluginRuntime> {
        launch.validate()?;
        let granted = granted.into_iter().collect::<BTreeSet<_>>();
        if granted.contains(&Capability::Unspecified) {
            return Err(HostError::InvalidAuthorizationContext);
        }
        let requested = artifact
            .manifest
            .v2_capabilities()?
            .into_iter()
            .collect::<BTreeSet<_>>();
        if requested != granted {
            return Err(HostError::InvalidAuthorizationContext);
        }
        let authorization = authorization_request(artifact, launch, granted.iter().copied());
        if !self.authorization.authorize(&authorization) {
            return Err(HostError::AuthorizationRequired);
        }

        let guard = ProcessStoreGuard::acquire()?;
        let component = Component::from_binary(&self.engine, artifact.component_bytes())
            .map_err(|_| HostError::InvalidComponent)?;
        let limits = TrackingLimits::fixed(self.policy.wasm_memory_bytes);
        let activity = ActivityTracker::new();
        let state = StoreState::new(
            limits,
            granted,
            RuntimeBinding {
                workspace_id: launch.workspace_id.clone(),
                plugin_id: artifact.manifest.id.clone(),
                instance_id: launch.instance_id.clone(),
                generation: launch.generation,
            },
            Arc::clone(&rpc),
            activity.clone(),
        );
        let mut store = Store::new(&self.engine, state);
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(self.policy.fuel_per_call)
            .map_err(|_| HostError::EngineConfiguration)?;
        store.epoch_deadline_trap();
        store.set_epoch_deadline(1);
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
            activity,
            rpc,
            closed: false,
            _guard: guard,
        })
    }
}

impl Default for PluginEngineFactory {
    fn default() -> Self {
        Self::new().expect("fixed plugin engine policy")
    }
}

pub struct PluginRuntime {
    engine: Engine,
    cancellation_requested: Arc<AtomicBool>,
    policy: HostPolicy,
    store: Store<StoreState>,
    bindings: Plugin,
    activity: ActivityTracker,
    rpc: Arc<CapabilityRpc>,
    closed: bool,
    _guard: ProcessStoreGuard,
}

impl PluginRuntime {
    pub fn initialize_v2(&mut self, context: wit::HostContext) -> Result<wit::PluginModel> {
        self.ensure_open()?;
        self.execute(CallKind::Initialize, |store, bindings| {
            bindings.call_initialize(store, &context)
        })?
        .map_err(|_| HostError::PluginRejected)
    }

    pub fn handle_event(&mut self, event: wit::PluginEvent) -> Result<wit::EventResult> {
        self.ensure_open()?;
        self.execute(CallKind::Normal, |store, bindings| {
            bindings.call_handle_event(store, &event)
        })?
        .map_err(|_| HostError::PluginRejected)
    }

    pub fn run_command(
        &mut self,
        invocation: wit::CommandInvocation,
    ) -> Result<wit::CommandResult> {
        self.ensure_open()?;
        self.execute(CallKind::LongRunning, |store, bindings| {
            bindings.call_run_command(store, &invocation)
        })?
        .map_err(|_| HostError::PluginRejected)
    }

    pub fn migrate_state(
        &mut self,
        previous_api: &str,
        state: &[u8],
    ) -> Result<wit::MigratedState> {
        self.ensure_open()?;
        self.execute(CallKind::Normal, |store, bindings| {
            bindings.call_migrate_state(store, previous_api, state)
        })?
        .map_err(|_| HostError::PluginRejected)
    }

    pub fn shutdown(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.execute(CallKind::Normal, |store, bindings| {
            bindings.call_shutdown(store)
        })?;
        self.store.data_mut().revoke_all();
        self.closed = true;
        Ok(())
    }

    pub fn interrupt(&self) {
        self.interrupt_handle().interrupt();
    }
    pub fn prepare_interruptible_call(&self) {
        self.cancellation_requested.store(false, Ordering::Release);
    }
    #[must_use]
    pub fn interrupt_handle(&self) -> RuntimeInterruptHandle {
        RuntimeInterruptHandle {
            engine: self.engine.clone(),
            cancellation_requested: Arc::clone(&self.cancellation_requested),
            rpc: Arc::clone(&self.rpc),
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
        let fuel = match kind {
            CallKind::Initialize => self.policy.initialization_fuel,
            CallKind::Normal | CallKind::LongRunning => self.policy.fuel_per_call,
        };
        self.store
            .set_fuel(fuel)
            .map_err(|_| HostError::EngineConfiguration)?;
        self.store.set_epoch_deadline(1);
        self.activity.touch();
        if self.cancellation_requested.load(Ordering::Acquire) {
            self.engine.increment_epoch();
        }
        let duration = match kind {
            CallKind::Initialize | CallKind::Normal => self.policy.call_timeout,
            CallKind::LongRunning => self.policy.long_task_timeout,
        };
        let deadline = DeadlineGuard::arm(self.engine.clone(), duration)?;
        let inactivity = matches!(kind, CallKind::LongRunning)
            .then(|| {
                InactivityGuard::arm(
                    self.engine.clone(),
                    self.activity.clone(),
                    self.policy.activity_timeout,
                )
            })
            .transpose()?;
        let result = invoke(&mut self.store, &self.bindings);
        let timed_out = deadline.finish();
        let inactive = inactivity.is_some_and(InactivityGuard::finish);
        let cancelled = self.cancellation_requested.swap(false, Ordering::AcqRel);
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                self.store.data_mut().revoke_all();
                Err(classify_execution_error(
                    &error,
                    timed_out || inactive,
                    cancelled,
                    self.store.data().limits.memory_limit_hit(),
                )
                .into())
            }
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
            self.rpc.cancel_all();
            self.store.data_mut().revoke_all();
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
            .name("bbcom-plugin-deadline".into())
            .spawn(move || {
                let (lock, condition) = &*thread_state;
                let cancelled = lock.lock().unwrap_or_else(|v| v.into_inner());
                let (cancelled, wait) = condition
                    .wait_timeout_while(cancelled, timeout, |v| !*v)
                    .unwrap_or_else(|v| v.into_inner());
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
        *lock.lock().unwrap_or_else(|v| v.into_inner()) = true;
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

struct InactivityGuard {
    stop: Arc<AtomicBool>,
    fired: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}
impl InactivityGuard {
    fn arm(engine: Engine, activity: ActivityTracker, timeout: Duration) -> Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let fired = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_fired = Arc::clone(&fired);
        let join = thread::Builder::new()
            .name("bbcom-plugin-activity".into())
            .spawn(move || {
                while !thread_stop.load(Ordering::Acquire) {
                    let inactive = activity.inactive_for();
                    if inactive >= timeout {
                        thread_fired.store(true, Ordering::Release);
                        engine.increment_epoch();
                        return;
                    }
                    thread::park_timeout((timeout - inactive).min(Duration::from_secs(1)));
                }
            })
            .map_err(|_| HostError::EngineConfiguration)?;
        Ok(Self {
            stop,
            fired,
            join: Some(join),
        })
    }
    fn finish(mut self) -> bool {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            join.thread().unpark();
            let _ = join.join();
        }
        self.fired.load(Ordering::Acquire)
    }
}
impl Drop for InactivityGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            join.thread().unpark();
            let _ = join.join();
        }
    }
}

fn classify_execution_error(
    error: &wasmtime::Error,
    timed_out: bool,
    cancelled: bool,
    memory_limit_hit: bool,
) -> ExecutionFailure {
    let kind = if memory_limit_hit {
        ExecutionFailureKind::MemoryLimit
    } else if cancelled {
        ExecutionFailureKind::Cancelled
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
