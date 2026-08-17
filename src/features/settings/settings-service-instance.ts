import {
  BrowserSettingsRepository,
  type GlobalSettingsDocument,
  type GlobalSettingsRepository,
} from './browser-settings-repository';
import { SettingsService } from './settings-service';

function isAiAssistantWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('window') === 'ai';
}

/**
 * Read-only passthrough used by the AI assistant webview. Both webviews share
 * one localStorage document, so a second writer holding a stale snapshot would
 * clobber concurrent main-window edits (last-writer-wins). The AI renderer
 * receives authoritative theme/locale/key updates through the ai-activity
 * bridge and must never persist settings itself.
 */
class ReadOnlySettingsRepository implements GlobalSettingsRepository {
  constructor(private readonly inner: GlobalSettingsRepository) {}

  load(): GlobalSettingsDocument {
    return this.inner.load();
  }

  save(): boolean {
    return false;
  }
}

/**
 * Process-wide settings service. Exactly one instance owns the debounce and
 * the physical writes; `main.ts` hydrates it before the application mounts.
 * The AI window variant never writes — the main window is the sole persisting
 * authority for the shared document.
 */
export const settingsService = new SettingsService(
  isAiAssistantWindow()
    ? new ReadOnlySettingsRepository(new BrowserSettingsRepository())
    : new BrowserSettingsRepository(),
);

export function createSettingsService(repository: GlobalSettingsRepository): SettingsService {
  return new SettingsService(repository);
}

/** Test-only: re-read freshly installed storage on the next access. */
export function resetSettingsServiceForTests(): void {
  settingsService.resetForTests();
}
