import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  useSessionCapture,
  useSessionCatalog,
  useSessionDocument,
  useSessionMutationPolicy,
  useSessionWaveform,
} from '../../src/features/sessions';

describe('public session ports', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('selects one shared state graph without copying refs', () => {
    const catalog = useSessionCatalog();
    const policy = useSessionMutationPolicy();
    const id = catalog.create('COM1', {
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      rxFrameGapMs: 10,
    });
    expect(id).toBeTruthy();
    expect(policy.userMutationsAllowed.value).toBe(true);

    const capture = useSessionCapture(id!);
    const document = useSessionDocument(id!);
    const waveform = useSessionWaveform(id!);
    expect(capture.session.value).toBe(catalog.sessions.value[0]);
    expect(document.session.value).toBe(catalog.sessions.value[0]);
    expect(waveform.state.value).toBeTruthy();
  });
});
