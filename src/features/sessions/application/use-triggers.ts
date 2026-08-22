import { computed, watch, type Ref } from 'vue';
import { TriggerEngine, type Trigger, type TriggerFire } from '@/lib/trigger-engine';
import type { DataFrame } from '@/types';

interface TriggerOptions {
  triggers: Ref<Trigger[]>;
  /** Sends a response payload; mirrors SessionView.handleSend. */
  send: (data: string, isHex: boolean) => Promise<boolean>;
  /** Optional sink for fired triggers (e.g. to log or toast). */
  onFire?: (fire: TriggerFire) => void;
}

/**
 * Bridges the TriggerEngine to a session's RX stream. Feed it each RX frame's
 * bytes; it matches against the configured triggers and sends any responses via
 * the session's serialized `send` (so trigger responses never overlap other TX).
 *
 * The engine instance is rebuilt whenever the trigger set changes (an edit),
 * which also resets its rolling buffer — correct, because a config change
 * invalidates any partial-match state.
 */
export function useTriggers({ triggers, send, onFire }: TriggerOptions) {
  // Build the engine from the current triggers and keep it in sync.
  const engine = new TriggerEngine(triggers.value);

  watch(
    triggers,
    (next) => {
      engine.setTriggers(next);
    },
    { deep: true },
  );

  // Matching is synchronous, so each raw RX chunk updates the streaming
  // decoder immediately. Responses themselves stay FIFO without blocking a
  // later chunk from entering the matcher.
  let sendTail: Promise<void> = Promise.resolve();
  let paused = false;

  /** Feed raw RX bytes through the matcher and queue any responses in FIFO order. */
  function feedBytes(bytes: Uint8Array): Promise<void> {
    if (triggers.value.length === 0) return Promise.resolve();
    const fires = engine.feed(bytes);
    if (paused) return Promise.resolve();
    for (const fire of fires) onFire?.(fire);
    if (fires.length === 0) return Promise.resolve();

    const operation = sendTail.then(async () => {
      for (const fire of fires) {
        if (paused) break;
        await send(fire.response, fire.responseIsHex);
      }
    });
    // Keep the next batch live even if one response fails; callers still get
    // the original rejection so runtime logging can surface it.
    sendTail = operation.catch(() => undefined);
    return operation;
  }

  /** Backward-compatible frame adapter for callers that have captured frames. */
  function feedFrame(frame: DataFrame): Promise<void> {
    if (frame.direction !== 'RX') return Promise.resolve();
    return feedBytes(frame.data);
  }

  /** Reset matcher state (e.g. on capture clear). */
  function reset(): void {
    engine.reset();
  }

  async function pause(signal?: AbortSignal): Promise<void> {
    paused = true;
    if (signal?.aborted) {
      paused = false;
      throw new Error('trigger pause cancelled');
    }
    let detachAbort: () => void = () => undefined;
    try {
      await Promise.race([
        sendTail,
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error('trigger pause cancelled'));
          signal?.addEventListener('abort', onAbort, { once: true });
          detachAbort = () => signal?.removeEventListener('abort', onAbort);
        }),
      ]);
    } catch (error) {
      paused = false;
      throw error;
    } finally {
      detachAbort();
    }
  }

  function resume(): void {
    paused = false;
  }

  const enabledCount = computed(() => triggers.value.filter((t) => t.enabled).length);

  return { feedBytes, feedFrame, reset, pause, resume, enabledCount };
}
