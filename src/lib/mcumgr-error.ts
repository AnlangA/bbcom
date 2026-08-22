import type { McumgrError, McumgrErrorKind } from '@/generated/ipc-contracts';
import { t } from './i18n';

/** MCUmgr SMP group ids (Zephyr `mcumgr_group_t`). */
const MCUMGR_GROUPS: Record<number, string> = {
  0: 'mcumgr.smpGroup.os',
  1: 'mcumgr.smpGroup.image',
  2: 'mcumgr.smpGroup.stat',
  3: 'mcumgr.smpGroup.settings',
  8: 'mcumgr.smpGroup.fs',
  9: 'mcumgr.smpGroup.shell',
  10: 'mcumgr.smpGroup.enum',
  63: 'mcumgr.smpGroup.zephyr',
};

/** Standard SMP return codes (`mcumgr_err_t`). */
const MGMT_RC_KEYS: Record<number, string> = {
  0: 'mcumgr.error.smp.ok',
  1: 'mcumgr.error.smp.unknown',
  2: 'mcumgr.error.smp.noMemory',
  3: 'mcumgr.error.smp.invalidArg',
  4: 'mcumgr.error.smp.timeout',
  5: 'mcumgr.error.smp.notFound',
  6: 'mcumgr.error.smp.badState',
  7: 'mcumgr.error.smp.msgTooLarge',
  8: 'mcumgr.error.smp.notSupported',
  9: 'mcumgr.error.smp.corrupt',
  10: 'mcumgr.error.smp.busy',
  11: 'mcumgr.error.smp.accessDenied',
  12: 'mcumgr.error.smp.unsupportedTooOld',
  13: 'mcumgr.error.smp.unsupportedTooNew',
};

/** Group-specific SMP codes returned as prose by mcumgr-toolkit. */
const SMP_CODE_MESSAGE_KEYS: Record<string, string> = {
  MGMT_ERR_EOK: 'mcumgr.error.smp.ok',
  MGMT_ERR_EUNKNOWN: 'mcumgr.error.smp.unknown',
  MGMT_ERR_ENOMEM: 'mcumgr.error.smp.noMemory',
  MGMT_ERR_EINVAL: 'mcumgr.error.smp.invalidArg',
  MGMT_ERR_ETIMEOUT: 'mcumgr.error.smp.timeout',
  MGMT_ERR_ENOENT: 'mcumgr.error.smp.notFound',
  MGMT_ERR_EBADSTATE: 'mcumgr.error.smp.badState',
  MGMT_ERR_EMSGSIZE: 'mcumgr.error.smp.msgTooLarge',
  MGMT_ERR_ENOTSUP: 'mcumgr.error.smp.notSupported',
  MGMT_ERR_ECORRUPT: 'mcumgr.error.smp.corrupt',
  MGMT_ERR_EBUSY: 'mcumgr.error.smp.busy',
  MGMT_ERR_EACCESSDENIED: 'mcumgr.error.smp.accessDenied',
  MGMT_ERR_UNSUPPORTED_TOO_OLD: 'mcumgr.error.smp.unsupportedTooOld',
  MGMT_ERR_UNSUPPORTED_TOO_NEW: 'mcumgr.error.smp.unsupportedTooNew',
  SHELL_MGMT_ERR_COMMAND_TOO_LONG: 'mcumgr.error.smp.shell.commandTooLong',
  SHELL_MGMT_ERR_EMPTY_COMMAND: 'mcumgr.error.smp.shell.emptyCommand',
  IMG_MGMT_ERR_NO_IMAGE: 'mcumgr.error.smp.image.noImage',
  IMG_MGMT_ERR_HASH_NOT_FOUND: 'mcumgr.error.smp.image.hashNotFound',
  IMG_MGMT_ERR_NO_FREE_SLOT: 'mcumgr.error.smp.image.noFreeSlot',
  FS_MGMT_ERR_FILE_NOT_FOUND: 'mcumgr.error.smp.fs.fileNotFound',
  SETTINGS_MGMT_ERR_KEY_NOT_FOUND: 'mcumgr.error.smp.settings.keyNotFound',
};

