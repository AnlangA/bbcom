/**
 * Bounded cache with approximate-LRU eviction via second-chance promotion.
 *
 * This backs the packet formatter, the hottest render path: keys like
 * `f${frameId}:HEX:true` are set once during a capture, read on every visible
 * row of every render, and cleared wholesale on display-mode/buffer change.
 * Strict LRU (delete + re-insert on every hit) cost two Map mutations per cache
 * lookup — the dominant cost once hex formatting itself moved to flat lookup
 * tables. This second-chance variant makes `get` strictly O(1) with **no** Map
 * mutation on a hit: a hit only marks the key "touched" in a side Set.
 *
 * Eviction walks the FIFO front and gives each touched entry one promotion
 * (moves it to the back, clears the bit) before evicting the first untouched
 * entry. The result is approximate recency — exact enough for a formatter cache
 * that rarely fills and is cleared frequently, and bounded by `2 * maxSize`
 * memory. Pure FIFO would evict a just-read entry; strict LRU would reorder on
 * every read. Second-chance is the middle that matches the workload.
 */
export class LRUCache<K, V> {
  private cache = new Map<K, V>();
  /** Keys touched by `get` (or re-`set`) since their last promotion/insertion. */
  private touched = new Set<K>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    if (maxSize <= 0) {
      throw new Error('LRU cache size must be positive');
    }
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Defer the recency reorder until eviction actually needs to happen. No
      // Map mutation on the hot path — just a Set add.
      this.touched.add(key);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      // Map#set on an existing key updates the value but preserves insertion
      // order. Mark touched so a subsequent eviction gives it a second chance,
      // matching the prior "set promotes recency" behavior.
      this.cache.set(key, value);
      this.touched.add(key);
      return;
    }
    if (this.cache.size >= this.maxSize) {
      this.evictOne();
    }
    this.cache.set(key, value);
    this.touched.delete(key);
  }

  /**
   * Evict the first FIFO entry that wasn't touched since insertion. Each touched
   * entry it skips is promoted (moved to back, bit cleared), giving it one
   * second chance. Bounded by `cache.size` iterations so it can't loop forever.
   */
  private evictOne(): void {
    const limit = this.cache.size;
    for (let guard = 0; guard <= limit; guard += 1) {
      if (this.cache.size < this.maxSize) return;
      const firstKey = this.cache.keys().next().value as K | undefined;
      if (firstKey === undefined) return;
      if (this.touched.has(firstKey)) {
        // Second chance: move to MRU position and clear the bit.
        const v = this.cache.get(firstKey) as V;
        this.cache.delete(firstKey);
        this.cache.set(firstKey, v);
        this.touched.delete(firstKey);
      } else {
        this.cache.delete(firstKey);
        return;
      }
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
    this.touched.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
