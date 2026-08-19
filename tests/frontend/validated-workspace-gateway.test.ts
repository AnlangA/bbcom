import { describe, expect, test } from 'vitest';
import { ValidatedWorkspaceGateway } from '../../src/features/workspace/validated-workspace-gateway';
import type {
  WorkspaceCoordinatorPort,
  WorkspacePortCallContext,
} from '../../src/features/workspace/types';
import type { WorkspaceCatalogResponse } from '../../src/generated/ipc-contracts';

function context(signal = new AbortController().signal): WorkspacePortCallContext {
  return { signal };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function validCatalog(requestId: string, workspaceId: string): WorkspaceCatalogResponse {
  return {
    requestId,
    workspaces: [
      {
        workspaceId,
        name: workspaceId,
        revision: 0,
        updatedAtMs: 0,
        saveHealth: 'clean',
      },
    ],
  };
}

function port(overrides: Partial<WorkspaceCoordinatorPort> = {}): WorkspaceCoordinatorPort {
  const unsupported = () => Promise.reject(new Error('unsupported test operation'));
  return {
    loadCatalog: unsupported,
    openWorkspace: unsupported,
    createWorkspace: unsupported,
    deleteWorkspace: unsupported,
    requestProjectSourceGrant: unsupported,
    requestProjectTargetGrant: unsupported,
    importProject: unsupported,
    exportProject: unsupported,
    cancelWorkspaceOperation: unsupported,
    applyWorkspaceBatch: unsupported,
    flushWorkspace: unsupported,
    ...overrides,
  } as WorkspaceCoordinatorPort;
}

describe('ValidatedWorkspaceGateway', () => {
  test('keeps concurrent requests stateless when responses settle out of order', async () => {
    const first = deferred<WorkspaceCatalogResponse>();
    const second = deferred<WorkspaceCatalogResponse>();
    const gateway = new ValidatedWorkspaceGateway(
      port({
        loadCatalog: (request) =>
          request.requestId === 'catalog-a' ? first.promise : second.promise,
      }),
    );

    const a = gateway.loadCatalog({ requestId: 'catalog-a' }, context());
    const b = gateway.loadCatalog({ requestId: 'catalog-b' }, context());
    second.resolve(validCatalog('catalog-b', 'workspace-b'));
    first.resolve(validCatalog('catalog-a', 'workspace-a'));

    await expect(b).resolves.toMatchObject({ requestId: 'catalog-b' });
    await expect(a).resolves.toMatchObject({ requestId: 'catalog-a' });
  });

  test('rejects mismatched response identities before they reach application state', async () => {
    const gateway = new ValidatedWorkspaceGateway(
      port({ loadCatalog: async () => validCatalog('wrong-request', 'workspace-a') }),
    );
    await expect(gateway.loadCatalog({ requestId: 'catalog-a' }, context())).rejects.toMatchObject({
      name: 'InvalidWorkspaceResponseError',
      stableField: 'requestId',
    });
  });

  test('validates both identities on destructive project deletion', async () => {
    const gateway = new ValidatedWorkspaceGateway(
      port({
        deleteWorkspace: async (request) => ({
          requestId: request.requestId,
          workspaceId: 'workspace-other',
        }),
      }),
    );
    await expect(
      gateway.deleteWorkspace({ requestId: 'delete-a', workspaceId: 'workspace-a' }, context()),
    ).rejects.toMatchObject({ name: 'InvalidWorkspaceResponseError', stableField: 'workspaceId' });
  });

  test('honors cancellation for reads without rewriting a dispatched native terminal outcome', async () => {
    const catalog = deferred<WorkspaceCatalogResponse>();
    const activation = deferred<Awaited<ReturnType<WorkspaceCoordinatorPort['openWorkspace']>>>();
    const gateway = new ValidatedWorkspaceGateway(
      port({
        loadCatalog: () => catalog.promise,
        openWorkspace: () => activation.promise,
      }),
    );
    const readAbort = new AbortController();
    const read = gateway.loadCatalog({ requestId: 'catalog-a' }, context(readAbort.signal));
    readAbort.abort();
    catalog.resolve(validCatalog('catalog-a', 'workspace-a'));
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });

    const nativeAbort = new AbortController();
    const native = gateway.openWorkspace(
      { requestId: 'activate-a', workspaceId: 'workspace-a' },
      context(nativeAbort.signal),
    );
    nativeAbort.abort();
    activation.resolve({
      requestId: 'activate-a',
      workspace: {
        workspaceId: 'workspace-a',
        name: 'Workspace A',
        revision: 1,
        updatedAtMs: 1,
        saveHealth: 'clean',
      },
      header: {
        workspaceId: 'workspace-a',
        name: 'Workspace A',
        revision: 1,
        sessionIds: [],
        layout: {},
      },
    });
    await expect(native).resolves.toMatchObject({ requestId: 'activate-a' });
  });
});
