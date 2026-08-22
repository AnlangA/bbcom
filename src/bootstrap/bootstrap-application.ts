import type { App } from 'vue';
import type { Pinia } from 'pinia';

export async function bootstrapApplication(app: App, pinia: Pinia): Promise<void> {
  const [platform, serialApplication, workspace, appStoreModule, serialStoreModule, sessions] =
    await Promise.all([
      import('@/features/platform'),
      import('@/features/serial'),
      import('@/features/workspace'),
      import('@/features/settings/store/app-store'),
      import('@/features/serial/store/serial-store'),
      import('@/features/sessions'),
    ]);

  const portLeaseRegistry = new serialApplication.PortLeaseRegistry();
  const notifications = new platform.ApplicationNotificationRouter();
  const runtimeStatusRegistry = new sessions.SessionRuntimeStatusRegistry();
  const baseApplicationServices = platform.createApplicationServices(
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
  const transitions = new workspace.WorkspaceTransitionCoordinator([sessionParticipant]);
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
    clearWorkspace() {
      workspaceAdapter.clearWorkspace();
    },
  });
  runtimeContext.adapter = workspaceAdapter;
  workspaceAdapter.start();

  const initialCatalog = await workspaceCoordinator.refreshCatalog();
  if (initialCatalog.outcome === 'completed') {
    const initialWorkspaceId =
      initialCatalog.value.library.activeWorkspaceId ??
      initialCatalog.value.library.projects[0]?.workspaceId;
    if (initialWorkspaceId) {
      await workspaceApplication.openWorkspace(initialWorkspaceId);
    }
  }

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
  const tauriShutdown = new platform.TauriShutdownPort();
  const applicationShutdown = await platform.bootstrapApplicationShutdown({
    application: {
      async prepareShutdown() {
        await applicationServices.prepareShutdown();
      },
    },
    appSettings: appStore,
    serialSettings: serialStore,
    workspacePersistence: workspaceApplication,
    protocol: tauriShutdown,
    closeRequests: tauriShutdown,
  });
  app.provide(platform.APPLICATION_SHUTDOWN_KEY, applicationShutdown);
}
