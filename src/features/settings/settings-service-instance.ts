import {
  BrowserSettingsRepository,
  type GlobalSettingsRepository,
} from './browser-settings-repository';
import { SettingsService } from './settings-service';

/**
 * Process-wide settings service. Exactly one instance owns the debounce and
 * the physical writes; `main.ts` hydrates it before the application mounts.
 */
export const settingsService = new SettingsService(new BrowserSettingsRepository());

export function createSettingsService(repository: GlobalSettingsRepository): SettingsService {
  return new SettingsService(repository);
}

/** Test-only: re-read freshly installed storage on the next access. */
export function resetSettingsServiceForTests(): void {
  settingsService.resetForTests();
}
