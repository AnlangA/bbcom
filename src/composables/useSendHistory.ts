import { useSessionStore } from '../stores/sessions';
import type { SendHistoryEntry } from '../types';

export function useSendHistory(sessionId: string) {
  const sessionStore = useSessionStore();

  function addSendHistory(entry: SendHistoryEntry) {
    sessionStore.addSendHistory(sessionId, entry);
  }

  function clearSendHistory() {
    sessionStore.clearSendHistory(sessionId);
  }

  function setSendDraft(draft: string) {
    sessionStore.setSendDraft(sessionId, draft);
  }

  return {
    addSendHistory,
    clearSendHistory,
    setSendDraft,
  };
}
