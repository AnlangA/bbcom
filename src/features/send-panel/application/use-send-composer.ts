import { computed, onScopeDispose, ref, watch } from 'vue';
import { appendLineEnding, computeSendByteCount, isValidHex, parseHex } from '@/lib/format';
import { MAX_INPUT_SIZE } from '@/types';
import type { ChecksumType, LineEnding } from '@/types';

export interface SendComposerState {
  input: string;
  isHex: boolean;
  lineEnding: LineEnding;
  checksum: 'none' | ChecksumType;
  disabled?: boolean;
  looping: boolean;
  sessionId?: string;
}

interface SendComposerDependencies {
  getState: () => SendComposerState;
  calculateChecksum: (data: Uint8Array, algorithm: ChecksumType) => Promise<{ result: string }>;
  send: (data: string, isHex: boolean) => Promise<boolean>;
  startLoop: (data: string, isHex: boolean) => boolean;
  stopLoop: () => void;
  updateInput: (input: string) => void;
  onSent: () => void;
  onError: (key: 'send.error.tooLarge' | 'send.error.failed') => void;
  onWarning: (key: 'send.error.checksumFailed') => void;
}

/** Owns payload preparation and asynchronous sending, independent of UI and stores. */
export function useSendComposer(deps: SendComposerDependencies) {
  const pending = ref<'send' | 'loop' | null>(null);
  let disposed = false;
  let connectionRevision = 0;
  const validHex = computed(() => {
    const state = deps.getState();
    return !state.isHex || !state.input.trim() || isValidHex(state.input);
  });
  const byteCount = computed(() => {
    const state = deps.getState();
    return computeSendByteCount(state.input, state.isHex, state.checksum, state.lineEnding);
  });
  const canSend = computed(() => {
    const state = deps.getState();
    return !disposed && !state.disabled && !pending.value && !!state.input.trim() && validHex.value;
  });

  watch(
    [() => deps.getState().disabled, () => deps.getState().sessionId],
    ([disabled]) => {
      connectionRevision += 1;
      if (disabled && deps.getState().looping) deps.stopLoop();
    },
    { flush: 'sync' },
  );

  onScopeDispose(() => {
    disposed = true;
    connectionRevision += 1;
  });

  async function buildPayload(state: SendComposerState): Promise<string | null> {
    if (state.input.length > MAX_INPUT_SIZE) {
      deps.onError('send.error.tooLarge');
      return null;
    }
    if (!state.isHex) return appendLineEnding(state.input, state.lineEnding);
    if (state.checksum === 'none') return state.input;
    try {
      const checksum = await deps.calculateChecksum(parseHex(state.input), state.checksum);
      return `${state.input} ${checksum.result}`;
    } catch {
      deps.onWarning('send.error.checksumFailed');
      return state.input;
    }
  }

  async function run(action: 'send' | 'loop'): Promise<void> {
    if (disposed || !canSend.value || (action === 'loop' && deps.getState().looping)) return;
    // Capture mode and data together; a setting or draft can change while IPC awaits.
    const snapshot = { ...deps.getState() };
    const revision = connectionRevision;
    pending.value = action;
    const isCurrent = () =>
      !disposed && revision === connectionRevision && !deps.getState().disabled;
    try {
      const data = await buildPayload(snapshot);
      if (data === null || !isCurrent()) return;
      if (action === 'loop') {
        if (!deps.getState().looping && !deps.startLoop(data, snapshot.isHex)) {
          deps.onError('send.error.failed');
        }
        return;
      }
      const sent = await deps.send(data, snapshot.isHex);
      if (!isCurrent()) return;
      if (!sent) {
        deps.onError('send.error.failed');
        return;
      }
      const current = deps.getState();
      if (
        !current.looping &&
        current.input === snapshot.input &&
        current.isHex === snapshot.isHex
      ) {
        deps.updateInput('');
      }
      deps.onSent();
    } catch {
      if (isCurrent()) deps.onError('send.error.failed');
    } finally {
      pending.value = null;
    }
  }

  function toggleLoop(): Promise<void> | void {
    if (deps.getState().looping) deps.stopLoop();
    else return run('loop');
  }

  return { pending, validHex, byteCount, canSend, send: () => run('send'), toggleLoop };
}
