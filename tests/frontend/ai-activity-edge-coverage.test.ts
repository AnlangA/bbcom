// @vitest-environment happy-dom

import assert from 'node:assert/strict';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { describe, expect, test, vi } from 'vitest';
import {
  AI_BRIDGE_EVENTS,
  AI_BRIDGE_WORKSPACE_ID,
  AiActivityCancelledError,
  AiActivityCenter,
  applyAiAuthorityEnvelope,
  createAiBridgeEnvelope,
  isAiActivityResultPayload,
  isAiActivityRunPayload,
  isAiActivitySnapshotPayload,
  isAiAuthorityPayload,
  isPayloadKind,
  parseAiBridgeEnvelope,
  useAiWindowAuthority,
} from '../../src/features/ai-activity/index.ts';
import { OperationRegistry } from '../../src/features/application/operation-registry.ts';
import {
  IPC_LIMITS,
  type AiRequestResult,
  type IpcError,
} from '../../src/generated/ipc-contracts.ts';

function validEnvelope(payload: unknown = { kind: 'authority-request' }) {
  return createAiBridgeEnvelope({
    workspaceId: 'workspace-a',
    revision: 2,
    origin: 'main',
    requestId: 'request-a',
    sessionId: 'session-a',
    payload,
  });
}

function activityInput(
  requestId: string,
  request: Record<string, unknown> = { requestId, kind: 'terminal', prompt: 'status' },
) {
  return {
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
    revision: 1,
    requestId,
    request,
  };
}

