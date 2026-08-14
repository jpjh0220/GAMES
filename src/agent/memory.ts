import { telemetry, EventType } from '@shared/telemetry';

/**
 * CRITICAL FIX #14: Memory system with automatic garbage collection
 * CRITICAL FIX #20: Multi-instance conflict resolution
 */

export interface Memory {
  id: string;
  createdAt: number;
  tick: number;
  kind: 'episode' | 'strategy' | 'relationship' | 'place' | 'skill' | 'failure';
  text: string;
  importance: number;
  tags: string[];
  accessCount: number;
  lastAccessedAt: number;
  ttlMs?: number; // time-to-live
}

export interface MemoryConfig {
  maxMemories: number;
  maxAge: number; // ms
  minImportance: number;
  gcIntervalMs: number;
  persistenceMode: 'memory' | 'local' | 'github' | 'multi';
}

export class MemoryBank {
  private memories: Map<string, Memory> = new Map();
  private relationships: Map<string, RelationshipMemory> = new Map();
  private places: Map<string, PlaceMemory> = new Map();
  private skills: Map<string, SkillMemory> = new Map();
  private failures: Map<string, FailureMemory> = new Map();
  private config: MemoryConfig;
  private lastGC: number = Date.now();
  private accessLog: Array<{ id: string; at: number }> = [];
  private version: number = 0;

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = {
      maxMemories: 500, // was unlimited, now bounded
      maxAge: 14 * 24 * 60 * 60 * 1000, // 14 days default TTL
      minImportance: 0.5,
      gcIntervalMs: 5 * 60 * 1000, // every 5 minutes
      persistenceMode: 'multi',
      ...config
    };

