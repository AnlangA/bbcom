/** Rejects markup, URLs, control characters and native paths from plugin-owned display text. */
export function safeDisplayText(value: string, maximum: number, allowEmpty = false): boolean {
  if ((!allowEmpty && value.length === 0) || utf8Length(value) > maximum) return false;
  const lower = value.toLocaleLowerCase('en-US');
  return !(
    valueHasControlCharacter(value) ||
    value.includes('<') ||
    value.includes('>') ||
    lower.includes('://') ||
    lower.includes('javascript:') ||
    lower.includes('data:') ||
    lower.includes('file:') ||
    lower.includes('mailto:') ||
    lower.includes('tel:') ||
    lower.includes('ftp:') ||
    lower.includes('ws:') ||
    lower.includes('wss:') ||
    lower.includes('urn:') ||
    lower.split(/\s+/u).some((part) => part.startsWith('www.')) ||
    isSystemPath(value)
  );
}

function valueHasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function isSystemPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/u.test(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
