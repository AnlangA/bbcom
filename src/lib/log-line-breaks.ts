// MCUboot's short severity prefix, Zephyr's timestamped log prefix, and the
// standard boot banners. Some serial/console paths deliver these records with
// their CR/LF bytes removed, so the prefixes are useful secondary boundaries.
// The severity lookbehind avoids splitting uppercase protocol tokens such as
// "SPI: " while still recognizing a prefix concatenated after normal text.
const LOG_RECORD_PREFIX_RE =
  /\*{3}\s+(?:Booting|Using)|(?<![A-Z_])[IWED]:\s+|\[\d\d:\d\d:\d\d\.\d{3},\d{3}\]\s+(?:<|&lt;)[a-z]{3}(?:>|&gt;)/g;

/**
 * Split text on explicit CR/LF and on common MCUboot/Zephyr record starts.
 * Prefix detection is intentionally display-only; captured bytes stay exact.
 */
export function splitLogDisplayLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  return normalized
    .replace(LOG_RECORD_PREFIX_RE, (prefix, offset: number) =>
      offset && normalized[offset - 1] !== '\n' ? `\n${prefix}` : prefix,
    )
    .split('\n');
}
