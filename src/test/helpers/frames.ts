import type { DataFrame } from '@/types';

/**
 * Shared `DataFrame` factory for frontend tests.
 *
 * Canonical form (the most common local signature):
 *
 *     frame(id, direction, data, timestamp?)
 *
 * `data` may be a `Uint8Array` (passed through by reference) or a plain byte
 * array (converted). `timestamp` defaults to 0 when omitted.
 *
 * Two historical positional orders are absorbed verbatim so their call sites
 * keep working without edits:
 *
 *     frame(id, direction, timestamp, bytes)
 *     frame(id, timestamp, direction, data)
 *
 * The three orders never collide: only `direction` is a string, only
 * `timestamp` is a bare number, and canonical `data` is never a number.
 */
export function frame(
  id: string,
  direction: DataFrame['direction'],
  data: Uint8Array | number[],
  timestamp?: number,
): DataFrame;
export function frame(
  id: string,
  direction: DataFrame['direction'],
  timestamp: number,
  bytes: number[],
): DataFrame;
export function frame(
  id: string,
  timestamp: number,
  direction: DataFrame['direction'],
  data: Uint8Array | number[],
): DataFrame;
export function frame(
  id: string,
  first: DataFrame['direction'] | number,
  second: number | Uint8Array | number[],
  third?: number | Uint8Array | number[],
): DataFrame {
  const direction = (typeof first === 'number' ? second : first) as DataFrame['direction'];
  const timestamp =
    typeof first === 'number' ? first : typeof second === 'number' ? second : (third as number);
  const rawData = typeof first === 'number' ? third : typeof second === 'number' ? third : second;
  const raw = rawData as Uint8Array | number[] | undefined;
  return {
    id,
    direction,
    timestamp: timestamp ?? 0,
    data: raw instanceof Uint8Array ? raw : new Uint8Array(raw ?? []),
  };
}
