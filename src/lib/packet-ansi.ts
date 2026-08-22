import { AnsiUp } from 'ansi_up';
import { splitLogDisplayLines } from './log-line-breaks';

export interface PacketAnsiRenderOptions {
  colorEnabled: boolean;
  preserveLineBreaks: boolean;
  plainLineBreaks: boolean;
}

/** Terminal packet list ANSI renderer (class-based spans for theme CSS). */
export function createPacketAnsiUp(): AnsiUp {
  const ansiUp = new AnsiUp();
  ansiUp.use_classes = true;
  ansiUp.escape_html = true;
  ansiUp.url_allowlist = {};
  return ansiUp;
}

function splitDisplayLines(text: string, plainLineBreaks: boolean): string[] {
  if (plainLineBreaks) {
    return text.replace(/\r\n?/g, '\n').split('\n');
  }
  return splitLogDisplayLines(text);
}

/**
 * Colorize frame text for the packet list. When log line breaks are enabled,
 * split on plain text first so ANSI spans are never torn by `<br>` insertion.
 */
export function renderPacketAnsiHtml(
  text: string,
  ansiUp: AnsiUp,
  options: PacketAnsiRenderOptions,
): string {
  if (!options.colorEnabled) return text;
  if (!options.preserveLineBreaks) return ansiUp.ansi_to_html(text);
  const lines = splitDisplayLines(text, options.plainLineBreaks);
  return lines.map((line) => ansiUp.ansi_to_html(line)).join('<br>');
}
