import { DEFAULT_RX_FRAME_GAP_MS, normalizeRxFrameGapMs } from '@/lib/serial-framing';
import { clampSidebarWidth } from '@/lib/sidebar-layout';
import type { DisplayMode, LineEnding, PacketViewMode, PortConfig, SearchMode } from '@/types';

export const GLOBAL_SETTINGS_VERSION = 2;
export const GLOBAL_SETTINGS_STORAGE_KEY = 'bbcom-v2:global-settings';
/** Read-only legacy sources (AGENTS_PLAN.md A-02): never written, never deleted. */
export const LEGACY_APP_SETTINGS_KEY = 'bbcom-v1:app-settings';
export const LEGACY_SERIAL_SETTINGS_KEY = 'bbcom-v1:serial-settings';

export type ThemeSetting = 'dark' | 'light';
export type LocaleSetting = 'en' | 'zh';

/**
 * The complete non-secret global settings document. Sidebar layout, session,
 * workspace, plugin, and AI secret state deliberately have no place here.
 */
export interface GlobalSettingsV2 {
  version: 2;
  theme: ThemeSetting;
  locale: LocaleSetting;
  displayMode: DisplayMode;
  autoScroll: boolean;
  showTimestamp: boolean;
  searchMode: SearchMode;
  packetViewMode: PacketViewMode;
  lineEnding: LineEnding;
  sendAsHex: boolean;
  loopIntervalMs: number;
  ansiColorEnabled: boolean;
  preserveLogLineBreaks: boolean;
  softWrapEnabled: boolean;
  maxBufferFrames: number;
  autoReconnect: boolean;
  selectedPort: string;
  portConfig: PortConfig;
}

