import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it } from 'vitest';
import { SessionApplicationService } from '@/features/sessions/session-application-service';
import { useSessionStore } from '@/features/sessions/store/session-store';
import {
  useSessionCapture,
  useSessionCatalog,
  useSessionDocument,
  useSessionMutationPolicy,
} from '@/features/sessions/ports/session-ports';

describe('session application service capture clearing', () => {
  it.each(['paused frames', 'cumulative counters'] as const)(
    'clears %s when the live frame buffer is empty',
    (retainedState) => {
      setActivePinia(createPinia());
      useSessionStore();
      const catalog = useSessionCatalog();
      const service = new SessionApplicationService({
        catalog,
        mutationPolicy: useSessionMutationPolicy(),
        captureFor: useSessionCapture,
        documentFor: useSessionDocument,
        runtimeIsImportant: () => false,
      });
      const id = service.createSession('COM1', {
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        rxFrameGapMs: 10,
      })!;
      const capture = useSessionCapture(id);
      const session = capture.session.value!;
      if (retainedState === 'paused frames') {
        capture.setPaused(true);
        capture.add({ direction: 'RX', data: new Uint8Array([1, 2, 3]) });
      } else {
        session.rxBytes = 3;
        session.rxFrames = 1;
      }
      expect(session.frames).toHaveLength(0);

      expect(service.clearCapture(id)).toBe(true);
      expect(session.pausedFrames).toHaveLength(0);
      expect(session.capturePaused).toBe(false);
      expect(session.rxBytes).toBe(0);
      expect(session.rxFrames).toBe(0);
      expect(service.clearCapture(id)).toBe(false);
    },
  );
});
