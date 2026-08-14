import { describe, expect, test, vi } from 'vitest';
import {
  PluginCenterService,
  type PluginCenterData,
  type PluginCenterPort,
  type PluginPortOutcome,
} from '../../src/features/plugins';

function data(overrides: Partial<PluginCenterData> = {}): PluginCenterData {
  return {
    revision: 1,
    catalog: [],
    installed: [],
    authorizationReview: null,
    serialProposals: [],
    panels: [],
    ...overrides,
  };
}

function completed(next: PluginCenterData): PluginPortOutcome {
  return { outcome: 'completed', data: next };
}

function createPort(initial: PluginCenterData = data()) {
  let listener: ((snapshot: PluginCenterData) => void) | null = null;
  const port: PluginCenterPort = {
    snapshot: vi.fn(async () => completed(initial)),
    install: vi.fn(async () => completed(data({ revision: 2 }))),
    setEnabled: vi.fn(async () => completed(data({ revision: 2 }))),
    submitAuthorization: vi.fn(async () => completed(data({ revision: 2 }))),
    dismissAuthorization: vi.fn(async () => completed(data({ revision: 2 }))),
    resolveSerialProposal: vi.fn(async () => completed(data({ revision: 2 }))),
    emitPanelEvent: vi.fn(async () => completed(data({ revision: 2 }))),
    subscribe: vi.fn((next) => {
      listener = next;
      return vi.fn();
    }),
  };
  return { port, push: (next: PluginCenterData) => listener?.(next) };
}

describe('PluginCenterService', () => {
  test('owns snapshots outside renderer lifetimes and rejects stale pushes', async () => {
    const { port, push } = createPort();
    const service = new PluginCenterService(port);
    const listener = vi.fn();
    const detach = service.subscribe(listener);
    await service.start();
    detach();
    push(data({ revision: 0 }));
    expect(service.snapshot().failure?.code).toBe('invalid-response');
    expect(service.snapshot().revision).toBe(1);
    expect(port.subscribe).toHaveBeenCalledOnce();
  });

  test('requires explicit composite-risk confirmation and keeps proposals per request', async () => {
    const review = {
      reviewId: 'review-1',
      pluginId: 'tools.capture',
      displayName: 'Capture Tools',
      version: '1.0.0',
      persistentPermissions: ['session.capture.read' as const],
      perRequestPermissions: ['serial.write-proposal' as const],
      unavailableCapabilities: ['network' as const],
      extraConfirmationReasons: ['capture-with-network' as const],
    };
    const proposal = {
      proposalId: 'proposal-1',
      pluginId: 'tools.capture',
      pluginName: 'Capture Tools',
      sessionLabel: 'Session A',
      displayLabel: 'Send query',
      byteCount: 2,
      hexPreview: '01 02',
      expiresAtMs: 1000,
    };
    const { port } = createPort(data({ authorizationReview: review, serialProposals: [proposal] }));
    const service = new PluginCenterService(port);
    await service.start();
    await service.submitAuthorization({
      reviewId: review.reviewId,
      decisions: [{ permission: 'session.capture.read', state: 'granted' }],
      perRequestCapabilitiesAcknowledged: ['serial.write-proposal'],
      extraConfirmationAcknowledged: false,
    });
    expect(port.submitAuthorization).not.toHaveBeenCalled();

    await service.resolveSerialProposal(proposal.proposalId, 'approve');
    expect(port.resolveSerialProposal).toHaveBeenCalledWith(
      proposal.proposalId,
      'approve',
      expect.any(AbortSignal),
    );
  });

  test('filters unsafe declarative panels before the renderer sees them', async () => {
    const { port } = createPort(
      data({
        panels: [
          {
            pluginId: 'unsafe.plugin',
            title: '<img src=x>',
            fields: [
              {
                id: 'run',
                label: 'Run',
                kind: 'button',
                value: '',
                options: [],
                disabled: false,
              },
            ],
          },
        ],
      }),
    );
    const service = new PluginCenterService(port);
    await service.start();
    expect(service.snapshot().panels).toEqual([]);
    expect(service.snapshot().failure?.code).toBe('invalid-panel');
  });

  test('moves a running operation through cancellation without starting another action', async () => {
    let resolve: ((outcome: PluginPortOutcome) => void) | null = null;
    const { port } = createPort(
      data({
        catalog: [
          {
            catalogId: 'catalog.tools',
            pluginId: 'tools.capture',
            displayName: 'Capture Tools',
            description: 'Tools',
            version: '1.0.0',
            publisherName: 'Publisher',
            publisherVerified: false,
            installedVersion: null,
          },
        ],
      }),
    );
    vi.mocked(port.install).mockImplementation(
      (_catalogId, signal) =>
        new Promise((done) => {
          resolve = done;
          signal.addEventListener('abort', () => done({ outcome: 'cancelled' }), { once: true });
        }),
    );
    const service = new PluginCenterService(port);
    await service.start();
    const installing = service.install('catalog.tools');
    service.cancelAction();
    expect(service.snapshot().action?.status).toBe('cancelling');
    await installing;
    expect(service.snapshot().action).toBeNull();
    expect(resolve).not.toBeNull();
  });
});
