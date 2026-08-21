import { createApp, watch } from 'vue';
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
const isPluginWindow = params.get('window') === 'plugin';

const RootComponent = isAiWindow
  ? (await import('./AiWindow.vue')).default
  : isPluginWindow
    ? (await import('./PluginWindow.vue')).default
    : (await import('./App.vue')).default;

const app = createApp(RootComponent);
const pinia = createPinia();
app.use(pinia);

if (!isAiWindow && !isPluginWindow) {
  const [
    application,
    serialApplication,
    shutdown,
    workspace,
    appStoreModule,
    serialStoreModule,
    sessions,
  ] = await Promise.all([
    import('./features/application'),
    import('./features/serial'),
    import('./features/shutdown'),
    import('./features/workspace'),
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
  const applicationServices = Object.freeze({
    ...baseApplicationServices,
    runtimeStatusRegistry,
  });
  app.provide(sessions.SESSION_APPLICATION_SERVICES_KEY, applicationServices);
  // The plugin center renders in Settings once the native runtime is wired;
  // the port itself fail-closes to "unavailable" outside Tauri.
  const pluginCenterService = new pluginsModule.PluginCenterService(
    new pluginsModule.TauriPluginCenterPort(),
  );
  app.provide(pluginsModule.PLUGIN_CENTER_KEY, pluginCenterService);
  let pluginSerialCapabilityGateway: ReturnType<
    typeof pluginsModule.createPluginSerialCapabilityGateway
  > | null = null;
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
    async quiesce() {
      pluginCenterService.cancelAction();
      await pluginSerialCapabilityGateway?.revokeAll();
    },
    async dispose() {
      await pluginSerialCapabilityGateway?.revokeAll();
    },
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
  pluginSerialCapabilityGateway = pluginsModule.createPluginSerialCapabilityGateway({
    pluginCenter: pluginCenterService,
    workspace: workspaceApplication,
    workspaceFrames: workspacePort,
    sessions: sessionStore,
    runtimes: applicationServices.runtimeRegistry,
    ports: serialStore,
  });
  const pluginSerialCapabilityTransport = new pluginsModule.TauriPluginSerialCapabilityTransport();
  // The native host-context update may synchronously initialize already
  // enabled plugins. Start the reply bridge first so initialization-time host
  // calls such as ListSessions always have a receiver.
  const pluginSerialCapabilityBridge = new pluginsModule.PluginSerialCapabilityBridge(
    pluginSerialCapabilityGateway,
    pluginSerialCapabilityTransport,
  );
  await pluginSerialCapabilityBridge.start();
  const pluginHostContextTransport = new pluginsModule.TauriPluginHostContextTransport();
  const updatePluginHostContext = () =>
    pluginHostContextTransport.update({
      locale: appStore.locale,
      theme: appStore.theme,
      sessions: sessionStore.sessions.map((session, index) => {
        const connection = applicationServices.runtimeRegistry
          .get(session.id)
          ?.serialTransactions.connectionSnapshot() ?? { connected: false, generation: 0 };
        const preferredName = session.displayName?.trim() ?? '';
        return {
          sessionId: session.id,
          name: pluginsModule.safeDisplayText(preferredName, 1_024)
            ? preferredName
            : `Session ${index + 1}`,
          connected: connection.connected,
          rxBytes: session.rxBytes,
          txBytes: session.txBytes,
          generation: connection.generation,
        };
      }),
    });
  await updatePluginHostContext().catch(() => undefined);
  watch(
    () => ({
      locale: appStore.locale,
      theme: appStore.theme,
      sessions: sessionStore.sessions.map((session) => ({
        id: session.id,
        displayName: session.displayName,
        connected: session.isConnected,
        rxBytes: session.rxBytes,
        txBytes: session.txBytes,
      })),
    }),
    () => void updatePluginHostContext().catch(() => undefined),
    { deep: true, flush: 'post' },
  );
  watch(
    () => [...serialStore.availablePorts],
    () => {
      if (pluginSerialCapabilityGateway?.refreshPortCatalog() !== true) return;
      void pluginSerialCapabilityTransport.notifyPortCatalogChanged().catch(() => undefined);
    },
    { flush: 'sync' },
  );
  watch(
    () =>
      JSON.stringify(
        sessionStore.sessions.map((session) => [
          session.id,
          session.displayName,
          session.isConnected,
        ]),
      ),
    () => void pluginSerialCapabilityTransport.notifyPortCatalogChanged().catch(() => undefined),
    { flush: 'post' },
  );
  void pluginCenterService.start();
  const workspaceAdapter = new workspace.SessionStoreWorkspaceAdapter(
    sessionStore,
    workspaceApplication,
  );
  workspaceSessionFacade.bind({
    replaceWorkspace(snapshot) {
      workspaceAdapter.replaceWorkspace(snapshot);
      workspaceUi.apply(snapshot.layout);
    },
    clearWorkspace() {
      workspaceAdapter.clearWorkspace();
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
    void updatePluginHostContext().catch(() => undefined);
  });
  app.provide(workspace.WORKSPACE_APPLICATION_KEY, {
    coordinator: workspaceCoordinator,
    application: workspaceApplication,
  });
  const tauriShutdown = new shutdown.TauriShutdownPort();
  const applicationShutdown = await shutdown.bootstrapApplicationShutdown({
    application: {
      async prepareShutdown() {
        await pluginSerialCapabilityGateway?.revokeAll();
        await applicationServices.prepareShutdown();
      },
    },
    appSettings: appStore,
    serialSettings: serialStore,
    workspacePersistence: workspaceApplication,
    protocol: tauriShutdown,
    closeRequests: tauriShutdown,
  });
  app.provide(shutdown.APPLICATION_SHUTDOWN_KEY, applicationShutdown);
}

app.mount('#app');
