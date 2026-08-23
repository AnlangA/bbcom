import { logger } from '@/lib/logger';
import { normalizePortConfig } from '@/lib/session-persistence';
import { loadJson, saveJson } from '@/lib/storage';
import type { PortConfig } from '@/types';

const DEVICE_PROFILE_STORAGE_KEY = 'bbcom-v1:device-profiles';
const DEVICE_PROFILE_VERSION = 1 as const;
const MAX_DEVICE_PROFILES = 128;
const MAX_PROFILE_NAME_LENGTH = 80;
const PORT_CONFIG_KEYS = [
  'baudRate',
  'dataBits',
  'stopBits',
  'parity',
  'flowControl',
  'rxFrameGapMs',
  'dtr',
  'rts',
] as const;

/**
 * A device profile contains reusable, non-sensitive line settings only.
 * Physical port paths and native device handles are deliberately absent from
 * both this public shape and its persisted projection.
 */
export interface DeviceProfile {
  readonly id: string;
  readonly name: string;
  readonly config: PortConfig;
}

interface PersistedDeviceProfileFile {
  readonly version: typeof DEVICE_PROFILE_VERSION;
  readonly profiles: readonly DeviceProfile[];
}

export function deviceProfileConfigsEqual(left: PortConfig, right: PortConfig): boolean {
  return (
    left.baudRate === right.baudRate &&
    left.dataBits === right.dataBits &&
    left.stopBits === right.stopBits &&
    left.parity === right.parity &&
    left.flowControl === right.flowControl &&
    left.rxFrameGapMs === right.rxFrameGapMs &&
    left.dtr === right.dtr &&
    left.rts === right.rts
  );
}

export function describeDeviceProfileConfig(config: PortConfig): string {
  const parity = config.parity === 'none' ? 'N' : config.parity === 'even' ? 'E' : 'O';
  const signals = [config.dtr ? 'DTR' : '', config.rts ? 'RTS' : ''].filter(Boolean).join('+');
  return `${config.baudRate} ${config.dataBits}${parity}${config.stopBits}, ${config.flowControl}${signals ? `, ${signals}` : ''}`;
}

export function loadDeviceProfiles(): DeviceProfile[] {
  try {
    const file = loadJson<Partial<PersistedDeviceProfileFile>>(DEVICE_PROFILE_STORAGE_KEY, {
      version: DEVICE_PROFILE_VERSION,
      profiles: [],
    });
    if (file.version !== DEVICE_PROFILE_VERSION || !Array.isArray(file.profiles)) return [];
    const ids = new Set<string>();
    const profiles: DeviceProfile[] = [];
    for (const candidate of file.profiles.slice(0, MAX_DEVICE_PROFILES)) {
      if (!candidate || typeof candidate !== 'object') continue;
      if (
        typeof candidate.id !== 'string' ||
        !validIdentity(candidate.id) ||
        ids.has(candidate.id)
      ) {
        continue;
      }
      if (typeof candidate.name !== 'string' || isSystemPath(candidate.name)) continue;
      if (!isPersistedPortConfig(candidate.config)) continue;
      ids.add(candidate.id);
      const config = copySafeConfig(candidate.config);
      profiles.push(
        Object.freeze({
          id: candidate.id,
          name: normalizeName(candidate.name, config),
          config: Object.freeze(config),
        }),
      );
    }
    return profiles;
  } catch (error) {
    logger.warn('device profiles: load failed', error);
    return [];
  }
}

export function addDeviceProfile(
  profiles: readonly DeviceProfile[],
  name: string,
  config: PortConfig,
): DeviceProfile[] {
  const safeConfig = copySafeConfig(config);
  const next = [
    ...profiles.slice(-(MAX_DEVICE_PROFILES - 1)),
    Object.freeze({
      id: createProfileId(),
      name: normalizeName(name, safeConfig),
      config: Object.freeze(safeConfig),
    }),
  ];
  persistDeviceProfiles(next);
  return next;
}

export function removeDeviceProfile(
  profiles: readonly DeviceProfile[],
  profileId: string,
): DeviceProfile[] {
  const next = profiles.filter((profile) => profile.id !== profileId);
  persistDeviceProfiles(next);
  return next;
}

function persistDeviceProfiles(profiles: readonly DeviceProfile[]): void {
  const safeProfiles = profiles.slice(0, MAX_DEVICE_PROFILES).map((profile) => ({
    id: validIdentity(profile.id) ? profile.id : createProfileId(),
    name: normalizeName(profile.name, profile.config),
    config: copySafeConfig(profile.config),
  }));
  const file: PersistedDeviceProfileFile = {
    version: DEVICE_PROFILE_VERSION,
    profiles: safeProfiles,
  };
  saveJson(DEVICE_PROFILE_STORAGE_KEY, file);
}

function copySafeConfig(value: unknown): PortConfig {
  const normalized = normalizePortConfig(value);
  return {
    baudRate: normalized.baudRate,
    dataBits: normalized.dataBits,
    stopBits: normalized.stopBits,
    parity: normalized.parity,
    flowControl: normalized.flowControl,
    rxFrameGapMs: normalized.rxFrameGapMs,
    dtr: normalized.dtr,
    rts: normalized.rts,
  };
}

/**
 * Device-profile schema v1 is a strict persistence boundary. Invalid or
 * partially written entries are discarded instead of being repaired with
 * runtime defaults, because such repair could silently change line settings.
 */
function isPersistedPortConfig(value: unknown): value is PortConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  const keys = Object.keys(config);
  if (keys.length !== PORT_CONFIG_KEYS.length || keys.some((key) => !isPortConfigKey(key))) {
    return false;
  }
  return (
    typeof config.baudRate === 'number' &&
    Number.isSafeInteger(config.baudRate) &&
    config.baudRate > 0 &&
    (config.dataBits === 5 ||
      config.dataBits === 6 ||
      config.dataBits === 7 ||
      config.dataBits === 8) &&
    (config.stopBits === 1 || config.stopBits === 2) &&
    (config.parity === 'none' || config.parity === 'odd' || config.parity === 'even') &&
    (config.flowControl === 'none' ||
      config.flowControl === 'software' ||
      config.flowControl === 'hardware') &&
    typeof config.rxFrameGapMs === 'number' &&
    Number.isSafeInteger(config.rxFrameGapMs) &&
    config.rxFrameGapMs >= 1 &&
    config.rxFrameGapMs <= 1_000 &&
    typeof config.dtr === 'boolean' &&
    typeof config.rts === 'boolean'
  );
}

function isPortConfigKey(value: string): value is (typeof PORT_CONFIG_KEYS)[number] {
  return (PORT_CONFIG_KEYS as readonly string[]).includes(value);
}

function normalizeName(name: string, config: PortConfig): string {
  const trimmed = name.trim();
  if (!trimmed || isSystemPath(trimmed)) return describeDeviceProfileConfig(config);
  return trimmed.slice(0, MAX_PROFILE_NAME_LENGTH);
}

function isSystemPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes('\u0000')
  );
}

function validIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function createProfileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
