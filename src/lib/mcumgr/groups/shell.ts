import { Cbor, cborInt, cborText, decodeCborMap } from '../cbor';
import { encodeMapPayload, SMP_GROUP } from '../smp';

export const SHELL_CMD = Object.freeze({
  execute: 0,
} as const);

export interface McumgrShellResult {
  output: string;
  ret: number;
}

export function splitShellArgv(line: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        argv.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) argv.push(current);
  return argv;
}

export function encodeShellExecute(argv: readonly string[]): Uint8Array {
  return encodeMapPayload({
    argv: Cbor.array(argv.map((item) => Cbor.text(item))),
  });
}

export function decodeShellExecute(payload: Uint8Array): McumgrShellResult {
  const map = decodeCborMap(payload);
  return {
    output: cborText(map, 'o') ?? '',
    ret: cborInt(map, 'ret') ?? cborInt(map, 'rc') ?? 0,
  };
}

export const SHELL_GROUP = SMP_GROUP.shell;
