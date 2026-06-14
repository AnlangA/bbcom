/**
 * Escape a serial port path for use in a Tauri event name.
 *
 * Matches the transformation the serial plugin applies internally when
 * constructing its event channel names (e.g. `plugin-serialplugin-disconnected-<path>`):
 * dots and slashes are replaced with dashes, since they would break the
 * event-name namespace. Without this, a raw path like `/dev/cu.usbserial-1234`
 * produces a listener name that never matches the event the plugin emits, so
 * hot-unplug disconnects go undetected on macOS/Linux.
 */
export function escapeSerialPath(path: string): string {
  return path.replaceAll('.', '-').replaceAll('/', '-');
}

/**
 * Substrings that identify non-serial ports (Bluetooth, AirPods, Apple Watch)
 * which would otherwise clutter the port selector.
 */
const BLOCKED_PORT_KEYWORDS = ['Bluetooth', 'AirPods', 'Watch'];

/**
 * Whether a detected port path is a real serial device (not Bluetooth/etc.).
 */
export function isRealSerialPort(path: string): boolean {
  return !BLOCKED_PORT_KEYWORDS.some((kw) => path.includes(kw));
}

/**
 * Merge the currently-shown port list with a freshly detected one, preserving
 * the existing display order and appending newly-appeared ports at the end.
 * Ports that are no longer detected are dropped.
 */
export function mergePortLists(existing: string[], detected: string[]): string[] {
  const detectedSet = new Set(detected);
  const existingSet = new Set(existing);
  const merged: string[] = [];
  for (const port of existing) {
    if (detectedSet.has(port)) merged.push(port);
  }
  for (const port of detected) {
    if (!existingSet.has(port)) merged.push(port);
  }
  return merged;
}
