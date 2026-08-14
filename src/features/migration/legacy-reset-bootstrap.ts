import { LegacyWorkspaceResetCoordinator } from './legacy-workspace-reset';
import type { LegacyResetContext } from './legacy-reset-context';
import { webStorageLegacyResetMarkerStore, type LegacyResetWebStorage } from './marker-store';
import { TauriLegacyResetPort } from './tauri-legacy-reset-port';
import type {
  LegacyBackupPort,
  LegacyReadOnlySource,
  LegacyResetNativePort,
  LegacyWorkspaceResetOptions,
  WorkspaceResetTarget,
} from './types';

export interface LegacyResetBootstrapOptions {
  readonly source: LegacyReadOnlySource;
  /**
   * Required native boundary. It must create an encrypted .bbcom artifact and
   * independently reopen/decrypt it during verification. There is deliberately
   * no renderer fallback for this security-sensitive operation.
   */
  readonly backupPort: LegacyPassphraseBackupPort;
  readonly target: WorkspaceResetTarget;
  readonly markerStorage: LegacyResetWebStorage;
  readonly resetPort?: LegacyResetNativePort;
  readonly coordinator?: LegacyWorkspaceResetOptions;
}

export interface LegacyPassphraseBackupPort {
  beginEncryptedBackup(
    content: Parameters<LegacyBackupPort['beginEncryptedBackup']>[0],
    passphrase: string,
    context: Parameters<LegacyBackupPort['beginEncryptedBackup']>[1],
  ): ReturnType<LegacyBackupPort['beginEncryptedBackup']>;
  verifyEncryptedBackup(
    receipt: Parameters<LegacyBackupPort['verifyEncryptedBackup']>[0],
    expectedContent: Parameters<LegacyBackupPort['verifyEncryptedBackup']>[1],
    passphrase: string,
    context: Parameters<LegacyBackupPort['verifyEncryptedBackup']>[2],
  ): ReturnType<LegacyBackupPort['verifyEncryptedBackup']>;
}

/** Build the single app-scoped reset context before mounting the main window. */
export function createLegacyResetBootstrap(
  options: LegacyResetBootstrapOptions,
): LegacyResetContext {
  const coordinator = new LegacyWorkspaceResetCoordinator(
    options.source,
    unavailablePassphraseFallback,
    options.target,
    webStorageLegacyResetMarkerStore(options.markerStorage),
    {
      ...options.coordinator,
      nativePort:
        options.resetPort ?? options.coordinator?.nativePort ?? new TauriLegacyResetPort(),
    },
  );
  return Object.freeze({
    coordinator,
    start: () => coordinator.start(),
    createVerifiedBackup: (passphrase: string) =>
      coordinator.createVerifiedBackup({
        beginEncryptedBackup: (content, context) =>
          options.backupPort.beginEncryptedBackup(content, passphrase, context),
        verifyEncryptedBackup: (receipt, content, context) =>
          options.backupPort.verifyEncryptedBackup(receipt, content, passphrase, context),
      } satisfies LegacyBackupPort),
  });
}

const unavailablePassphraseFallback: LegacyBackupPort = Object.freeze({
  beginEncryptedBackup: () => Promise.reject(new Error('backup passphrase is required')),
  verifyEncryptedBackup: () => Promise.reject(new Error('backup passphrase is required')),
});
