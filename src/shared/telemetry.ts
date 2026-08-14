import pino from 'pino';
import type { Logger } from 'pino';

export enum EventType {
  // Game events
  GAME_START = 'game:start',
  GAME_PAUSE = 'game:pause',
  GAME_RESUME = 'game:resume',
  GAME_END = 'game:end',
  HUB_DISCOVERED = 'game:hub_discovered',
  HUB_SCANNED = 'game:hub_scanned',
  LEVEL_UP = 'game:level_up',

  // Agent events
  AGENT_INIT = 'agent:init',
  AGENT_DECISION = 'agent:decision',
  AGENT_ACTION = 'agent:action',
  AGENT_OUTCOME = 'agent:outcome',
  AGENT_LEARN = 'agent:learn',
  AGENT_GOAL_START = 'agent:goal_start',
  AGENT_GOAL_COMPLETE = 'agent:goal_complete',
  AGENT_GOAL_FAIL = 'agent:goal_fail',
  AGENT_MEMORY_SAVE = 'agent:memory_save',
  AGENT_MEMORY_LOAD = 'agent:memory_load',

  // System events
  CACHE_HIT = 'cache:hit',
  CACHE_MISS = 'cache:miss',
  CACHE_EVICT = 'cache:evict',
  NETWORK_TIMEOUT = 'network:timeout',
  NETWORK_ERROR = 'network:error',
  PERFORMANCE_METRIC = 'perf:metric'
}

export interface TelemetryEvent {
  type: EventType;
  timestamp: number;
  duration?: number;
  metadata?: Record<string, any>;
  userId?: string;
  sessionId?: string;
  tags?: string[];
}

export interface TelemetryConfig {
  enabled: boolean;
  batchSize: number;
  flushIntervalMs: number;
  endpoint?: string;
  localStorageKey: string;
  maxLocalEvents: number;
}

export class TelemetryService {
  private logger: Logger;
  private events: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private config: TelemetryConfig;
  private sessionId: string;
  private userId: string | null = null;

  constructor(config: Partial<TelemetryConfig> = {}) {
    this.config = {
      enabled: true,
      batchSize: 50,
      flushIntervalMs: 30000,
      localStorageKey: 'games_telemetry',
      maxLocalEvents: 1000,
      ...config
    };

    this.logger = pino({
      level: __DEV__ ? 'debug' : 'info',
      transport: __DEV__
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
      base: {
        version: __VERSION__,
        buildTime: __BUILD_TIME__
      }
    });

    this.sessionId = this.generateSessionId();
    this.userId = this.loadUserId();
    this.restoreEvents();
    this.startFlushTimer();
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private loadUserId(): string | null {
    if (typeof localStorage === 'undefined') return null;
    let userId = localStorage.getItem('games_user_id');
    if (!userId) {
      userId = this.generateSessionId();
      localStorage.setItem('games_user_id', userId);
    }
    return userId;
  }

  private restoreEvents(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const stored = localStorage.getItem(this.config.localStorageKey);
      if (stored) {
        this.events = JSON.parse(stored);
      }
    } catch (e) {
      this.logger.warn({ error: e }, 'Failed to restore telemetry events');
    }
  }

  private persistEvents(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        this.config.localStorageKey,
        JSON.stringify(this.events.slice(-this.config.maxLocalEvents))
      );
    } catch (e) {
      this.logger.warn({ error: e }, 'Failed to persist telemetry events');
    }
  }

  private startFlushTimer(): void {
    if (!this.config.enabled) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch((e) =>
        this.logger.error({ error: e }, 'Flush error')
      );
    }, this.config.flushIntervalMs);
  }

  record(
    type: EventType,
    metadata?: Record<string, any>,
    duration?: number
  ): void {
    if (!this.config.enabled) return;

    const event: TelemetryEvent = {
      type,
      timestamp: Date.now(),
      metadata,
      duration,
      userId: this.userId || undefined,
      sessionId: this.sessionId,
      tags: this.extractTags(metadata)
    };

    this.events.push(event);
    this.logger.debug({ event }, `Event recorded: ${type}`);

    if (this.events.length >= this.config.batchSize) {
      this.flush().catch((e) =>
        this.logger.error({ error: e }, 'Auto-flush error')
      );
    }

    this.persistEvents();
  }

  private extractTags(metadata?: Record<string, any>): string[] {
    if (!metadata) return [];
    const tags: string[] = [];
    if (metadata.skill) tags.push(`skill:${metadata.skill}`);
    if (metadata.area) tags.push(`area:${metadata.area}`);
    if (metadata.goal) tags.push(`goal:${metadata.goal}`);
    return tags;
  }

  async flush(): Promise<void> {
    if (!this.config.enabled || this.events.length === 0) return;

    const batch = this.events.splice(0, this.config.batchSize);

    try {
      if (this.config.endpoint) {
        const response = await fetch(this.config.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: this.sessionId,
            userId: this.userId,
            events: batch,
            timestamp: Date.now()
          })
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        this.logger.debug(
          { count: batch.length },
          'Telemetry flushed successfully'
        );
      } else {
        // Local-only mode: just persist
        this.persistEvents();
      }
    } catch (error) {
      // Re-queue events if flush fails
      this.events.unshift(...batch);
      this.logger.error(
        { error, batchSize: batch.length },
        'Failed to flush telemetry'
      );
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    await this.flush();
    this.persistEvents();
  }
}

export const telemetry = new TelemetryService({
  enabled: !__DEV__ || typeof window !== 'undefined',
  endpoint: process.env.VITE_TELEMETRY_ENDPOINT
});
