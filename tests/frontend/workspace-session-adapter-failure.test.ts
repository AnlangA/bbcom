import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { test } from 'vitest';

import { SessionStoreWorkspaceAdapter } from '../../src/features/workspace/session-store-workspace-adapter.ts';
import type { WorkspaceApplicationService } from '../../src/features/workspace/application/index.ts';
import { useSessionCoreStore } from '../../src/stores/session-core.ts';
import type { PortConfig } from '../../src/types/index.ts';

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

test('workspace adapter converts a synchronous projection failure into one fail-closed rejection', () => {
  setActivePinia(createPinia());
  const store = useSessionCoreStore();
  const sessionId = store.createSession('COM-projection-failure', config);
  assert.ok(sessionId);
  const rejected: string[] = [];
  // Permission revocation lives on the persistence facade since the store
  // split; capture it up front so the failure callback cannot lose access.
  const persistence = useSessionCoreStore();
  const application = {
    subscribe: () => () => undefined,
    rejectPersistence(messageKey: string) {
      rejected.push(messageKey);
      // Mirrors the production onPersistenceFailure boundary: quiesce is
      // asynchronous, but permission revocation is synchronous and fail closed.
      persistence.setWorkspaceMutationPermissions({ userMutations: false, runtimeCapture: false });
    },
  } as unknown as WorkspaceApplicationService;
  const adapter = new SessionStoreWorkspaceAdapter(store, application);
  adapter.start();

  const invalidDraft = 'x'.repeat(1024 * 1024 + 1);
  store.setSendDraft(sessionId, invalidDraft);

  assert.deepEqual(rejected, ['workspace.mutation.invalid']);
  assert.equal(store.sessions[0]?.sendDraft, invalidDraft);
  store.setSendDraft(sessionId, 'must remain blocked');
  assert.equal(store.sessions[0]?.sendDraft, invalidDraft);
  adapter.stop();
});
