import { describe, expect, test } from 'vitest';
import type {
  PluginAuthorizationRequestV2,
  PluginCommandContributionV2,
  PluginTaskViewV2,
  RuntimeInstanceKey,
} from '../../src/generated/ipc-contracts';
import {
  normalizePluginAuthorizationRequests,
  normalizePluginCommandContributions,
  normalizePluginTasks,
  sameRuntime,
} from '../../src/features/plugins/domain/plugin-runtime-v2';

const runtime: RuntimeInstanceKey = {
  workspaceId: 'workspace-1',
  pluginId: 'dev.bbcom.mcumgr',
  instanceId: 1,
  generation: 2,
};

function task(overrides: Partial<PluginTaskViewV2> = {}): PluginTaskViewV2 {
  return {
    runtime,
    taskId: 'upload-1',
    commandId: 'image-upload',
    title: 'Upload firmware',
    status: 'running',
    completed: 32,
    total: 128,
    statusText: 'Uploading',
    cancellable: true,
    ...overrides,
  };
}

function authorization(
  overrides: Partial<PluginAuthorizationRequestV2> = {},
): PluginAuthorizationRequestV2 {
  return {
    pluginId: 'dev.bbcom.mcumgr',
    displayName: 'MCUmgr',
    version: '1.0.0',
    digestSha256: 'a'.repeat(64),
    developmentSource: false,
    requestedCapabilities: ['file.open-read', 'serial.io', 'ui.workspace'],
    addedCapabilities: ['file.open-read', 'serial.io', 'ui.workspace'],
    ...overrides,
  };
}

function command(
  overrides: Partial<PluginCommandContributionV2> = {},
): PluginCommandContributionV2 {
  return {
    runtime,
    commandId: 'image-state',
    title: 'Read image state',
    description: 'Reads the MCUboot image state.',
    dangerous: false,
    ...overrides,
  };
}

