import { decode, Tokenizer, Type } from 'cborg';
import { bigIntDecoder, bigNegIntDecoder } from 'cborg/taglib';

export const MAX_SMP_CBOR_DEPTH = 32;
export const MAX_SMP_CBOR_NODES = 4_096;
export const MAX_SMP_CBOR_BIGNUM_BYTES = 4_096;

export type CborNode =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | CborNode[]
  | Map<CborNode, CborNode>;

export type CborDecodeResult = { ok: true; value: CborNode } | { ok: false; reason: string };

/**
 * Decode an SMP CBOR payload without allowing a compact input to materialize
 * an unbounded object graph. The token pass performs no container allocation;
 * only payloads within the depth/node budget reach cborg's object decoder.
 */
export function decodeBoundedSmpCbor(
  payload: Uint8Array,
  maxDepth = MAX_SMP_CBOR_DEPTH,
  maxNodes = MAX_SMP_CBOR_NODES,
): CborDecodeResult {
  if (payload.length === 0) return { ok: false, reason: 'CBOR payload is empty' };

  try {
    preflightCbor(payload, maxDepth, maxNodes);
    const decoded: unknown = decode(payload, {
      allowBigInt: true,
      allowIndefinite: true,
      allowUndefined: true,
      rejectDuplicateMapKeys: true,
      strict: false,
      tags: { 2: bigIntDecoder, 3: bigNegIntDecoder },
      useMaps: true,
    });
    return { ok: true, value: normalizeCborNode(decoded, maxDepth, maxNodes) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

interface ContainerBudget {
  /** null represents an indefinite-length container. */
  remaining: number | null;
  bignum?: boolean;
}

function preflightCbor(payload: Uint8Array, maxDepth: number, maxNodes: number): void {
  const tokenizer = new Tokenizer(payload, {
    allowBigInt: true,
    allowIndefinite: true,
    allowUndefined: true,
    strict: false,
  });
  const stack: ContainerBudget[] = [];
  let nodes = 0;
  let roots = 0;

  while (!tokenizer.done()) {
    const token = tokenizer.next();
    if (Type.equals(token.type, Type.break)) {
      const container = stack.at(-1);
      if (!container || container.remaining !== null) {
        throw new RangeError('CBOR contains an unexpected break marker');
      }
      stack.pop();
      collapseCompletedContainers(stack);
      continue;
    }

    const parent = stack.at(-1);
    if (parent?.bignum) {
      if (
        !Type.equals(token.type, Type.bytes) ||
        !(token.value instanceof Uint8Array) ||
        token.value.length > MAX_SMP_CBOR_BIGNUM_BYTES
      ) {
        throw new RangeError(
          `CBOR bignum must be a byte string of at most ${MAX_SMP_CBOR_BIGNUM_BYTES} bytes`,
        );
      }
    }

    nodes += 1;
    if (nodes > maxNodes) throw new RangeError(`CBOR exceeds ${maxNodes} nodes`);

    if (stack.length === 0) {
      roots += 1;
      if (roots > 1) throw new RangeError('CBOR payload contains trailing values');
    } else {
      consumeContainerSlot(stack.at(-1)!);
    }

    let childCount: number | null | undefined;
    let bignum = false;
    if (Type.equals(token.type, Type.array)) {
      childCount = token.value === Number.POSITIVE_INFINITY ? null : numberLength(token.value);
    } else if (Type.equals(token.type, Type.map)) {
      const pairs = token.value === Number.POSITIVE_INFINITY ? null : numberLength(token.value);
      childCount = pairs === null ? null : pairs * 2;
    } else if (Type.equals(token.type, Type.tag)) {
      childCount = 1;
      bignum = token.value === 2 || token.value === 2n || token.value === 3 || token.value === 3n;
    }

    if (childCount !== undefined) {
      stack.push({ remaining: childCount, ...(bignum ? { bignum: true } : {}) });
      if (stack.length > maxDepth) throw new RangeError(`CBOR exceeds depth ${maxDepth}`);
    }
    collapseCompletedContainers(stack);
  }

  if (roots !== 1) throw new RangeError('CBOR payload does not contain a value');
  if (stack.length > 0) throw new RangeError('CBOR container is incomplete');
}

function numberLength(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError('CBOR container length is invalid');
  }
  return value as number;
}

function consumeContainerSlot(container: ContainerBudget): void {
  if (container.remaining === null) return;
  if (container.remaining <= 0) throw new RangeError('CBOR container has too many values');
  container.remaining -= 1;
}

function collapseCompletedContainers(stack: ContainerBudget[]): void {
  while (stack.at(-1)?.remaining === 0) stack.pop();
}

function normalizeCborNode(value: unknown, maxDepth: number, maxNodes: number): CborNode {
  let nodes = 0;

  const visit = (current: unknown, depth: number): CborNode => {
    nodes += 1;
    if (nodes > maxNodes) throw new RangeError(`CBOR exceeds ${maxNodes} nodes`);
    if (depth > maxDepth) throw new RangeError(`CBOR exceeds depth ${maxDepth}`);

    if (
      current === null ||
      current === undefined ||
      typeof current === 'boolean' ||
      typeof current === 'number' ||
      typeof current === 'bigint' ||
      typeof current === 'string'
    ) {
      return current;
    }
    if (current instanceof Uint8Array) return current;
    if (Array.isArray(current)) return current.map((entry) => visit(entry, depth + 1));
    if (current instanceof Map) {
      const output = new Map<CborNode, CborNode>();
      for (const [key, entry] of current.entries()) {
        output.set(visit(key, depth + 1), visit(entry, depth + 1));
      }
      return output;
    }
    throw new TypeError(
      `Unsupported decoded CBOR value: ${Object.prototype.toString.call(current)}`,
    );
  };

  return visit(value, 1);
}

export function cborMapValue(map: CborNode | undefined, key: string): CborNode | undefined {
  if (!(map instanceof Map)) return undefined;
  for (const [candidate, value] of map.entries()) {
    if (candidate === key) return value;
  }
  return undefined;
}

export function cborInteger(value: CborNode | undefined): number | bigint | undefined {
  return typeof value === 'number' || typeof value === 'bigint' ? value : undefined;
}

export function cborText(value: CborNode | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
