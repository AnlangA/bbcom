import type {
  ApplyWorkspaceBatchRequest,
  ApplyWorkspaceBatchResponse,
  CancelWorkspaceOperationRequest,
  CancelWorkspaceOperationResponse,
  CreateWorkspaceCommandRequest,
  CreateWorkspaceCommandResponse,
  DeleteWorkspaceRequest,
  DeleteWorkspaceResponse,
  ExportProjectRequest,
  ExportProjectResponse,
  FlushWorkspaceRequest,
  FlushWorkspaceResponse,
  ImportProjectRequest,
  ImportProjectResponse,
  OpenWorkspaceRequest,
  OpenWorkspaceResponse,
  ProjectSourceGrantResponse,
  ProjectTargetGrantResponse,
  RequestProjectSourceGrantRequest,
  RequestProjectTargetGrantRequest,
  WorkspaceCatalogRequest,
  WorkspaceCatalogResponse,
  WorkspaceMutation,
  WorkspaceSaveHealth,
} from '@/generated/ipc-contracts';

export const WORKSPACE_PROJECT_EXTENSION = '.bbcom' as const;
export const WORKSPACE_RECENT_PROJECT_LIMIT = 12;

declare const workspaceGrantBrand: unique symbol;

/** Opaque native grant identity. It contains no filesystem location. */
export type WorkspaceGrantId = string & { readonly [workspaceGrantBrand]: true };

export interface WorkspacePortCallContext {
  readonly signal: AbortSignal;
}

/**
 * Boundary implemented by the application IPC layer.
 *
 * Every request and response is Rust-generated. No filesystem location crosses
 * this boundary; project file selection yields only an opaque grant identity.
 */
export interface WorkspaceCoordinatorPort {
  loadCatalog(
    request: WorkspaceCatalogRequest,
    context: WorkspacePortCallContext,
  ): Promise<WorkspaceCatalogResponse>;
  openWorkspace(
    request: OpenWorkspaceRequest,
    context: WorkspacePortCallContext,
  ): Promise<OpenWorkspaceResponse>;
  createWorkspace(
    request: CreateWorkspaceCommandRequest,
    context: WorkspacePortCallContext,
  ): Promise<CreateWorkspaceCommandResponse>;
  deleteWorkspace(
    request: DeleteWorkspaceRequest,
    context: WorkspacePortCallContext,
  ): Promise<DeleteWorkspaceResponse>;
  requestProjectSourceGrant(
    request: RequestProjectSourceGrantRequest,
    context: WorkspacePortCallContext,
  ): Promise<ProjectSourceGrantResponse>;
  requestProjectTargetGrant(
    request: RequestProjectTargetGrantRequest,
    context: WorkspacePortCallContext,
  ): Promise<ProjectTargetGrantResponse>;
  importProject(
    request: ImportProjectRequest,
    context: WorkspacePortCallContext,
  ): Promise<ImportProjectResponse>;
  exportProject(
    request: ExportProjectRequest,
    context: WorkspacePortCallContext,
  ): Promise<ExportProjectResponse>;
  cancelWorkspaceOperation(
    request: CancelWorkspaceOperationRequest,
    context: WorkspacePortCallContext,
  ): Promise<CancelWorkspaceOperationResponse>;
  applyWorkspaceBatch(
    request: ApplyWorkspaceBatchRequest,
    context: WorkspacePortCallContext,
  ): Promise<ApplyWorkspaceBatchResponse>;
  flushWorkspace(
    request: FlushWorkspaceRequest,
    context: WorkspacePortCallContext,
  ): Promise<FlushWorkspaceResponse>;
}

/** Generated discriminated mutation with sequencing owned by the coordinator. */
export type WorkspaceMutationCommand = WorkspaceMutation extends infer TMutation
  ? TMutation extends { sequence: number }
    ? Omit<TMutation, 'sequence'>
    : never
  : never;

export type WorkspaceLibraryStatus = 'idle' | 'loading' | 'ready' | 'failed';
export type WorkspaceNavigationAction = 'create' | 'open' | 'import' | 'delete';

export interface WorkspaceLibraryActionViewModel {
  readonly id: 'new-project' | 'open-project' | 'import-project';
  readonly enabled: boolean;
  readonly busy: boolean;
}

export interface WorkspaceProjectViewModel {
  readonly workspaceId: string;
  readonly name: string;
  readonly revision: number;
  readonly updatedAtMs: number;
  readonly saveHealth: WorkspaceSaveHealth;
  readonly active: boolean;
}

export interface WorkspaceLibraryViewModel {
  readonly status: WorkspaceLibraryStatus;
  readonly activeWorkspaceId: string | null;
  readonly messageKey: string | null;
  readonly actions: {
    readonly newProject: WorkspaceLibraryActionViewModel;
    readonly openProject: WorkspaceLibraryActionViewModel;
    readonly importProject: WorkspaceLibraryActionViewModel;
  };
  /** Complete managed library. `recentProjects` is only a shortcut subset. */
  readonly projects: readonly WorkspaceProjectViewModel[];
  readonly recentProjects: readonly WorkspaceProjectViewModel[];
}

export interface ActiveWorkspaceViewModel {
  readonly workspaceId: string;
  readonly name: string;
  readonly revision: number;
  readonly activeSessionId: string | null;
  readonly sessionIds: readonly string[];
  readonly saveHealth: WorkspaceSaveHealth;
  readonly layout: WorkspaceLayoutV1;
}

export interface WorkspaceLayoutV1 {
  readonly [key: string]: unknown;
  readonly version: 1;
  readonly sidebar: {
    readonly width: number;
    readonly collapsed: boolean;
  };
}

export interface WorkspaceCoordinatorSnapshot {
  readonly library: WorkspaceLibraryViewModel;
  readonly activeWorkspace: ActiveWorkspaceViewModel | null;
  readonly navigationAction: WorkspaceNavigationAction | null;
  readonly exporting: boolean;
  readonly acceptsMutations: boolean;
}

export type WorkspaceCoordinatorListener = (snapshot: WorkspaceCoordinatorSnapshot) => void;

export interface WorkspaceActionFailure {
  readonly outcome: 'failed';
  readonly messageKey: string;
  readonly code?: string;
}

export type WorkspaceActionOutcome<T> =
  | { readonly outcome: 'completed'; readonly value: T }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'stale' }
  | WorkspaceActionFailure;

/** The authoritative terminal state observed after an export cancellation request. */
export type WorkspaceExportCancellationStatus = 'not-active' | 'cancelled' | 'completed' | 'failed';

export interface WorkspaceCoordinatorOptions {
  readonly idFactory?: (
    scope: 'catalog' | 'activate' | 'delete' | 'export' | 'batch' | 'flush',
  ) => string;
  readonly operations?: WorkspaceOperationLifecyclePort;
}

/** Application-owned operation lifecycle observer/canceller. */
export interface WorkspaceOperationLifecyclePort {
  begin(input: {
    readonly operationId: string;
    readonly kind: 'workspace-import' | 'workspace-export';
    readonly workspaceId: string;
    readonly cancel: () => Promise<void>;
  }): void;
  complete(operationId: string): void;
  fail(operationId: string, failure: WorkspaceActionFailure): void;
  cancel(operationId: string): Promise<void>;
}
