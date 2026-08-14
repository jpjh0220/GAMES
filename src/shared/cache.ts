import LRU from 'lru-cache';
import { telemetry, EventType } from './telemetry';

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  hits: number;
  createdAt: number;
}

export interface CacheConfig {
  maxSize: number;
  ttlMs: number;
  updateAgeOnGet: boolean;
}

export class Cache<K extends string | number, V> {
  private cache: LRU<K, CacheEntry<V>>;
  private config: CacheConfig;
  private name: string;

  constructor(
    name: string,
    config: Partial<CacheConfig> = {}
  ) {
    this.name = name;
    this.config = {
      maxSize: 1000,
      ttlMs: 5 * 60 * 1000, // 5 minutes
      updateAgeOnGet: true,
      ...config
    };

    this.cache = new LRU({
      max: this.config.maxSize,
      maxSize: this.config.maxSize,
      updateAgeOnGet: this.config.updateAgeOnGet
    });
  }

  set(key: K, value: V, ttlMs?: number): void {
    const now = Date.now();
    const entry: CacheEntry<V> = {
      value,
      expiresAt: now + (ttlMs || this.config.ttlMs),
      hits: 0,
      createdAt: now
    };
    this.cache.set(key, entry);
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      telemetry.record(EventType.CACHE_MISS, {
        cache: this.name,
        key: String(key)
      });
      return undefined;
    }

    // Check expiration
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      telemetry.record(EventType.CACHE_MISS, {
        cache: this.name,
        key: String(key),
        reason: 'expired'
      });
      return undefined;
    }

    entry.hits++;
    telemetry.record(EventType.CACHE_HIT, {
      cache: this.name,
      key: String(key),
      hits: entry.hits,
      ageMs: Date.now() - entry.createdAt
    });

    return entry.value;
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  dump(): Array<[K, V]> {
    const result: Array<[K, V]> = [];
    this.cache.forEach((entry, key) => {
      if (entry.expiresAt >= Date.now()) {
        result.push([key, entry.value]);
      }
    });
    return result;
  }

  getStats(): {
    size: number;
    hits: number;
    misses: number;
    avgAge: number;
  } {
    let hits = 0,
      misses = 0,
      totalAge = 0,
      count = 0;
    const now = Date.now();

    this.cache.forEach((entry) => {
      if (entry.expiresAt >= now) {
        hits += entry.hits;
        totalAge += now - entry.createdAt;
        count++;
      } else {
        misses++;
      }
    });

    return {
      size: this.cache.size,
      hits,
      misses,
      avgAge: count > 0 ? totalAge / count : 0
    };
  }
}

/**
 * Multi-tier cache: L1 (memory), L2 (localStorage), L3 (remote)
 */
export class TieredCache<K extends string, V> {
  private l1: Cache<K, V>;
  private l2Map: Map<K, V> = new Map();
  private l3Endpoint?: string;
  private name: string;

  constructor(
    name: string,
    l1Config?: Partial<CacheConfig>,
    l3Endpoint?: string
  ) {
    this.name = name;
    this.l1 = new Cache(name, l1Config);
    this.l3Endpoint = l3Endpoint;
    this.loadL2();
  }

  private loadL2(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const key = `cache_${this.name}`;
      const stored = localStorage.getItem(key);
      if (stored) {
        const entries = JSON.parse(stored) as Record<K, V>;
        Object.entries(entries).forEach(([k, v]) => {
          this.l2Map.set(k as K, v);
        });
      }
    } catch (e) {
      console.warn(`Failed to load L2 cache for ${this.name}`, e);
    }
  }

  private saveL2(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const key = `cache_${this.name}`;
      const entries = Object.fromEntries(this.l2Map);
      localStorage.setItem(key, JSON.stringify(entries));
    } catch (e) {
      console.warn(`Failed to save L2 cache for ${this.name}`, e);
    }
  }

  async get(key: K): Promise<V | undefined> {
    // L1
    let value = this.l1.get(key);
    if (value !== undefined) return value;

    // L2
    value = this.l2Map.get(key);
    if (value !== undefined) {
      this.l1.set(key, value);
      return value;
    }

    // L3 (optional)
    if (this.l3Endpoint) {
      try {
        const response = await fetch(`${this.l3Endpoint}/${key}`);
        if (response.ok) {
          value = await response.json();
          this.l1.set(key, value);
          this.l2Map.set(key, value);
          this.saveL2();
          return value;
        }
      } catch (e) {
        console.debug(`L3 cache miss for ${key}`, e);
      }
    }

    return undefined;
  }

  set(key: K, value: V): void {
    this.l1.set(key, value);
    this.l2Map.set(key, value);
    this.saveL2();
  }

  async flush(): Promise<void> {
    if (this.l3Endpoint) {
      try {
        await fetch(this.l3Endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entries: Object.fromEntries(this.l2Map),
            timestamp: Date.now()
          })
        });
      } catch (e) {
        console.warn(`Failed to flush cache to L3`, e);
      }
    }
  }

  clear(): void {
    this.l1.clear();
    this.l2Map.clear();
    this.saveL2();
  }
}