describe('AI bridge protocol edge cases', () => {
  test('creates frozen envelopes and validates every identity and revision boundary', () => {
    const defaultWorkspace = createAiBridgeEnvelope({
      revision: 0,
      origin: 'ai-assistant',
      requestId: 'request:0',
      sessionId: 'no-session',
      payload: { kind: 'authority-request' },
    });
    expect(defaultWorkspace.workspaceId).toBe(AI_BRIDGE_WORKSPACE_ID);
    expect(Object.isFrozen(defaultWorkspace)).toBe(true);
    expect(parseAiBridgeEnvelope(defaultWorkspace, 'ai-assistant')).toBe(defaultWorkspace);

    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => createAiBridgeEnvelope({ ...defaultWorkspace, revision })).toThrow(
        'revision must be a non-negative integer',
      );
    }
    for (const field of ['workspaceId', 'requestId', 'sessionId'] as const) {
      for (const value of ['', '../escape', 'space id', 'x'.repeat(257)]) {
        expect(() => createAiBridgeEnvelope({ ...defaultWorkspace, [field]: value })).toThrow(
          'identities must be path-free opaque identifiers',
        );
      }
    }

    const base = { ...validEnvelope() } as Record<string, unknown>;
    const invalidEnvelopes: unknown[] = [
      null,
      [],
      { ...base, schemaVersion: 2 },
      { ...base, workspaceId: '' },
      { ...base, origin: 'main-window' },
      { ...base, revision: -1 },
      { ...base, requestId: 'bad/id' },
      { ...base, sessionId: 'bad id' },
      { ...base, payload: [] },
    ];
    for (const candidate of invalidEnvelopes) {
      expect(parseAiBridgeEnvelope(candidate, 'main')).toBeNull();
    }
  });

  test('validates authority, payload kinds, and bounded activity run requests', () => {
    const authority = {
      kind: 'authority-snapshot',
      theme: 'dark',
      locale: 'zh',
      aiKeyStatus: { configured: true, durability: 'os' },
    };
    expect(isAiAuthorityPayload(authority)).toBe(true);
    expect(isAiAuthorityPayload({ ...authority, theme: 'sepia' })).toBe(false);
    expect(isAiAuthorityPayload({ ...authority, locale: 'fr' })).toBe(false);
    expect(isAiAuthorityPayload({ ...authority, aiKeyStatus: null })).toBe(false);
    expect(
      isAiAuthorityPayload({
        ...authority,
        aiKeyStatus: { configured: 'yes', durability: 'missing' },
      }),
    ).toBe(false);
    expect(
      isAiAuthorityPayload({
        ...authority,
        aiKeyStatus: { configured: false, durability: 'disk' },
      }),
    ).toBe(false);
    expect(isPayloadKind({ kind: 'activity-cancel' }, 'activity-cancel')).toBe(true);
    expect(isPayloadKind([], 'activity-cancel')).toBe(false);

    const request = {
      kind: 'activity-run',
      request: {
        requestId: 'request-run',
        kind: 'log',
        prompt: 'inspect',
        model: 'glm-4.7',
        shell: 'bash',
        sessionMeta: '{}',
        contextMode: 'latest-10k',
        context: 'RX: OK',
      },
    };
    expect(isAiActivityRunPayload(request)).toBe(true);
    const invalid: unknown[] = [
      null,
      { kind: 'other', request: request.request },
      { kind: 'activity-run', request: [] },
      { ...request, request: { ...request.request, requestId: 'bad/id' } },
      { ...request, request: { ...request.request, kind: 'batch' } },
      { ...request, request: { ...request.request, prompt: '   ' } },
      {
        ...request,
        request: { ...request.request, prompt: 'x'.repeat(IPC_LIMITS.MAX_AI_PROMPT_BYTES + 1) },
      },
      { ...request, request: { ...request.request, model: 7 } },
      {
        ...request,
        request: { ...request.request, shell: 'x'.repeat(IPC_LIMITS.MAX_AI_SHELL_BYTES + 1) },
      },
      {
        ...request,
        request: {
          ...request.request,
          sessionMeta: 'x'.repeat(IPC_LIMITS.MAX_AI_SESSION_META_BYTES + 1),
        },
      },
      {
        ...request,
        request: {
          ...request.request,
          contextMode: 'x'.repeat(IPC_LIMITS.MAX_AI_CONTEXT_MODE_BYTES + 1),
        },
      },
      {
        ...request,
        request: { ...request.request, context: 'x'.repeat(IPC_LIMITS.MAX_AI_CONTEXT_BYTES + 1) },
      },
    ];
    for (const candidate of invalid) expect(isAiActivityRunPayload(candidate)).toBe(false);
  });

  test('validates completed, failed, and operation-snapshot payloads', () => {
    const failed = {
      kind: 'activity-result',
      outcome: 'failed',
      error: {
        code: 'CANCELLED',
        messageKey: 'error.cancelled',
        retryable: false,
        operation: 'run_ai_request',
      },
    };
    expect(isAiActivityResultPayload(failed)).toBe(true);
    expect(
      isAiActivityResultPayload({ ...failed, error: { ...failed.error, retryable: 'no' } }),
    ).toBe(false);
    for (const risk of ['safe', 'caution', 'dangerous'] as const) {
      expect(
        isAiActivityResultPayload({
          kind: 'activity-result',
          outcome: 'completed',
          result: { kind: 'terminal', command: 'pwd', explanation: 'ok', risk },
        }),
      ).toBe(true);
    }
    expect(
      isAiActivityResultPayload({
        kind: 'activity-result',
        outcome: 'completed',
        result: {
          kind: 'log',
          answer: 'healthy',
          evidence: ['RX'],
          suggestions: ['continue'],
          truncated: false,
        },
      }),
    ).toBe(true);
    const invalidResults: unknown[] = [
      null,
      { kind: 'other', outcome: 'completed', result: {} },
      { kind: 'activity-result', outcome: 'pending', result: {} },
      {
        kind: 'activity-result',
        outcome: 'completed',
        result: { kind: 'terminal', command: 1, explanation: 'x', risk: 'safe' },
      },
      {
        kind: 'activity-result',
        outcome: 'completed',
        result: { kind: 'terminal', command: '', explanation: '', risk: 'unknown' },
      },
      {
        kind: 'activity-result',
        outcome: 'completed',
        result: { kind: 'log', answer: 1, evidence: [], suggestions: [], truncated: false },
      },
      {
        kind: 'activity-result',
        outcome: 'completed',
        result: { kind: 'log', answer: '', evidence: [1], suggestions: [], truncated: false },
      },
      {
        kind: 'activity-result',
        outcome: 'completed',
        result: { kind: 'log', answer: '', evidence: [], suggestions: [1], truncated: false },
      },
      {
        kind: 'activity-result',
        outcome: 'completed',
        result: { kind: 'log', answer: '', evidence: [], suggestions: [], truncated: 'no' },
      },
      {
        kind: 'activity-result',
        outcome: 'completed',
        result: {
          kind: 'log',
          answer: 'x'.repeat(IPC_LIMITS.MAX_AI_RESPONSE_BYTES + 1),
          evidence: [],
          suggestions: [],
          truncated: false,
        },
      },
    ];
    for (const candidate of invalidResults)
      expect(isAiActivityResultPayload(candidate)).toBe(false);

    const operation = {
      operationId: 'request-a',
      kind: 'ai-request',
      status: 'queued',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
    };
    for (const status of [
      'queued',
      'running',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ] as const) {
      expect(
        isAiActivitySnapshotPayload({
          kind: 'activity-snapshot',
          operations: [{ ...operation, status }],
        }),
      ).toBe(true);
    }
    expect(isAiActivitySnapshotPayload({ kind: 'activity-snapshot', operations: [] })).toBe(true);
    expect(
      isAiActivitySnapshotPayload({
        kind: 'activity-snapshot',
        operations: Array.from({ length: 65 }, () => operation),
      }),
    ).toBe(false);
    for (const mutation of [
      { operationId: '' },
      { kind: 'export' },
      { status: 'paused' },
      { workspaceId: '../bad' },
      { sessionId: 'bad id' },
    ]) {
      expect(
        isAiActivitySnapshotPayload({
          kind: 'activity-snapshot',
          operations: [{ ...operation, ...mutation }],
        }),
      ).toBe(false);
    }
    expect(isAiActivitySnapshotPayload({ kind: 'activity-snapshot', operations: null })).toBe(
      false,
    );
  });
});

