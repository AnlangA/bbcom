import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { settingsService } from './features/settings';
import './styles/variables.css';
import './styles/global.css';
import './styles/packet-columns.css';

// Hydrate theme/locale and every global default before the first component
// mounts; the single settings service owns all later writes (A-02).
settingsService.hydrate();

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
    shutdown,
    workspace,
    migration,
    appStoreModule,
    serialStoreModule,
    sessions,
  ] = await Promise.all([
    import('./features/application'),
    import('./features/serial'),
    import('./features/shutdown'),
    import('./features/workspace'),
    import('./features/migration'),
    import('./stores/app'),
    import('./stores/serial'),
    import('./features/sessions'),
  ]);
  const pluginsModule = await import('./features/plugins');
  const portLeaseRegistry = new serialApplication.PortLeaseRegistry();
  const notifications = new application.ApplicationNotificationRouter();
  const runtimeStatusRegistry = new sessions.SessionRuntimeStatusRegistry();
  const baseApplicationServices = application.createApplicationServices(
    sessions.createSessionRuntimeRegistryOptions({
      pinia,
      notifications,
      portLeaseClient: portLeaseRegistry,
      runtimeStatusRegistry,
    }),
    portLeaseRegistry,
    notifications,
  );
  const pluginSerialActionBridge = new pluginsModule.PluginSerialActionBridge((sessionId) =>
    baseApplicationServices.runtimeRegistry.get(sessionId),
  );
  await pluginSerialActionBridge.start();
  // G43: plugins read session metadata and bounded capture pages from the
  // renderer-owned catalog through the same trusted event/answer bridge.
  const sessionCatalog = sessions.useSessionCatalog();
  const pluginSessionQueryBridge = new pluginsModule.PluginSessionQueryBridge({
    listSessions: () =>
      sessionCatalog.sessions.value.map((session) => ({
        sessionId: session.id,
        name: session.portName,
        kind: 'serial',
        connected:
          baseApplicationServices.runtimeRegistry.get(session.id)?.isConnected.value === true,
        rxBytes: session.rxBytes,
        txBytes: session.txBytes,
      })),
    readCapture: ({ sessionId, fromSequence, maxFrames, maxBytes }) => {
      const session = sessionCatalog.sessions.value.find((candidate) => candidate.id === sessionId);
      if (!session) return null;
      const frames: {
        sequence: number;
        timestampMs: number;
        tx: boolean;
        bytes: number[];
      }[] = [];
      let budget = maxBytes;
      let index = fromSequence;
      for (; index < session.frames.length && frames.length < maxFrames; index += 1) {
        const frame = session.frames[index];
        if (!frame) break;
        if (frame.data.length > budget) break;
        budget -= frame.data.length;
        frames.push({
          sequence: index,
          timestampMs: frame.timestamp,
          tx: frame.direction === 'TX',
          bytes: Array.from(frame.data),
        });
      }
      return {
        frames,
        nextSequence: index < session.frames.length ? index : null,
      };
    },
  });
  await pluginSessionQueryBridge.start();
  const applicationServices = Object.freeze({
    ...baseApplicationServices,
    runtimeStatusRegistry,
    async shutdown(): Promise<void> {
      pluginSerialActionBridge.stop();
      pluginSessionQueryBridge.stop();
      await baseApplicationServices.shutdown();
    },
  });
  app.provide(sessions.SESSION_APPLICATION_SERVICES_KEY, applicationServices);
  // The plugin center renders in Settings once the native runtime is wired;
  // the port itself fail-closes to "unavailable" outside Tauri.
  const pluginCenterService = new pluginsModule.PluginCenterService(
    new pluginsModule.TauriPluginCenterPort(),
  );
  app.provide(pluginsModule.PLUGIN_CENTER_KEY, pluginCenterService);
  void pluginCenterService.start();
  sessions.enterWorkspaceSessionPersistenceMode();
  const sessionStore = sessions.useWorkspaceSessionPort();
  const sessionMutationPolicy = sessions.useSessionMutationPolicy();
  const appStore = appStoreModule.useAppStore(pinia);
  const serialStore = serialStoreModule.useSerialStore(pinia);
  const workspacePort = new workspace.TauriWorkspacePort();
  const workspaceUi = workspace.useWorkspaceUiStore(pinia);
  const workspaceCoordinator = new workspace.WorkspaceCoordinator(workspacePort, {
    operations: workspace.workspaceOperationLifecycleFor(applicationServices.operationRegistry),
  });
  const workspaceSessionFacade = new workspace.WorkspaceSessionFacadeBridge();
  const runtimeContext: {
    application: InstanceType<typeof workspace.WorkspaceApplicationService> | null;
    adapter: InstanceType<typeof workspace.SessionStoreWorkspaceAdapter> | null;
  } = { application: null, adapter: null };
  const sessionParticipant = new workspace.SessionRuntimeWorkspaceParticipant({
    registry: applicationServices.runtimeRegistry,
    statuses: runtimeStatusRegistry,
    prepareRuntimes: () => applicationServices.prepareShutdown(),
    beginPersistenceDrain: (persistence) => {
      if (!runtimeContext.adapter) throw new Error('workspace adapter is not initialized');
      runtimeContext.adapter.beginPersistenceDrain(persistence);
    },
    endPersistenceDrain: (persistence) => {
      if (!runtimeContext.adapter) throw new Error('workspace adapter is not initialized');
      runtimeContext.adapter.endPersistenceDrain(persistence);
    },
    setMutationPermissions: (permissions) =>
      sessionMutationPolicy.setWorkspaceMutationPermissions(permissions),
    preflightRuntimeCapture: (sessionId, frame) =>
      runtimeContext.application?.preflightCapturedFrame(sessionId, frame).accepted === true,
  });
  const pluginParticipant = new workspace.PluginRuntimeWorkspaceParticipant({
    quiesce() {
      pluginCenterService.cancelAction();
    },
    dispose() {},
    restore() {
      return pluginCenterService.refresh();
    },
    activateStopped() {
      return pluginCenterService.refresh();
    },
    commit() {},
  });
  const transitions = new workspace.WorkspaceTransitionCoordinator([
    sessionParticipant,
    pluginParticipant,
  ]);
  const workspaceApplication = new workspace.WorkspaceApplicationService(
    workspaceCoordinator,
    workspacePort,
    workspaceSessionFacade,
    {
      runtimeLifecycle: transitions,
      onPersistenceFailure() {
        sessionMutationPolicy.setWorkspaceMutationPermissions({
          userMutations: false,
          runtimeCapture: false,
        });
        void applicationServices.prepareShutdown();
      },
    },
  );
  runtimeContext.application = workspaceApplication;
  const workspaceAdapter = new workspace.SessionStoreWorkspaceAdapter(
    sessionStore,
    workspaceApplication,
  );
  workspaceSessionFacade.bind({
    replaceWorkspace(snapshot) {
      workspaceAdapter.replaceWorkspace(snapshot);
      workspaceUi.apply(snapshot.layout);
    },
  });
  runtimeContext.adapter = workspaceAdapter;
  workspaceAdapter.start();
  workspaceUi.subscribe((layout) => {
    if (!workspaceApplication.snapshot().acceptsSaves) return;
    const outcome = workspaceApplication.queueConfigMutation({
      kind: 'set-metadata',
      payload: { layout, updatedAtMs: Date.now() },
    });
    if (!outcome.accepted) workspaceApplication.rejectPersistence(outcome.messageKey);
  });
  workspaceApplication.subscribe((snapshot) => {
    sessionMutationPolicy.setWorkspaceMutationPermissions({
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
    appSettings: appStore,
    serialSettings: serialStore,
    workspacePersistence: workspaceApplication,
    protocol: tauriShutdown,
    closeRequests: tauriShutdown,
  });
  app.provide(shutdown.APPLICATION_SHUTDOWN_KEY, applicationShutdown);
}

app.mount('#app');