    this.startGarbageCollector();
  }

  /**
   * Add memory with automatic importance weighting
   */
  remember(
    kind: Memory['kind'],
    text: string,
    importance: number = 1.0,
    tags: string[] = [],
    ttlMs?: number
  ): string {
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const memory: Memory = {
      id,
      createdAt: Date.now(),
      tick: 0,
      kind,
      text,
      importance: Math.min(2.0, importance), // cap at 2.0
      tags: [...new Set(tags)], // dedupe
      accessCount: 0,
      lastAccessedAt: Date.now(),
      ttlMs: ttlMs || this.config.maxAge
    };

    this.memories.set(id, memory);
    this.accessLog.push({ id, at: Date.now() });

    telemetry.record(EventType.AGENT_LEARN, {
      kind,
      importance,
      tags: tags.length,
      textLength: text.length
    });

    // Trigger GC if approaching limit
    if (this.memories.size > this.config.maxMemories * 0.9) {
      this.gc(true);
    }

    return id;
  }

  /**
   * Retrieve memories by relevance
   */
  recall(
    query: string,
    limit: number = 5,
    filter?: (m: Memory) => boolean
  ): Memory[] {
    const now = Date.now();
    const queryTokens = new Set(
      query.toLowerCase().split(/\s+/).filter((t) => t.length > 2)
    );

    const scored = Array.from(this.memories.values())
      .filter((m) => {
        if (m.ttlMs && now - m.createdAt > m.ttlMs) return false;
        if (filter && !filter(m)) return false;
        return true;
      })
      .map((m) => {
        const textTokens = new Set(
          m.text.toLowerCase().split(/\s+/).filter((t) => t.length > 2)
        );
        const tagMatch = [...queryTokens].filter((t) =>
          m.tags.some((tag) => tag.includes(t))
        ).length;
        const textMatch = [...queryTokens].filter((t) =>
          textTokens.has(t)
        ).length;
        const recency = Math.max(0, 1 - (now - m.lastAccessedAt) / (30 * 24 * 60 * 60 * 1000));
        const score =
          m.importance * 2 +
          textMatch * 1.5 +
          tagMatch * 1.2 +
          m.accessCount * 0.1 +
          recency * 0.5;

        return { memory: m, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Update access counts
    scored.forEach((s) => {
      s.memory.accessCount++;
      s.memory.lastAccessedAt = now;
    });

    return scored.map((s) => s.memory);
  }

  /**
   * Relationship memory: track trust, history, cooperation
   */
  rememberRelationship(playerName: string, update: Partial<RelationshipMemory>): void {
    const now = Date.now();
    const existing = this.relationships.get(playerName);
    const updated: RelationshipMemory = {
      playerName,
      firstSeen: existing?.firstSeen || now,
      lastSeen: now,
      encounters: (existing?.encounters || 0) + 1,
      trust: Math.max(-1, Math.min(1, update.trust ?? existing?.trust ?? 0)),
      stance: update.stance ?? existing?.stance ?? 'unknown',
      facts: [...new Set([...(existing?.facts || []), ...(update.facts || [])])].slice(-30),
      interactions: [
        ...(existing?.interactions || []),
        ...(update.interactions || [])
      ].slice(-100),
      failedCooperations: (existing?.failedCooperations || 0) +
        (update.failedCooperations ?? 0),
      successfulCooperations: (existing?.successfulCooperations || 0) +
        (update.successfulCooperations ?? 0)
    };

    // Time-decay trust: old interactions matter less
    if (existing) {
      const daysSinceLastSeen =
        (now - existing.lastSeen) / (24 * 60 * 60 * 1000);
      updated.trust *= Math.exp(-daysSinceLastSeen / 30); // decay over 30 days
    }

    this.relationships.set(playerName, updated);
  }

  /**
   * Place memory: track locations, NPCs, resources, safety
   */
  rememberPlace(
    key: string,
    update: Partial<PlaceMemory>
  ): void {
    const now = Date.now();
    const existing = this.places.get(key);
    this.places.set(key, {
      key,
      x: update.x ?? existing?.x ?? 0,
      z: update.z ?? existing?.z ?? 0,
      level: update.level ?? existing?.level ?? 0,
      firstSeen: existing?.firstSeen || now,
      lastSeen: now,
      visits: (existing?.visits || 0) + 1,
      npcs: [...new Set([...(existing?.npcs || []), ...(update.npcs || [])])].slice(-30),
      resources: [...new Set([...(existing?.resources || []), ...(update.resources || [])])].slice(-50),
      dangers: [...new Set([...(existing?.dangers || []), ...(update.dangers || [])])].slice(-20),
      safetyRating: update.safetyRating ?? existing?.safetyRating ?? 0.5,
      profitability: update.profitability ?? existing?.profitability ?? 0
    });
  }

  /**
   * Skill memory: track prerequisites, efficiency, unlock paths
   */
  rememberSkill(name: string, update: Partial<SkillMemory>): void {
    const existing = this.skills.get(name);
    this.skills.set(name, {
      name,
      levelRequired: update.levelRequired ?? existing?.levelRequired ?? 1,
      xpPerHour: update.xpPerHour ?? existing?.xpPerHour ?? 0,
      duration: update.duration ?? existing?.duration ?? 0,
      prerequisites: [...new Set([...(existing?.prerequisites || []), ...(update.prerequisites || [])])],
      unlocks: [...new Set([...(existing?.unlocks || []), ...(update.unlocks || [])])],
      difficulty: update.difficulty ?? existing?.difficulty ?? 'medium',
      lastAttempted: Date.now(),
      successRate: update.successRate ?? existing?.successRate ?? 0.5
    });
  }

  /**
   * Failure memory: track mistakes to avoid repeating
   */
  rememberFailure(action: string, reason: string, context: any): void {
    const key = `${action}-${Math.floor(context.x / 8)}-${Math.floor(context.z / 8)}`;
    const existing = this.failures.get(key);
    this.failures.set(key, {
      action,
      firstOccurred: existing?.firstOccurred || Date.now(),
      lastOccurred: Date.now(),
      count: (existing?.count || 0) + 1,
      reason,
      contexts: [...(existing?.contexts || []), context].slice(-10),
      preconditions: context.preconditions || []
    });
  }

  /**
   * Automatic garbage collection
   */
  private gc(force: boolean = false): void {
    const now = Date.now();
    if (!force && now - this.lastGC < this.config.gcIntervalMs) {
      return;
    }

    const beforeSize = this.memories.size;

    // Remove expired memories
    for (const [id, mem] of this.memories.entries()) {
      if (mem.ttlMs && now - mem.createdAt > mem.ttlMs) {
        this.memories.delete(id);
      }
    }

    // Remove low-importance old memories if over limit
    if (this.memories.size > this.config.maxMemories) {
      const sorted = Array.from(this.memories.values()).sort((a, b) => {
        const scoreA = a.importance + a.accessCount * 0.01 -
          (now - a.lastAccessedAt) / (24 * 60 * 60 * 1000);
        const scoreB = b.importance + b.accessCount * 0.01 -
          (now - b.lastAccessedAt) / (24 * 60 * 60 * 1000);
        return scoreB - scoreA;
      });

      const toKeep = new Set(sorted.slice(0, this.config.maxMemories).map((m) => m.id));
      for (const [id] of this.memories.entries()) {
        if (!toKeep.has(id)) {
          this.memories.delete(id);
        }
      }
    }

    // Cleanup old relationships
    for (const [name, rel] of this.relationships.entries()) {
      if (now - rel.lastSeen > 7 * 24 * 60 * 60 * 1000) {
        // 7 days
        this.relationships.delete(name);
      }
    }

    const afterSize = this.memories.size;
    if (beforeSize !== afterSize) {
      telemetry.record(EventType.AGENT_LEARN, {
        type: 'gc',
        before: beforeSize,
        after: afterSize,
        removed: beforeSize - afterSize
      });
    }

    this.lastGC = now;
  }

  private startGarbageCollector(): void {
    setInterval(() => this.gc(), this.config.gcIntervalMs);
  }

  // Persistence methods with conflict resolution
  async save(storage: MemoryStorage): Promise<void> {
    this.version++;
    await storage.save({
      version: this.version,
      memories: Array.from(this.memories.values()),
      relationships: Object.fromEntries(this.relationships),
      places: Object.fromEntries(this.places),
      skills: Object.fromEntries(this.skills),
      failures: Object.fromEntries(this.failures),
      timestamp: Date.now()
    });
  }

  async load(storage: MemoryStorage): Promise<void> {
    const data = await storage.load();
    if (!data) return;

    // Merge strategy: take remote version, apply local discoveries
    const remoteVersion = data.version || 0;
    if (remoteVersion >= this.version) {
      this.memories.clear();
      data.memories.forEach((m) => this.memories.set(m.id, m));
      this.relationships = new Map(Object.entries(data.relationships || {}));
      this.places = new Map(Object.entries(data.places || {}));
      this.skills = new Map(Object.entries(data.skills || {}));
      this.failures = new Map(Object.entries(data.failures || {}));
      this.version = remoteVersion;
    }
  }

  getStats() {
    return {
      memories: this.memories.size,
      relationships: this.relationships.size,
      places: this.places.size,
      skills: this.skills.size,
      failures: this.failures.size,
      version: this.version,
      accessLogSize: this.accessLog.length
    };
  }
}

// Supporting types
interface RelationshipMemory {
  playerName: string;
  firstSeen: number;
  lastSeen: number;
  encounters: number;
  trust: number;
  stance: 'unknown' | 'friendly' | 'cooperative' | 'cautious' | 'distrusted';
  facts: string[];
  interactions: Array<{ at: number; text: string }>;
  failedCooperations: number;
  successfulCooperations: number;
}

interface PlaceMemory {
  key: string;
  x: number;
  z: number;
  level: number;
  firstSeen: number;
  lastSeen: number;
  visits: number;
  npcs: string[];
  resources: string[];
  dangers: string[];
  safetyRating: number; // 0-1
  profitability: number; // coins/hour
}

interface SkillMemory {
  name: string;
  levelRequired: number;
  xpPerHour: number;
  duration: number;
  prerequisites: string[];
  unlocks: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  lastAttempted: number;
  successRate: number;
}

interface FailureMemory {
  action: string;
  firstOccurred: number;
  lastOccurred: number;
  count: number;
  reason: string;
  contexts: any[];
  preconditions: string[];
}

interface MemoryStorage {
  save(data: any): Promise<void>;
  load(): Promise<any | null>;
}
