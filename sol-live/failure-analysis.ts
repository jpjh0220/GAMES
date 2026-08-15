/**
 * FAILURE ANALYSIS - capture why an action failed to enable causal reasoning
 *
 * A human says "I tried to fish but failed because I had no bait"
 * Sol currently just records reward = -0.60
 *
 * This system extracts the REASON from the engine's messages and game state:
 * - "You need bait to fish" -> MISSING_ITEM("bait")
 * - "You need Fishing level 30" -> SKILL_TOO_LOW("Fishing", 1, 30)
 * - "You can't do that here" -> LOCATION_BLOCKED
 * - Player died -> DIED_IN_COMBAT
 * - Repeated "No measurable change" -> EXECUTION_FAILED
 *
 * Enables learning: "fishing without bait fails" -> "check bait before fishing"
 */

export type FailureReason =
  | 'MISSING_ITEM'
  | 'SKILL_TOO_LOW'
  | 'LOCATION_BLOCKED'
  | 'INVENTORY_FULL'
  | 'NOT_ENOUGH_COINS'
  | 'DIED_IN_COMBAT'
  | 'TIMED_OUT'
  | 'EXECUTION_FAILED'
  | 'UNKNOWN';

export interface Failure {
  action: string; // e.g., "npc:net:fishing spot"
  reason: FailureReason;
  details: Record<string, any>; // e.g., {item: "bait", skill: "Fishing", level: 30}
  tick: number;
  location?: { x: number; z: number };
}

export class FailureAnalyzer {
  private failures: Failure[] = [];

  /**
   * Analyze an action outcome and extract failure reason
   */
  analyzeOutcome(
    action: string,
    gameMessages: string[],
    playerState: any,
    executionFailed: boolean,
    died: boolean,
    tick: number
  ): Failure | null {
    if (!executionFailed && !died && gameMessages.length === 0) {
      return null; // success, no failure to analyze
    }

    // Check death first
    if (died) {
      return {
        action,
        reason: 'DIED_IN_COMBAT',
        details: { hp: playerState.hp },
        tick,
        location: { x: playerState.worldX, z: playerState.worldZ },
      };
    }

    // Parse messages for specific failure types
    for (const msg of gameMessages) {
      if (msg.includes('You need') && msg.includes('level')) {
        const match = msg.match(/(\w+)\s+level of (\d+)/i);
        if (match) {
          return {
            action,
            reason: 'SKILL_TOO_LOW',
            details: { skill: match[1], required: parseInt(match[2]), actual: playerState.skills?.[match[1].toLowerCase()] || 0 },
            tick,
            location: { x: playerState.worldX, z: playerState.worldZ },
          };
        }
      }

      if (msg.includes('You need') && msg.includes('to')) {
        const match = msg.match(/need\s+(?:an?\s+)?([a-z ]+?)\s+to/i);
        if (match) {
          return {
            action,
            reason: 'MISSING_ITEM',
            details: { item: match[1], action },
            tick,
            location: { x: playerState.worldX, z: playerState.worldZ },
          };
        }
      }

      if (msg.includes("don't have enough coins")) {
        return {
          action,
          reason: 'NOT_ENOUGH_COINS',
          details: { coins: playerState.coins, needed: 'unknown' },
          tick,
          location: { x: playerState.worldX, z: playerState.worldZ },
        };
      }

      if (msg.includes("can't do that here")) {
        return {
          action,
          reason: 'LOCATION_BLOCKED',
          details: { location: action },
          tick,
          location: { x: playerState.worldX, z: playerState.worldZ },
        };
      }

      if (msg.includes("inventory is full")) {
        return {
          action,
          reason: 'INVENTORY_FULL',
          details: { action },
          tick,
          location: { x: playerState.worldX, z: playerState.worldZ },
        };
      }
    }

    // Fallback: execution failed but no specific message
    if (executionFailed) {
      return {
        action,
        reason: 'EXECUTION_FAILED',
        details: { action },
        tick,
        location: { x: playerState.worldX, z: playerState.worldZ },
      };
    }

    return { action, reason: 'UNKNOWN', details: {}, tick };
  }

  /**
   * Store failure for analysis
   */
  record(failure: Failure) {
    this.failures.push(failure);
    if (this.failures.length > 200) this.failures.shift();
  }

  /**
   * Get failure patterns: "what keeps failing?"
   */
  getPatterns(): Map<string, number> {
    const patterns = new Map<string, number>();
    for (const f of this.failures) {
      const key = `${f.action}::${f.reason}`;
      patterns.set(key, (patterns.get(key) || 0) + 1);
    }
    // Sort by frequency
    return new Map([...patterns.entries()].sort((a, b) => b[1] - a[1]));
  }

  /**
   * For an action, what blocks it?
   */
  getBlockersForAction(action: string): Failure[] {
    return this.failures.filter((f) => f.action === action && f.reason !== 'EXECUTION_FAILED');
  }

  /**
   * Convert to memory entry: "fishing fails without bait"
   */
  extractLesson(failure: Failure): string | null {
    if (failure.reason === 'MISSING_ITEM') {
      return `${failure.action} requires ${failure.details.item}`;
    }
    if (failure.reason === 'SKILL_TOO_LOW') {
      return `${failure.action} requires ${failure.details.skill} level ${failure.details.required}`;
    }
    if (failure.reason === 'LOCATION_BLOCKED') {
      return `${failure.action} cannot be done at location ${failure.location?.x},${failure.location?.z}`;
    }
    if (failure.reason === 'DIED_IN_COMBAT') {
      return `location ${failure.location?.x},${failure.location?.z} is too dangerous`;
    }
    return null;
  }
}
