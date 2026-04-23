export function formatHex(data: number[] | Uint8Array): string {
  const arr = Array.isArray(data) ? data : Array.from(data);
  return arr.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function parseHex(input: string): number[] {
  const cleaned = input.replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd number of digits');
  }
  const result: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    result.push(parseInt(cleaned.substring(i, i + 2), 16));
  }
  return result;
}

export function isValidHex(input: string): boolean {
  const cleaned = input.replace(/[^0-9a-fA-F]/g, '');
  return cleaned.length > 0 && cleaned.length % 2 === 0;
}
