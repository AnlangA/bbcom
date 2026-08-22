import { ref, type Ref } from 'vue';

/**
 * Two-step inline confirmation for destructive icon buttons: the first click
 * arms the control (visual "confirm?" state), a second click within
 * `timeoutMs` executes. Keeps destructive actions discoverable without a
 * blocking native dialog inside the Tauri webview.
 */
export function useConfirmRemove(
  onConfirm: (id: string) => void,
  timeoutMs = 3000,
): { armedId: Ref<string | null>; request: (id: string) => void; disarm: () => void } {
  const armedId: Ref<string | null> = ref(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function request(id: string): void {
    if (armedId.value === id) {
      disarm();
      onConfirm(id);
      return;
    }
    armedId.value = id;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      armedId.value = null;
      timer = null;
    }, timeoutMs);
  }

  function disarm(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    armedId.value = null;
  }

  return { armedId, request, disarm };
}