const KIND_KEYS: Record<McumgrErrorKind, string> = {
  busy: 'mcumgr.error.kind.busy',
  cancelled: 'mcumgr.error.kind.cancelled',
  timeout: 'mcumgr.error.kind.timeout',
  port: 'mcumgr.error.kind.port',
  device: 'mcumgr.error.kind.device',
  protocol: 'mcumgr.error.kind.protocol',
  'invalid-input': 'mcumgr.error.kind.invalidInput',
  io: 'mcumgr.error.kind.io',
};

const ACTION_KEYS: Record<string, string> = {
  echo: 'mcumgr.action.echo',
  tasks: 'mcumgr.action.tasks',
  mpstat: 'mcumgr.action.mpstat',
  datetime: 'mcumgr.action.datetime',
  params: 'mcumgr.action.params',
  info: 'mcumgr.action.info',
  bootloader: 'mcumgr.action.bootloader',
  reset: 'mcumgr.action.reset',
  'image-state': 'mcumgr.action.imageState',
  'slot-info': 'mcumgr.action.slotInfo',
  'image-erase': 'mcumgr.action.imageErase',
  'image-test': 'mcumgr.action.imageTest',
  'image-confirm': 'mcumgr.action.imageConfirm',
  'firmware-update': 'mcumgr.action.firmwareUpdate',
  'image-upload': 'mcumgr.action.imageUpload',
  'fs-upload': 'mcumgr.action.fsUpload',
  'fs-download': 'mcumgr.action.fsDownload',
  'fs-status': 'mcumgr.action.fsStatus',
  'fs-hash': 'mcumgr.action.fsHash',
  'fs-close': 'mcumgr.action.fsClose',
  'settings-read': 'mcumgr.action.settingsRead',
  'settings-write': 'mcumgr.action.settingsWrite',
  'settings-delete': 'mcumgr.action.settingsDelete',
  'settings-commit': 'mcumgr.action.settingsCommit',
  'settings-load': 'mcumgr.action.settingsLoad',
  'settings-save': 'mcumgr.action.settingsSave',
  'stats-list': 'mcumgr.action.statsList',
  'stats-show': 'mcumgr.action.statsShow',
  'enum-list': 'mcumgr.action.enumList',
  'enum-count': 'mcumgr.action.enumCount',
  'enum-details': 'mcumgr.action.enumDetails',
  'zephyr-erase': 'mcumgr.action.zephyrErase',
  shell: 'mcumgr.action.shell',
  raw: 'mcumgr.action.raw',
};

/** Localized label for a MCUmgr panel action id. */
export function getMcumgrActionLabel(action: string): string {
  const key = ACTION_KEYS[action];
  return key ? t(key) : action;
}

/** Primary user-facing error line for status badges and toasts. */
export function getMcumgrErrorMessage(error: McumgrError): string {
  if (error.kind === 'cancelled') return t(KIND_KEYS.cancelled);

  const deviceMessage = localizeDeviceError(error);
  if (deviceMessage) return deviceMessage;

  const rustMessage = localizeRustMessage(error);
  if (rustMessage) return rustMessage;

  const kindKey = KIND_KEYS[error.kind];
  if (kindKey) return t(kindKey);

  return t('mcumgr.error.fallback');
}

/** Richer error text for the result panel (summary + optional hint). */
export function formatMcumgrErrorDetail(error: McumgrError): string {
  const summary = getMcumgrErrorMessage(error);
  const lines = [summary];

  if (error.group !== undefined) {
    const groupKey = MCUMGR_GROUPS[error.group];
    const groupName = groupKey ? t(groupKey) : String(error.group);
    lines.push(t('mcumgr.error.detail.group', { group: groupName }));
  }
  if (error.rc !== undefined) {
    lines.push(t('mcumgr.error.detail.code', { code: error.rc }));
  }

  const hint = errorHint(error);
  if (hint) lines.push('', hint);

  return lines.join('\n');
}