describe('plugin runtime v2 renderer validation', () => {
  test('clones and freezes valid task, authorization and command values', () => {
    const tasks = normalizePluginTasks([task()]);
    const requests = normalizePluginAuthorizationRequests([authorization()]);
    const commands = normalizePluginCommandContributions([command()]);

    expect(tasks?.[0]?.runtime).not.toBe(runtime);
    expect(Object.isFrozen(tasks?.[0])).toBe(true);
    expect(Object.isFrozen(requests?.[0]?.requestedCapabilities)).toBe(true);
    expect(Object.isFrozen(commands?.[0]?.runtime)).toBe(true);
  });

  test('rejects impossible task progress and terminal cancellability', () => {
    expect(normalizePluginTasks([task({ completed: 129 })])).toBeNull();
    expect(
      normalizePluginTasks([task({ status: 'completed', completed: 128, cancellable: true })]),
    ).toBeNull();
  });

  test('requires canonical capabilities and an added subset', () => {
    expect(
      normalizePluginAuthorizationRequests([
        authorization({ requestedCapabilities: ['ui.workspace', 'serial.io'] }),
      ]),
    ).toBeNull();
    expect(
      normalizePluginAuthorizationRequests([
        authorization({ addedCapabilities: ['serial.control-lines'] }),
      ]),
    ).toBeNull();
  });

  test('rejects duplicate generation-bound task and command identities', () => {
    expect(normalizePluginTasks([task(), task()])).toBeNull();
    expect(normalizePluginCommandContributions([command(), command()])).toBeNull();
  });

  test('rejects unsafe task and command text', () => {
    expect(normalizePluginTasks([task({ statusText: 'bad\u0000text' })])).toBeNull();
    expect(normalizePluginCommandContributions([command({ title: 'bad\ncommand' })])).toBeNull();
  });

  test('rejects every malformed task field and accepts valid failures and zero progress', () => {
    expect(
      normalizePluginTasks(
        Array.from({ length: 129 }, (_, index) => task({ taskId: `task-${index}` })),
      ),
    ).toBeNull();
    for (const invalidRuntime of [
      { ...runtime, workspaceId: '' },
      { ...runtime, pluginId: '' },
      { ...runtime, instanceId: -1 },
      { ...runtime, generation: -1 },
    ]) {
      expect(normalizePluginTasks([task({ runtime: invalidRuntime })])).toBeNull();
    }
    for (const invalid of [
      task({ taskId: '' }),
      task({ commandId: '' }),
      task({ title: 'x'.repeat(257) }),
      task({ status: 'unknown' as PluginTaskViewV2['status'] }),
      task({ completed: -1 }),
      task({ total: -1 }),
      task({ completed: 1, total: 0 }),
      task({ statusText: 'x'.repeat(1025) }),
      task({ failure: { code: 'invalid' as never, messageKey: 'plugin.failure' } }),
      task({ failure: { code: 'io-error', messageKey: 'Bad key' } }),
      task({ failure: { code: 'io-error', messageKey: 'plugin.failure', detail: '\u0000' } }),
    ]) {
      expect(normalizePluginTasks([invalid])).toBeNull();
    }
    const normalized = normalizePluginTasks([
      task({
        status: 'failed',
        completed: 0,
        total: 0,
        cancellable: false,
        statusText: 'line\nnext',
        failure: { code: 'io-error', messageKey: 'plugin.failure', detail: 'device failed' },
      }),
    ]);
    expect(normalized).not.toBeNull();
    expect(Object.isFrozen(normalized?.[0]?.failure)).toBe(true);
  });

  test('validates authorization identity, version, digest, bounds, ordering, and uniqueness', () => {
    expect(
      normalizePluginAuthorizationRequests(
        Array.from({ length: 33 }, (_, index) => authorization({ pluginId: `plugin-${index}` })),
      ),
    ).toBeNull();
    for (const invalid of [
      authorization({ pluginId: '' }),
      authorization({ pluginId: 1 as never }),
      authorization({ displayName: 'bad\nname' }),
      authorization({ version: '01.0.0' }),
      authorization({ digestSha256: 'A'.repeat(64) }),
      authorization({ requestedCapabilities: Array.from({ length: 13 }, () => 'ui.workspace') }),
      authorization({ requestedCapabilities: ['unsupported' as never] }),
      authorization({ requestedCapabilities: ['ui.workspace', 'ui.workspace'] }),
    ]) {
      expect(normalizePluginAuthorizationRequests([invalid])).toBeNull();
    }
    expect(normalizePluginAuthorizationRequests([authorization(), authorization()])).toBeNull();
    expect(
      normalizePluginAuthorizationRequests([
        authorization({ version: '2.1.0-beta.1', addedCapabilities: [] }),
      ]),
    ).not.toBeNull();
  });

  test('validates command limits, confirmations, runtime identity, and multiline descriptions', () => {
    expect(
      normalizePluginCommandContributions(
        Array.from({ length: 257 }, (_, index) => command({ commandId: `command-${index}` })),
      ),
    ).toBeNull();
    for (const invalid of [
      command({ runtime: { ...runtime, workspaceId: '' } }),
      command({ commandId: '' }),
      command({ title: 'x'.repeat(257) }),
      command({ description: 'x'.repeat(1025) }),
      command({ dangerous: true }),
      command({ dangerous: false, confirmation: 'Confirm' }),
      command({ dangerous: true, confirmation: '\u007f' }),
    ]) {
      expect(normalizePluginCommandContributions([invalid])).toBeNull();
    }
    expect(
      normalizePluginCommandContributions([
        command({
          commandId: 'danger',
          description: 'line\nnext\tvalue',
          dangerous: true,
          confirmation: 'Confirm action',
        }),
      ]),
    ).not.toBeNull();
  });

  test('compares every generation-bound runtime coordinate', () => {
    expect(sameRuntime(runtime, { ...runtime })).toBe(true);
    expect(sameRuntime(runtime, { ...runtime, workspaceId: 'workspace-2' })).toBe(false);
    expect(sameRuntime(runtime, { ...runtime, pluginId: 'dev.bbcom.other' })).toBe(false);
    expect(sameRuntime(runtime, { ...runtime, instanceId: 2 })).toBe(false);
    expect(sameRuntime(runtime, { ...runtime, generation: 3 })).toBe(false);
  });
});
