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

import type { Trigger, TriggerMatchMode } from '../types';

export type { Trigger, TriggerMatchMode };

export interface TriggerFire {
  triggerId: string;
  response: string;
  responseIsHex: boolean;
}

/** Parse a hex pattern string ("AA BB", "AABB") into a byte array. Empty/invalid → []. */
export function parseHexPattern(input: string): number[] {
  const cleaned = input.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

/** Decode RX bytes to text for text-mode matching (UTF-8, non-fatal). */
const textDecoder = new TextDecoder('utf-8', { fatal: false });

export class TriggerEngine {
  private readonly triggers: Trigger[];
  /** Rolling tail of RX bytes, bounded to the longest pattern length. */
  private byteTail: number[] = [];
  /** Rolling tail of decoded text, bounded similarly. */
  private textTail = '';
  private maxPatternLen = 0;
  private lastFiredAt = new Map<string, number>();

  constructor(triggers: Trigger[]) {
    this.triggers = triggers;
    this.recomputeLimits();
  }

  /** Replace the trigger set (e.g. after an edit). Resets the rolling buffers. */
  setTriggers(triggers: Trigger[]): void {
    this.triggers.length = 0;
    for (const t of triggers) this.triggers.push(t);
    this.recomputeLimits();
    this.byteTail = [];
    this.textTail = '';
  }

  private recomputeLimits(): void {
    let max = 1;
    for (const t of this.triggers) {
      if (!t.enabled) continue;
      const len = t.matchMode === 'hex' ? parseHexPattern(t.pattern).length : t.pattern.length;
      if (len > max) max = len;
    }
    this.maxPatternLen = max;
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
    this.textTail += textDecoder.decode(bytes);

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
    const keep = this.maxPatternLen + 1;
    if (this.byteTail.length > keep) {
      this.byteTail.splice(0, this.byteTail.length - keep);
    }
    if (this.textTail.length > keep) {
      this.textTail = this.textTail.slice(this.textTail.length - keep);
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