function localizeDeviceError(error: McumgrError): string | null {
  if (error.kind !== 'device') return null;

  const fromCode = resolveSmpCodeMessage(error.message);
  if (fromCode) return fromCode;

  if (error.rc !== undefined) {
    const rcKey = MGMT_RC_KEYS[error.rc];
    if (rcKey) return t(rcKey);
    return t('mcumgr.error.smp.unknownCode', { code: error.rc });
  }

  return t(KIND_KEYS.device);
}

function resolveSmpCodeMessage(message: string): string | null {
  const token = message.split(':')[0]?.trim();
  if (!token) return null;
  const key = SMP_CODE_MESSAGE_KEYS[token];
  return key ? t(key) : null;
}

function localizeRustMessage(error: McumgrError): string | null {
  const message = error.message;

  if (error.kind === 'port' && message.startsWith('failed to open serial port')) {
    const detail = message.replace(/^failed to open serial port:\s*/i, '').trim();
    return detail ? t('mcumgr.error.portOpenDetail', { detail }) : t('mcumgr.error.portOpen');
  }

  if (error.kind === 'timeout') return t(KIND_KEYS.timeout);

  if (error.kind === 'busy' || message.includes('another MCUmgr operation is still running')) {
    return t(KIND_KEYS.busy);
  }

  if (message === 'the device is already running this firmware') {
    return t('mcumgr.error.firmware.alreadyInstalled');
  }
  if (message.startsWith("bootloader '") && message.endsWith("' is not supported")) {
    const name = message.slice("bootloader '".length, -"' is not supported".length);
    return t('mcumgr.error.firmware.bootloaderUnsupported', { name });
  }
  if (message === 'unknown or already used file grant') {
    return t('mcumgr.error.grant.invalid');
  }
  if (message === 'file grant does not match the requested operation') {
    return t('mcumgr.error.grant.mismatch');
  }
  if (message === 'serial port path is empty or too long') {
    return t('mcumgr.error.invalid.portPath');
  }
  if (message === 'baud rate must be positive') {
    return t('mcumgr.error.invalid.baudRate');
  }
  if (message === 'shell command must not be empty') {
    return t('mcumgr.error.invalid.shellEmpty');
  }
  if (message === 'echo message too large') {
    return t('mcumgr.error.invalid.echoTooLarge');
  }
  if (message.startsWith('failed to read file')) {
    return t('mcumgr.error.io.readFile');
  }
  if (message === 'file dialog task failed' || message === 'save dialog task failed') {
    return t('mcumgr.error.io.dialog');
  }
  if (error.kind === 'protocol') {
    return t(KIND_KEYS.protocol);
  }
  if (error.kind === 'io') {
    return t(KIND_KEYS.io);
  }
  if (error.kind === 'invalid-input') {
    return t(KIND_KEYS['invalid-input']);
  }

  return null;
}

function errorHint(error: McumgrError): string | null {
  const isNotSupported =
    error.rc === 8 ||
    error.message.includes('MGMT_ERR_ENOTSUP') ||
    error.message.includes('NOT_SUPPORTED') ||
    error.message.includes('READ_NOT_SUPPORTED') ||
    error.message.includes('WRITE_NOT_SUPPORTED');

  if (isNotSupported) return t('mcumgr.error.hint.notSupported');

  if (error.kind === 'timeout') return t('mcumgr.error.hint.timeout');
  if (error.kind === 'port') return t('mcumgr.error.hint.port');
  if (error.kind === 'protocol') return t('mcumgr.error.hint.protocol');

  return null;
}

/** Build a McumgrError for frontend-only failures. */
export function mcumgrFrontendError(kind: McumgrErrorKind, messageKey: string): McumgrError {
  return { kind, message: t(messageKey) };
}
