/**
 * RX-matched auto-response engine ("scripted triggers").
 *
 * Watches the incoming RX byte stream and, when a configured pattern appears,
 * signals that its response payload should be sent. This is the mechanism
 * behind scripted device interactions — e.g. "when the device prints 'login:',
 * send 'root\r\n'", or "on the 0xAA55 header byte, send an ACK".
 *
 * Design notes:
 * - The matcher is stateful (keeps a rolling tail of RX bytes) so a pattern
 *   spanning multiple frames/chunks is still detected.
 * - Each trigger has a cooldown to prevent runaway feedback loops (a response
 *   that itself triggers another match).
 * - Pure logic, no Vue/DOM deps → fully unit-testable.
 */

import type { Trigger, TriggerMatchMode } from '@/types';

export type { Trigger, TriggerMatchMode };

export interface TriggerFire {
  triggerId: string;
  response: string;
  responseIsHex: boolean;
}

/**
 * Parse a trigger HEX pattern without silently discarding invalid characters.
 *
 * Send input intentionally remains lenient for backwards compatibility, but
 * a matcher must never turn `AA-XX-BB` into a different byte sequence. Only
 * ASCII whitespace may separate byte pairs here.
 */
export function parseHexPattern(input: string): number[] {
  const compact = input.replace(/[\t\n\r ]/g, '');
  if (compact.length === 0 || compact.length % 2 !== 0 || !/^[\da-fA-F]+$/.test(compact)) {
    return [];
  }

  const out = new Array<number>(compact.length / 2);
  for (let index = 0; index < compact.length; index += 2) {
    const parsed = Number.parseInt(compact.slice(index, index + 2), 16);
    // The regexp above makes this branch defensive rather than expected.
    if (!Number.isInteger(parsed)) return [];
    out[index / 2] = parsed;
  }
  return out;
}

export class TriggerEngine {
  private triggers: Trigger[];
  /** Rolling tail of RX bytes, bounded to the longest pattern length. */
  private byteTail: number[] = [];
  /** Rolling tail of decoded text, bounded similarly. */
  private textTail = '';
  /** One decoder per session engine; decode must remain streaming across chunks. */
  private textDecoder = new TextDecoder('utf-8', { fatal: false });
  private maxBytePatternLen = 1;
  private maxTextPatternLen = 1;
  private lastFiredAt = new Map<string, number>();

  constructor(triggers: Trigger[]) {
    this.triggers = [...triggers];
    this.recomputeLimits();
  }

  /** Replace the trigger set (e.g. after an edit). Resets the rolling buffers. */
  setTriggers(triggers: Trigger[]): void {
    this.triggers = [...triggers];
    this.recomputeLimits();
    this.reset();
  }

  private recomputeLimits(): void {
    let maxByte = 1;
    let maxText = 1;
    for (const t of this.triggers) {
      if (!t.enabled) continue;
      if (t.matchMode === 'hex') {
        const length = parseHexPattern(t.pattern).length;
        if (length > maxByte) maxByte = length;
      } else if (t.pattern.length > maxText) {
        maxText = t.pattern.length;
      }
    }
    this.maxBytePatternLen = maxByte;
    this.maxTextPatternLen = maxText;
  }

  /** Feed RX bytes; returns any triggers that fired (caller sends the responses).
   *  At most one fire per enabled trigger per call, respecting cooldown. */
  feed(bytes: Uint8Array): TriggerFire[] {
    const fires: TriggerFire[] = [];
    if (this.triggers.length === 0) return fires;

    // Append to the rolling buffers FIRST, run all checks, THEN trim. Trimming
    // before checking would drop a match that arrived in this very batch when
    // the batch is longer than the longest pattern.
    for (let i = 0; i < bytes.length; i += 1) this.byteTail.push(bytes[i]);
    this.textTail += this.textDecoder.decode(bytes, { stream: true });

    const now = Date.now();
    for (const t of this.triggers) {
      if (!t.enabled) continue;
      // Cooldown: skip if fired too recently.
      const last = this.lastFiredAt.get(t.id);
      if (last !== undefined && now - last < t.cooldownMs) continue;

      const matched = t.matchMode === 'hex' ? this.matchHex(t) : this.matchText(t);
      if (matched) {
        this.lastFiredAt.set(t.id, now);
        fires.push({ triggerId: t.id, response: t.response, responseIsHex: t.responseIsHex });
      }
    }

    // Now bound memory: keep only the tail needed to catch a match that spans
    // the next chunk. Keep one extra byte of slack for safety.
    const byteKeep = this.maxBytePatternLen + 1;
    if (this.byteTail.length > byteKeep) {
      this.byteTail.splice(0, this.byteTail.length - byteKeep);
    }
    const textKeep = this.maxTextPatternLen + 1;
    if (this.textTail.length > textKeep) {
      this.textTail = this.textTail.slice(this.textTail.length - textKeep);
    }
    return fires;
  }

  private matchText(t: Trigger): boolean {
    if (t.pattern.length === 0) return false;
    return this.textTail.indexOf(t.pattern) !== -1;
  }

  private matchHex(t: Trigger): boolean {
    const needle = parseHexPattern(t.pattern);
    if (needle.length === 0) return false;
    return containsSubarray(this.byteTail, needle);
  }

  /** Clear all rolling state (e.g. on capture clear). */
  reset(): void {
    this.byteTail = [];
    this.textTail = '';
    // Discard a partial UTF-8 code point from the prior logical stream.
    this.textDecoder = new TextDecoder('utf-8', { fatal: false });
    this.lastFiredAt.clear();
  }
}

/** True if `haystack` contains `needle` as a contiguous subsequence. */
export function containsSubarray(haystack: number[], needle: number[]): boolean {
  if (needle.length === 0) return false;
  if (needle.length > haystack.length) return false;
  const last = haystack.length - needle.length;
  outer: for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