describe('AiActivityCenter edge cases', () => {
  test('deduplicates identical work and rejects unsafe bindings', async () => {
    let finish: ((result: AiRequestResult) => void) | null = null;
    const native = new Promise<AiRequestResult>((resolve) => {
      finish = resolve;
    });
    const operations = new OperationRegistry();
    const center = new AiActivityCenter({ operations, run: () => native });
    const input = activityInput('request-one');
    const first = center.run(input);
    expect(center.run(input)).toBe(first);
    expect(() => center.run({ ...input, sessionId: 'session-b' })).toThrow(
      'already bound to another workspace or session',
    );
    expect(() =>
      center.run({
        ...input,
        requestId: 'binding-id',
        request: { requestId: 'native-id', kind: 'terminal', prompt: 'status' },
      }),
    ).toThrow('native requestId must equal');

    for (const inputMutation of [
      { revision: -1 },
      { revision: 1.5 },
      { workspaceId: '../bad' },
      { sessionId: '' },
      { requestId: 'x'.repeat(257) },
    ]) {
      const candidate = {
        ...activityInput('validation'),
        ...inputMutation,
      };
      candidate.request = { ...candidate.request, requestId: candidate.requestId };
      expect(() => center.run(candidate)).toThrow();
    }

    finish?.({ kind: 'terminal', command: 'status', explanation: 'ok', risk: 'safe' });
    await expect(first).resolves.toMatchObject({ requestId: 'request-one' });
    expect(center.snapshot()[0]?.status).toBe('completed');
  });

  test('records native failures and translates cancellation races', async () => {
    const ipcError: IpcError = {
      code: 'AI_PROVIDER_FAILED',
      messageKey: 'error.ai_request_failed',
      retryable: true,
      operation: 'run_ai_request',
      requestId: 'request-ipc',
    };
    const ipcOperations = new OperationRegistry();
    const ipcCenter = new AiActivityCenter({
      operations: ipcOperations,
      run: async () => Promise.reject(ipcError),
    });
    await expect(ipcCenter.run(activityInput('request-ipc'))).rejects.toBe(ipcError);
    expect(ipcOperations.get('request-ipc')).toMatchObject({ status: 'failed', error: ipcError });

    const genericOperations = new OperationRegistry();
    const genericCenter = new AiActivityCenter({
      operations: genericOperations,
      run: async () => Promise.reject(new Error('offline')),
    });
    await expect(genericCenter.run(activityInput('request-generic'))).rejects.toThrow('offline');
    expect(genericOperations.get('request-generic')?.error).toMatchObject({
      code: 'INVALID_INPUT',
      requestId: 'request-generic',
    });

    let finish: ((result: AiRequestResult) => void) | null = null;
    const pending = new Promise<AiRequestResult>((resolve) => {
      finish = resolve;
    });
    const cancelled: string[] = [];
    const cancelOperations = new OperationRegistry();
    const cancelCenter = new AiActivityCenter({
      operations: cancelOperations,
      run: () => pending,
      cancel: async (requestId) => {
        cancelled.push(requestId);
      },
    });
    const task = cancelCenter.run(activityInput('request-cancel'));
    await expect(cancelCenter.cancel('request-cancel')).resolves.toMatchObject({
      status: 'cancelled',
    });
    finish?.({ kind: 'terminal', command: '', explanation: '', risk: 'safe' });
    await expect(task).rejects.toBeInstanceOf(AiActivityCancelledError);
    expect(cancelled).toEqual(['request-cancel']);
  });
});

