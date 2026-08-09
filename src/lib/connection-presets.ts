import type { PortConfig } from '../types';
import { loadJson, saveJson } from './storage';
import { logger } from './logger';
import { normalizeRxFrameGapMs } from './serial-framing';

/**
 * Named, reusable connection profiles (baud/data/stop/parity/flow/DTR/RTS).
 *
 * Persisted globally (not per-session) so a user can build a library of device
 * profiles — e.g. "Arduino @9600", "ESP32 @115200", "Modbus RTU 8E1" — and apply
 * one when creating a session, à la CoolTerm's connection presets.
 */
export interface ConnectionPreset {
  id: string;
  name: string;
  config: PortConfig;
}

const STORAGE_KEY = 'bbcom-connection-presets';

/** Fields that define a preset's identity for equality/de-dup. */
export function configsEqual(a: PortConfig, b: PortConfig): boolean {
  return (
    a.baudRate === b.baudRate &&
    a.dataBits === b.dataBits &&
    a.stopBits === b.stopBits &&
    a.parity === b.parity &&
    a.flowControl === b.flowControl &&
    a.rxFrameGapMs === b.rxFrameGapMs &&
    a.dtr === b.dtr &&
    a.rts === b.rts
  );
}

/** Describe a config for display, e.g. "115200 8N1, none, DTR". */
export function describeConfig(config: PortConfig): string {
  const parityCode = config.parity === 'none' ? 'N' : config.parity === 'even' ? 'E' : 'O';
  return `${config.baudRate} ${config.dataBits}${parityCode}${config.stopBits}, ${config.flowControl}${config.dtr || config.rts ? `, ${config.dtr ? 'DTR' : ''}${config.dtr && config.rts ? '+' : ''}${config.rts ? 'RTS' : ''}` : ''}`;
}

export function loadPresets(): ConnectionPreset[] {
  try {
    const raw = loadJson<{ presets?: ConnectionPreset[] }>(STORAGE_KEY, { presets: [] });
    const list = Array.isArray(raw.presets) ? raw.presets : [];
    // Defensive: drop any malformed entries so a corrupt blob can't crash the dialog.
    return list
      .filter(
        (p): p is ConnectionPreset =>
          p &&
          typeof p.id === 'string' &&
          typeof p.name === 'string' &&
          p.config &&
          typeof p.config.baudRate === 'number',
      )
      .map((preset) => ({
        ...preset,
        config: {
          ...preset.config,
          rxFrameGapMs: normalizeRxFrameGapMs(preset.config.rxFrameGapMs),
        },
      }));
  } catch (e) {
    logger.warn('connection-presets: load failed', e);
    return [];
  }
}

export function savePresets(presets: ConnectionPreset[]): void {
  saveJson(STORAGE_KEY, { presets });
}

/** Append a preset, enforcing a sane name and a unique id. Returns the new list. */
export function addPreset(
  presets: ConnectionPreset[],
  name: string,
  config: PortConfig,
): ConnectionPreset[] {
  const trimmed = name.trim() || describeConfig(config);
  const next: ConnectionPreset[] = [
    ...presets,
    { id: makeId(), name: trimmed, config: { ...config } },
  ];
  savePresets(next);
  return next;
}

/** Remove by id; returns the new list and persists it. */
export function removePreset(presets: ConnectionPreset[], id: string): ConnectionPreset[] {
  const next = presets.filter((p) => p.id !== id);
  savePresets(next);
  return next;
}

function makeId(): string {
  // crypto.randomUUID exists in the Tauri webview and Node 19+; fall back for safety.
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
