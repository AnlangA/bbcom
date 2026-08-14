import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createApp } from 'vue';
import { maxBufferFrames, setMaxBufferFrames } from '../../src/lib/buffer-config.ts';
import {
  APPLICATION_SHUTDOWN_KEY,
  useApplicationShutdown,
  useOptionalApplicationShutdown,
} from '../../src/features/shutdown/application-shutdown-context.ts';
import type { ApplicationShutdownController } from '../../src/features/shutdown/application-shutdown-bootstrap.ts';
import {
  WORKSPACE_APPLICATION_KEY,
  useOptionalWorkspaceApplication,
  useWorkspaceApplication,
  type WorkspaceApplicationContext,
} from '../../src/features/workspace/application/workspace-application-context.ts';

test('non-finite buffer limits use the canonical application default', () => {
  const previous = maxBufferFrames.value;
  try {
    assert.equal(setMaxBufferFrames(Number.NaN), 10_000);
  } finally {
    maxBufferFrames.value = previous;
  }
});

test('application shutdown injection fails closed and returns the provided controller', () => {
  const app = createApp({});
  assert.equal(
    app.runWithContext(() => useOptionalApplicationShutdown()),
    null,
  );
  assert.throws(
    () => app.runWithContext(() => useApplicationShutdown()),
    /shutdown controller is not provided/,
  );

  const controller = {} as ApplicationShutdownController;
  app.provide(APPLICATION_SHUTDOWN_KEY, controller);
  assert.strictEqual(
    app.runWithContext(() => useApplicationShutdown()),
    controller,
  );
  assert.strictEqual(
    app.runWithContext(() => useOptionalApplicationShutdown()),
    controller,
  );
});

test('workspace injection fails closed and returns the provided application context', () => {
  const app = createApp({});
  assert.equal(
    app.runWithContext(() => useOptionalWorkspaceApplication()),
    null,
  );
  assert.throws(
    () => app.runWithContext(() => useWorkspaceApplication()),
    /workspace application context is unavailable/,
  );

  const context = {} as WorkspaceApplicationContext;
  app.provide(WORKSPACE_APPLICATION_KEY, context);
  assert.strictEqual(
    app.runWithContext(() => useWorkspaceApplication()),
    context,
  );
  assert.strictEqual(
    app.runWithContext(() => useOptionalWorkspaceApplication()),
    context,
  );
});
