import type { GlobalSettingsV2 } from './global-settings';
import { GLOBAL_SETTINGS_VERSION } from './global-settings';
import type {
  GlobalSettingsDocument,
  GlobalSettingsRepository,
} from './browser-settings-repository';

export type SettingsHealth = 'idle' | 'pending' | 'failed';

export type GlobalSettingsPatch = Partial<Omit<GlobalSettingsV2, 'version'>>;

export interface SettingsServiceSnapshot {
  readonly settings: GlobalSettingsV2;
  readonly health: SettingsHealth;
}

/**
 * The only writer of global settings. Owns the single 300 ms debounce, the
 * synchronous shutdown flush, and the observable write-health state; every
 * store and component reaches durable settings through this service.
 */
export class SettingsService {
  private readonly repository: GlobalSettingsRepository;
  private readonly debounceMs: number;
  private listeners = new Set<(snapshot: SettingsServiceSnapshot) => void>();
  private document: GlobalSettingsDocument | null = null;
  private health: SettingsHealth = 'idle';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(repository: GlobalSettingsRepository, debounceMs = 300) {
    this.repository = repository;
    this.debounceMs = debounceMs;
  }

  private current(): GlobalSettingsDocument {
    if (this.document === null) this.document = this.repository.load();
    return this.document;
  }

  /** Load once, synchronously, before the app mounts. Idempotent. */
  hydrate(): GlobalSettingsDocument {
    const document = this.current();
    return {
      settings: Object.freeze({ ...document.settings }),
      legacySidebar: document.legacySidebar ? Object.freeze({ ...document.legacySidebar }) : null,
    };
  }

  snapshot(): SettingsServiceSnapshot {
    const document = this.current();
    return Object.freeze({
      settings: Object.freeze({ ...document.settings }),
      health: this.health,
    });
  }

  /** Merge a partial update and schedule the single coalesced physical write. */
  update(patch: GlobalSettingsPatch): void {
    const document = this.current();
    this.document = {
      ...document,
      settings: { ...document.settings, ...patch, version: GLOBAL_SETTINGS_VERSION },
    };
    if (this.timer !== null) clearTimeout(this.timer);
    this.health = 'pending';
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, this.debounceMs);
    this.notify();
  }

  /** Cancel any pending debounce and synchronously persist the current settings. */
  flush(): boolean {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.health === 'idle') return true;
    return this.write();
  }

  subscribe(listener: (snapshot: SettingsServiceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Test-only: drop the cached document, cancel any pending debounce, and
   * reset health so the next access re-reads freshly installed storage.
   */
  resetForTests(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.document = null;
    this.health = 'idle';
  }

  private write(): boolean {
    const saved = this.repository.save(this.current().settings);
    this.health = saved ? 'idle' : 'failed';
    this.notify();
    return saved;
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers cannot change persistence semantics.
      }
    }
  }
}
