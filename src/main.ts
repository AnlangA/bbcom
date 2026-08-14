import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './styles/variables.css';
import './styles/global.css';
import './styles/packet-columns.css';

const params = new URLSearchParams(window.location.search);
const isAiWindow = params.get('window') === 'ai';

const RootComponent = isAiWindow
  ? (await import('./AiWindow.vue')).default
  : (await import('./App.vue')).default;

const app = createApp(RootComponent);
const pinia = createPinia();
app.use(pinia);

if (!isAiWindow) {
  const [
    application,
    serialApplication,
    sessionRuntime,
    shutdown,
    workspace,
    migration,
    appStoreModule,
    serialStoreModule,
    sessionStoreModule,
  ] = await Promise.all([
    import('./features/application'),
    import('./features/serial/application'),
    import('./features/sessions/runtime/session-runtime-factory'),
    import('./features/shutdown'),
    import('./features/workspace'),
    import('./features/migration'),
    import('./stores/app'),
    import('./stores/serial'),
    import('./stores/sessions'),
  ]);
  const { SESSION_APPLICATION_SERVICES_KEY } =
    await import('./features/sessions/runtime/session-application-services');
  const portLeaseRegistry = new serialApplication.PortLeaseRegistry();
  const notifications = new application.ApplicationNotificationRouter();
  const applicationServices = application.createApplicationServices(
    sessionRuntime.createSessionRuntimeRegistryOptions({
      pinia,
      notifications,
      portLeaseClient: portLeaseRegistry,
    }),
    portLeaseRegistry,
    notifications,
  );
  app.provide(SESSION_APPLICATION_SERVICES_KEY, applicationServices);
  sessionStoreModule.enterWorkspaceSessionPersistenceMode();
  const sessionStore = sessionStoreModule.useSessionStore(pinia);
  const appStore = appStoreModule.useAppStore(pinia);
  const serialStore = serialStoreModule.useSerialStore(pinia);
  const workspacePort = new workspace.TauriWorkspacePort();
  const workspaceCoordinator = new workspace.WorkspaceCoordinator(workspacePort, {
    operations: workspace.workspaceOperationLifecycleFor(applicationServices.operationRegistry),
  });
  const workspaceRuntimeSnapshots = new Map<
    string,
    readonly {
      readonly sessionId: string;
      readonly session: (typeof sessionStore.sessions)[number];
    }[]
  >();
  const workspaceApplication = new workspace.WorkspaceApplicationService(
    workspaceCoordinator,
    workspacePort,
    {
      replaceWorkspace(snapshot) {
        sessionStore.replaceWorkspaceSessions(snapshot.sessions, snapshot.activeSessionId);
        appStore.applyWorkspaceLayout(snapshot.layout);
      },
    },
    {
      runtimeLifecycle: {
        async quiesce({ transitionId, persistence }) {
          if (!workspaceRuntimeSnapshots.has(transitionId)) {
            workspaceRuntimeSnapshots.set(
              transitionId,
              applicationServices.runtimeRegistry.list().map(({ sessionId, session }) => ({
                sessionId,
                session,
              })),
            );
          }
          workspaceAdapter.beginPersistenceDrain(persistence);
          sessionStore.setWorkspaceMutationPermissions({
            userMutations: false,
            runtimeCapture: true,
            preflightRuntimeCapture: (sessionId, frame) =>
              workspaceApplication.preflightCapturedFrame(sessionId, frame).accepted,
          });
          try {
            await applicationServices.prepareShutdown();
          } finally {
            sessionStore.setWorkspaceMutationPermissions({
              userMutations: false,
              runtimeCapture: false,
              preflightRuntimeCapture: (sessionId, frame) =>
                workspaceApplication.preflightCapturedFrame(sessionId, frame).accepted,
            });
            workspaceAdapter.endPersistenceDrain(persistence);
          }
        },
        async dispose({ transitionId }) {
          const snapshot = workspaceRuntimeSnapshots.get(transitionId) ?? [];
          await Promise.all(
            snapshot.map(({ sessionId }) =>
              applicationServices.runtimeRegistry.disposeSession(sessionId, 'reconcile'),
            ),
          );
          await applicationServices.runtimeRegistry.reconcile([]);
        },
        async restore({ transitionId }) {
          const snapshot = workspaceRuntimeSnapshots.get(transitionId) ?? [];
          await applicationServices.runtimeRegistry.reconcile([]);
          for (const { session } of snapshot) {
            await applicationServices.runtimeRegistry.ensure(session);
          }
          workspaceRuntimeSnapshots.delete(transitionId);
        },
        async activateStopped({ transitionId }) {
          // Workspace hydration is deliberately lazy: an inactive restored
          // session has no runtime until the host selects it, and never starts
          // serial/automation merely because a project was opened.
          await applicationServices.runtimeRegistry.reconcile([]);
          void transitionId;
        },
        commit({ transitionId }) {
          workspaceRuntimeSnapshots.delete(transitionId);
        },
      },
      onPersistenceFailure() {
        sessionStore.setWorkspaceMutationPermissions({
          userMutations: false,
          runtimeCapture: false,
        });
        void applicationServices.prepareShutdown();
      },
    },
  );
  const workspaceAdapter = new workspace.SessionStoreWorkspaceAdapter(
    sessionStore,
    workspaceApplication,
  );
  workspaceAdapter.start();
  appStore.subscribeWorkspaceLayout((layout) => {
    if (!workspaceApplication.snapshot().acceptsSaves) return;
    const outcome = workspaceApplication.queueConfigMutation({
      kind: 'set-metadata',
      payload: { layout, updatedAtMs: Date.now() },
    });
    if (!outcome.accepted) workspaceApplication.rejectPersistence(outcome.messageKey);
  });
  workspaceApplication.subscribe((snapshot) => {
    sessionStore.setWorkspaceMutationPermissions({
      userMutations: snapshot.acceptsSaves,
      // During workspace quiesce, user changes are closed while final runtime
      // RX remains admissible through the explicit persistence drain.
      runtimeCapture: snapshot.acceptsPersistenceEvents,
      preflightRuntimeCapture: (sessionId, frame) =>
        workspaceApplication.preflightCapturedFrame(sessionId, frame).accepted,
      preflightSessionRegistration: (sessionId, frameCount, captureBytes) =>
        workspaceApplication.preflightSessionRegistration(sessionId, frameCount, captureBytes)
          .accepted,
    });
  });
  app.provide(workspace.WORKSPACE_APPLICATION_KEY, {
    coordinator: workspaceCoordinator,
    application: workspaceApplication,
  });
  const legacyReset = migration.createLegacyResetBootstrap({
    source: new migration.LegacyRendererReadOnlySource({
      storage: globalThis.localStorage,
      sessions: new migration.BrowserLegacySessionSnapshotReader(globalThis.localStorage),
    }),
    backupPort: new migration.TauriLegacyBackupPort(),
    target: new migration.WorkspaceApplicationResetTarget(workspaceApplication),
    markerStorage: globalThis.localStorage,
  });
  app.provide(migration.LEGACY_RESET_CONTEXT_KEY, legacyReset);
  const tauriShutdown = new shutdown.TauriShutdownPort();
  const applicationShutdown = await shutdown.bootstrapApplicationShutdown({
    application: applicationServices,
    sessionPersistence: sessionStore,
    appSettings: appStore,
    serialSettings: serialStore,
    workspacePersistence: workspaceApplication,
    protocol: tauriShutdown,
    closeRequests: tauriShutdown,
  });
  app.provide(shutdown.APPLICATION_SHUTDOWN_KEY, applicationShutdown);
}

app.mount('#app');
