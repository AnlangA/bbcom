import { getCurrentInstance, onMounted, onUnmounted, ref, type Ref } from 'vue';
import { emit, listen } from '@tauri-apps/api/event';
import type { AiKeyStatus } from '../../generated/ipc-contracts';
import type { Locale } from '../../lib/i18n';
import {
  AI_BRIDGE_EVENTS,
  AI_BRIDGE_WORKSPACE_ID,
  NO_AI_SESSION_ID,
  createAiBridgeEnvelope,
  isAiAuthorityPayload,
  parseAiBridgeEnvelope,
} from './protocol';

export interface AiWindowAuthorityState {
  readonly revision: Ref<number>;
  readonly ready: Ref<boolean>;
}

export interface AiWindowAuthorityTarget {
  setTheme(theme: 'dark' | 'light'): void;
  setLocale(locale: Locale): void;
  aiKeyStatus: AiKeyStatus;
}

export interface AiWindowAuthorityDependencies {
  emit?: (event: string, payload?: unknown) => Promise<void>;
  listen?: typeof listen;
  requestId?: () => string;
}

export function applyAiAuthorityEnvelope(
  value: unknown,
  currentRevision: number,
  target: AiWindowAuthorityTarget,
): number | null {
  const envelope = parseAiBridgeEnvelope(value, 'main');
  if (!envelope || envelope.revision < currentRevision || !isAiAuthorityPayload(envelope.payload)) {
    return null;
  }
  target.setTheme(envelope.payload.theme);
  target.setLocale(envelope.payload.locale);
  target.aiKeyStatus = Object.freeze({ ...envelope.payload.aiKeyStatus });
  return envelope.revision;
}

/** Apply main-window authority to the floating AI renderer. */
export function useAiWindowAuthority(
  target: AiWindowAuthorityTarget,
  dependencies: AiWindowAuthorityDependencies = {},
): AiWindowAuthorityState {
  const revision = ref(0);
  const ready = ref(false);
  const doEmit = dependencies.emit ?? emit;
  const doListen = dependencies.listen ?? listen;
  const nextRequestId: () => string = dependencies.requestId ?? (() => crypto.randomUUID());
  let unlisten: (() => void) | null = null;

  async function requestAuthority(): Promise<void> {
    const requestId = nextRequestId();
    await doEmit(
      AI_BRIDGE_EVENTS.authorityRequest,
      createAiBridgeEnvelope({
        revision: revision.value,
        origin: 'ai-assistant',
        requestId,
        sessionId: NO_AI_SESSION_ID,
        payload: { kind: 'authority-request' },
      }),
    );
  }

  if (getCurrentInstance()) {
    onMounted(async () => {
      // Some browser-only shells deliberately provide no native event API.
      // Authority remains not-ready there instead of breaking the renderer.
      if (typeof doListen !== 'function') return;
      try {
        unlisten = await doListen<unknown>(AI_BRIDGE_EVENTS.authoritySnapshot, (event) => {
          const next = applyAiAuthorityEnvelope(event.payload, revision.value, target);
          if (next === null) return;
          revision.value = next;
          ready.value = true;
        });
        await requestAuthority();
      } catch {
        ready.value = false;
      }
    });
    onUnmounted(() => unlisten?.());
  }

  return { revision, ready };
}

export { AI_BRIDGE_WORKSPACE_ID };