describe('AI window authority lifecycle', () => {
  test('requests authority, applies monotonic snapshots, and unregisters on unmount', async () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    let listener: ((event: { payload: unknown }) => void) | null = null;
    const unlisten = vi.fn();
    const target = {
      setTheme: vi.fn(),
      setLocale: vi.fn(),
      aiKeyStatus: { configured: false, durability: 'missing' as const },
    };
    let state: ReturnType<typeof useAiWindowAuthority> | null = null;
    const Harness = defineComponent({
      setup() {
        state = useAiWindowAuthority(target, {
          emit: async (event, payload) => {
            emitted.push({ event, payload });
          },
          listen: (async (_event: string, callback: (event: { payload: unknown }) => void) => {
            listener = callback;
            return unlisten;
          }) as never,
          requestId: () => 'authority-request-id',
        });
        return () => h('div');
      },
    });
    const wrapper = mount(Harness);
    await flushPromises();
    expect(emitted[0]?.event).toBe(AI_BRIDGE_EVENTS.authorityRequest);
    const request = parseAiBridgeEnvelope(emitted[0]?.payload, 'ai-assistant');
    expect(request).toMatchObject({
      workspaceId: AI_BRIDGE_WORKSPACE_ID,
      revision: 0,
      requestId: 'authority-request-id',
      sessionId: 'no-session',
    });

    listener?.({
      payload: createAiBridgeEnvelope({
        revision: 3,
        origin: 'main',
        requestId: 'authority-3',
        sessionId: 'no-session',
        payload: {
          kind: 'authority-snapshot',
          theme: 'light',
          locale: 'en',
          aiKeyStatus: { configured: true, durability: 'session' },
        },
      }),
    });
    expect(state?.revision.value).toBe(3);
    expect(state?.ready.value).toBe(true);
    expect(target.setTheme).toHaveBeenCalledWith('light');
    expect(target.setLocale).toHaveBeenCalledWith('en');
    assert.deepEqual(target.aiKeyStatus, { configured: true, durability: 'session' });

    listener?.({ payload: validEnvelope({ kind: 'authority-snapshot', theme: 'sepia' }) });
    expect(state?.revision.value).toBe(3);
    wrapper.unmount();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  test('keeps authority not-ready when listener setup or request emission fails', async () => {
    for (const failAt of ['listen', 'emit'] as const) {
      let state: ReturnType<typeof useAiWindowAuthority> | null = null;
      const Harness = defineComponent({
        setup() {
          state = useAiWindowAuthority(
            {
              setTheme: vi.fn(),
              setLocale: vi.fn(),
              aiKeyStatus: { configured: false, durability: 'missing' },
            },
            {
              emit: async () => {
                if (failAt === 'emit') throw new Error('emit unavailable');
              },
              listen: (async () => {
                if (failAt === 'listen') throw new Error('listen unavailable');
                return vi.fn();
              }) as never,
            },
          );
          return () => h('div');
        },
      });
      const wrapper = mount(Harness);
      await flushPromises();
      expect(state?.ready.value).toBe(false);
      wrapper.unmount();
    }
  });

  test('rejects malformed and stale authority envelopes without mutating the target', () => {
    const target = {
      setTheme: vi.fn(),
      setLocale: vi.fn(),
      aiKeyStatus: { configured: false, durability: 'missing' as const },
    };
    expect(applyAiAuthorityEnvelope(null, 0, target)).toBeNull();
    expect(
      applyAiAuthorityEnvelope(validEnvelope({ kind: 'authority-request' }), 0, target),
    ).toBeNull();
    expect(
      applyAiAuthorityEnvelope(
        createAiBridgeEnvelope({
          revision: 1,
          origin: 'main',
          requestId: 'authority-old',
          sessionId: 'no-session',
          payload: {
            kind: 'authority-snapshot',
            theme: 'dark',
            locale: 'zh',
            aiKeyStatus: { configured: false, durability: 'missing' },
          },
        }),
        2,
        target,
      ),
    ).toBeNull();
    expect(target.setTheme).not.toHaveBeenCalled();
  });
});