/** Read-only sidebar compat values from the v1 app-settings blob (A-11 keeps ownership in workspaces). */
export interface LegacySidebarCompat {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

const DISPLAY_MODES: readonly DisplayMode[] = ['HEX', 'HEXASCII', 'ASCII', 'ANSI', 'UTF8'];
const SEARCH_MODES: readonly SearchMode[] = ['TEXT', 'HEX'];
const PACKET_VIEW_MODES: readonly PacketViewMode[] = ['FRAME', 'MERGED'];
const LINE_ENDINGS: readonly LineEnding[] = ['none', 'CR', 'LF', 'CRLF'];

const DEFAULT_PORT_CONFIG: Readonly<PortConfig> = Object.freeze({
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: DEFAULT_RX_FRAME_GAP_MS,
  dtr: false,
  rts: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnumValue<T extends string>(raw: unknown, values: readonly T[]): raw is T {
  return typeof raw === 'string' && values.includes(raw as T);
}

function readBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function readNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function readString(raw: unknown, fallback: string): string {
  return typeof raw === 'string' ? raw : fallback;
}

/** Normalize an unknown persisted port config field-by-field into a valid PortConfig. */
export function normalizePortConfig(value: unknown): PortConfig {
  const raw = isRecord(value) ? value : {};
  return {
    baudRate:
      typeof raw.baudRate === 'number' && Number.isSafeInteger(raw.baudRate) && raw.baudRate > 0
        ? raw.baudRate
        : DEFAULT_PORT_CONFIG.baudRate,
    dataBits:
      raw.dataBits === 5 || raw.dataBits === 6 || raw.dataBits === 7 || raw.dataBits === 8
        ? raw.dataBits
        : DEFAULT_PORT_CONFIG.dataBits,
    stopBits:
      raw.stopBits === 1 || raw.stopBits === 2 ? raw.stopBits : DEFAULT_PORT_CONFIG.stopBits,
    parity:
      raw.parity === 'none' || raw.parity === 'odd' || raw.parity === 'even'
        ? raw.parity
        : DEFAULT_PORT_CONFIG.parity,
    flowControl:
      raw.flowControl === 'none' || raw.flowControl === 'software' || raw.flowControl === 'hardware'
        ? raw.flowControl
        : DEFAULT_PORT_CONFIG.flowControl,
    rxFrameGapMs: normalizeRxFrameGapMs(raw.rxFrameGapMs),
    dtr: readBoolean(raw.dtr, DEFAULT_PORT_CONFIG.dtr),
    rts: readBoolean(raw.rts, DEFAULT_PORT_CONFIG.rts),
  };
}

export function defaultGlobalSettings(): GlobalSettingsV2 {
  return {
    version: GLOBAL_SETTINGS_VERSION,
    theme: 'dark',
    locale: 'zh',
    displayMode: 'HEX',
    autoScroll: true,
    showTimestamp: true,
    searchMode: 'TEXT',
    packetViewMode: 'FRAME',
    lineEnding: 'none',
    sendAsHex: false,
    loopIntervalMs: 1000,
    ansiColorEnabled: true,
    preserveLogLineBreaks: true,
    softWrapEnabled: true,
    maxBufferFrames: 20_000,
    autoReconnect: false,
    selectedPort: '',
    portConfig: { ...DEFAULT_PORT_CONFIG },
  };
}

/**
 * Per-field validation and normalization. Any wrong-typed or unknown field
 * silently falls back to its default; a document of an unexpected future
 * version is ignored entirely so a newer app's data is never misread.
 */
export function normalizeGlobalSettings(raw: unknown): GlobalSettingsV2 | null {
  if (!isRecord(raw) || raw.version !== GLOBAL_SETTINGS_VERSION) return null;
  const defaults = defaultGlobalSettings();
  return {
    version: GLOBAL_SETTINGS_VERSION,
    theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : defaults.theme,
    locale: raw.locale === 'en' || raw.locale === 'zh' ? raw.locale : defaults.locale,
    displayMode: isEnumValue(raw.displayMode, DISPLAY_MODES)
      ? raw.displayMode
      : defaults.displayMode,
    autoScroll: readBoolean(raw.autoScroll, defaults.autoScroll),
    showTimestamp: readBoolean(raw.showTimestamp, defaults.showTimestamp),
    searchMode: isEnumValue(raw.searchMode, SEARCH_MODES) ? raw.searchMode : defaults.searchMode,
    packetViewMode: isEnumValue(raw.packetViewMode, PACKET_VIEW_MODES)
      ? raw.packetViewMode
      : defaults.packetViewMode,
    lineEnding: isEnumValue(raw.lineEnding, LINE_ENDINGS) ? raw.lineEnding : defaults.lineEnding,
    sendAsHex: readBoolean(raw.sendAsHex, defaults.sendAsHex),
    loopIntervalMs: readNumber(raw.loopIntervalMs, defaults.loopIntervalMs),
    ansiColorEnabled: readBoolean(raw.ansiColorEnabled, defaults.ansiColorEnabled),
    preserveLogLineBreaks: readBoolean(raw.preserveLogLineBreaks, defaults.preserveLogLineBreaks),
    softWrapEnabled: readBoolean(raw.softWrapEnabled, defaults.softWrapEnabled),
    maxBufferFrames: readNumber(raw.maxBufferFrames, defaults.maxBufferFrames),
    autoReconnect: readBoolean(raw.autoReconnect, defaults.autoReconnect),
    selectedPort: readString(raw.selectedPort, defaults.selectedPort),
    portConfig: normalizePortConfig(raw.portConfig),
  };
}

/**
 * Read-only migration from the two v1 keys. Corrupt or missing fields simply
 * stay at their defaults; the legacy blobs themselves are never modified.
 */
export function migrateLegacyGlobalSettings(
  legacyApp: unknown,
  legacySerial: unknown,
): { settings: GlobalSettingsV2; legacySidebar: LegacySidebarCompat | null } {
  const app = isRecord(legacyApp) ? legacyApp : {};
  const serial = isRecord(legacySerial) ? legacySerial : {};
  const settings = defaultGlobalSettings();
  if (app.theme === 'light' || app.theme === 'dark') settings.theme = app.theme;
  if (app.locale === 'en' || app.locale === 'zh') settings.locale = app.locale;
  if (isEnumValue(app.displayMode, DISPLAY_MODES)) settings.displayMode = app.displayMode;
  if (typeof app.autoScroll === 'boolean') settings.autoScroll = app.autoScroll;
  if (typeof app.showTimestamp === 'boolean') settings.showTimestamp = app.showTimestamp;
  if (isEnumValue(app.searchMode, SEARCH_MODES)) settings.searchMode = app.searchMode;
  if (isEnumValue(app.packetViewMode, PACKET_VIEW_MODES))
    settings.packetViewMode = app.packetViewMode;
  if (isEnumValue(app.lineEnding, LINE_ENDINGS)) settings.lineEnding = app.lineEnding;
  if (typeof app.sendAsHex === 'boolean') settings.sendAsHex = app.sendAsHex;
  if (typeof app.loopIntervalMs === 'number' && Number.isFinite(app.loopIntervalMs))
    settings.loopIntervalMs = app.loopIntervalMs;
  if (typeof app.ansiColorEnabled === 'boolean') settings.ansiColorEnabled = app.ansiColorEnabled;
  if (typeof app.preserveLogLineBreaks === 'boolean')
    settings.preserveLogLineBreaks = app.preserveLogLineBreaks;
  if (typeof app.softWrapEnabled === 'boolean') settings.softWrapEnabled = app.softWrapEnabled;
  if (typeof app.maxBufferFrames === 'number' && Number.isFinite(app.maxBufferFrames))
    settings.maxBufferFrames = app.maxBufferFrames;
  if (typeof app.autoReconnect === 'boolean') settings.autoReconnect = app.autoReconnect;
  if (typeof serial.selectedPort === 'string') settings.selectedPort = serial.selectedPort;
  if (serial.portConfig !== undefined) settings.portConfig = normalizePortConfig(serial.portConfig);

  const legacySidebar =
    typeof app.sidebarWidth === 'number' || typeof app.sidebarCollapsed === 'boolean'
      ? {
          sidebarWidth:
            typeof app.sidebarWidth === 'number' ? clampSidebarWidth(app.sidebarWidth) : 292,
          sidebarCollapsed: readBoolean(app.sidebarCollapsed, false),
        }
      : null;
  return { settings, legacySidebar };
}
