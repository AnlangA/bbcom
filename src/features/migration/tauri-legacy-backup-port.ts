import { invoke } from '@tauri-apps/api/core';
import type {
  BeginLegacyBackupRequest,
  BeginLegacyBackupResponse,
  LegacyBackupContent as WireLegacyBackupContent,
  VerifyLegacyBackupRequest,
  VerifyLegacyBackupResponse,
} from '../../generated/ipc-contracts';
import type { LegacyPassphraseBackupPort } from './legacy-reset-bootstrap';
import type {
  LegacyBackupContent,
  LegacyBackupReceipt,
  LegacyBackupVerification,
  LegacyReadContext,
} from './types';

let requestSequence = 0;

/** Native age backup transport. Only generated request/response DTOs cross IPC. */
export class TauriLegacyBackupPort implements LegacyPassphraseBackupPort {
  async beginEncryptedBackup(
    content: LegacyBackupContent,
    passphrase: string,
    context: LegacyReadContext,
  ): Promise<LegacyBackupReceipt> {
    throwIfAborted(context.signal);
    const requestId = nextRequestId('begin');
    const request: BeginLegacyBackupRequest = {
      requestId,
      suggestedName: 'bbcom-0.7.3-legacy-backup.bbcom.age',
      passphrase,
      passphraseConfirmation: passphrase,
      content: toWireContent(content),
    };
    const response = await invoke<BeginLegacyBackupResponse>('begin_legacy_backup', { request });
    throwIfAborted(context.signal);
    if (response.requestId !== requestId || !validOpaqueId(response.backupId)) {
      throw new Error('invalid legacy backup receipt');
    }
    return Object.freeze({ backupId: response.backupId });
  }

  async verifyEncryptedBackup(
    receipt: LegacyBackupReceipt,
    expectedContent: LegacyBackupContent,
    passphrase: string,
    context: LegacyReadContext,
  ): Promise<LegacyBackupVerification> {
    throwIfAborted(context.signal);
    if (!validOpaqueId(receipt.backupId)) throw new Error('invalid legacy backup receipt');
    const requestId = nextRequestId('verify');
    const request: VerifyLegacyBackupRequest = {
      requestId,
      backupId: receipt.backupId,
      passphrase,
      expectedContent: toWireContent(expectedContent),
    };
    const response = await invoke<VerifyLegacyBackupResponse>('verify_legacy_backup', { request });
    throwIfAborted(context.signal);
    if (response.requestId !== requestId || response.backupId !== receipt.backupId) {
      throw new Error('legacy backup verification correlation failed');
    }
    return Object.freeze({ verified: response.verified === true });
  }
}

function toWireContent(content: LegacyBackupContent): WireLegacyBackupContent {
  return {
    format: content.format,
    sourceVersion: content.sourceVersion,
    createdAtMs: content.createdAtMs,
    snapshot: content.snapshot,
    settings: content.settings,
    presets: content.presets,
  };
}

function nextRequestId(scope: string): string {
  requestSequence += 1;
  const uuid = globalThis.crypto?.randomUUID?.() ?? requestSequence.toString(36);
  return `legacy-${scope}-${uuid}`;
}

function validOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('legacy backup operation aborted');
  error.name = 'AbortError';
  throw error;
}
