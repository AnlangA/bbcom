import { computed, watch, type Ref } from 'vue';
import { TriggerEngine, type Trigger, type TriggerFire } from '../lib/trigger-engine';
import type { DataFrame } from '../types';

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

  /** Feed an RX frame's bytes through the matcher and fire any responses. */
  async function feedFrame(frame: DataFrame): Promise<void> {
    if (frame.direction !== 'RX') return;
    if (triggers.value.length === 0) return;
    const fires = engine.feed(frame.data);
    for (const fire of fires) {
      onFire?.(fire);
      await send(fire.response, fire.responseIsHex);
    }
  }

  /** Reset matcher state (e.g. on capture clear). */
  function reset(): void {
    engine.reset();
  }

  const enabledCount = computed(() => triggers.value.filter((t) => t.enabled).length);

  return { feedFrame, reset, enabledCount };
}
