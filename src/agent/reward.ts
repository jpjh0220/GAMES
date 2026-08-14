import { telemetry, EventType } from '@shared/telemetry';

/**
 * CRITICAL FIX #15: Multi-dimensional reward with opportunity cost
 */

export interface RewardContext {
  action: string;
  timeSpent: number; // ticks
  before: GameMetrics;
  after: GameMetrics;
  lastPlan?: string;
  planAdherence: number; // 0-1
}

export interface GameMetrics {
  hp: number;
  maxHp: number;
  totalXp: number;
  totalLevels: number;
  inventory: any[];
  equipment: any[];
  coins: number;
  position: { x: number; z: number; level: number };
  inCombat: boolean;
  skills: Record<string, number>; // skill -> xp
}

export class AdvancedRewardCalculator {
  private skillEfficiencies: Map<string, number> = new Map();
  private discoveryValue: Map<string, number> = new Map();
  private skillUnlocks: Map<string, string[]> = new Map();
  private baseTick: number = 0;

  /**
   * Multi-dimensional reward function
   * Returns: { immediate, opportunity, discovery, learning, modifier }
   */
  calculate(context: RewardContext): {
    total: number;
    breakdown: Record<string, number>;
  } {
    const breakdown: Record<string, number> = {};

    // 1. SKILL PROGRESS (primary reward)
    const skillReward = this.skillProgressReward(context);
    breakdown.skill = skillReward;

    // 2. OPPORTUNITY COST PENALTY (negative)
    const opportunityPenalty = this.opportunityCostPenalty(context);
    breakdown.opportunityCost = opportunityPenalty;

    // 3. DISCOVERY BONUS (unlock new content)
    const discoveryBonus = this.discoveryReward(context);
    breakdown.discovery = discoveryBonus;

    // 4. SKILL GATE UNLOCK (enables future tasks)
    const unlocksBonus = this.skillUnlockBonus(context);
    breakdown.unlocks = unlocksBonus;

    // 5. COMBAT EFFICIENCY (damage, kills, survival)
    const combatReward = this.combatReward(context);
    breakdown.combat = combatReward;

    // 6. GOAL ADHERENCE (following plan)
    const adherenceBonus = this.planAdherenceBonus(context);
    breakdown.adherence = adherenceBonus;

    // 7. TEMPORAL DISCOUNT (long-term planning)
    const temporalDiscount = this.temporalDiscount(context.timeSpent);
    breakdown.temporal = temporalDiscount;

    // 8. DEATH PENALTY
    const deathPenalty = this.deathPenalty(context);
    breakdown.death = deathPenalty;

    const total =
      skillReward +
      opportunityPenalty +
      discoveryBonus +
      unlocksBonus +
      combatReward +
      adherenceBonus +
      temporalDiscount +
      deathPenalty;

    telemetry.record(EventType.AGENT_OUTCOME, {
      action: context.action,
      reward: Math.round(total * 100) / 100,
      breakdown,
      timeSpent: context.timeSpent
    });

    return {
      total: Math.max(-10, Math.min(10, total)),
      breakdown
    };
  }

  /**
   * Primary reward: XP and levels gained
   * Normalized by efficiency (XP per tick)
   */
  private skillProgressReward(context: RewardContext): number {
    const xpGain = Math.max(0, context.after.totalXp - context.before.totalXp);
    const levelGain = Math.max(0, context.after.totalLevels - context.before.totalLevels);
    const timeSpent = Math.max(1, context.timeSpent); // avoid div by 0

    const baseXpReward = xpGain * 0.01;
    const levelReward = levelGain * 2;
    const efficiencyBonus = Math.max(0, (xpGain / timeSpent - 0.1) * 0.5); // reward efficiency

    return baseXpReward + levelReward + efficiencyBonus;
  }

  /**
   * Opportunity cost penalty
   * If action is inefficient relative to other available actions, penalize
   */
  private opportunityCostPenalty(context: RewardContext): number {
    const xpPerTick = (context.after.totalXp - context.before.totalXp) / Math.max(1, context.timeSpent);

    // Reference efficiency: what could we earn doing something else?
    // For now, use average of known skill efficiencies
    const knownEfficiencies = Array.from(this.skillEfficiencies.values());
    if (knownEfficiencies.length === 0) return 0; // no data yet

    const avgEfficiency = knownEfficiencies.reduce((a, b) => a + b, 0) / knownEfficiencies.length;

    if (xpPerTick < avgEfficiency * 0.2) {
      return -1.0; // bad opportunity cost
    } else if (xpPerTick < avgEfficiency * 0.5) {
      return -0.3; // mediocre
    }

    return 0; // acceptable
  }

  /**
   * Discovery reward: finding new content unlocks learning
   */
  private discoveryReward(context: RewardContext): number {
    const posBefore = context.before.position;
    const posAfter = context.after.position;

    // Moved to new location?
    const moved = posBefore.x !== posAfter.x || posBefore.z !== posAfter.z;
    if (!moved) return 0;

    const locationKey = `${Math.floor(posAfter.x / 32)}-${Math.floor(posAfter.z / 32)}`;

    // If we've never been here, discovery bonus
    if (!this.discoveryValue.has(locationKey)) {
      this.discoveryValue.set(locationKey, 1);
      return 1.2; // new location discovered
    }

    return 0;
  }

  /**
   * Skill unlock bonus: reaching a level that enables new content
   */
  private skillUnlockBonus(context: RewardContext): number {
    let bonus = 0;

    for (const [skill, xpAfter] of Object.entries(context.after.skills)) {
      const xpBefore = context.before.skills[skill] || 0;
      if (xpAfter <= xpBefore) continue; // no progress

      // Check if crossed a known unlock threshold
      const unlocks = this.skillUnlocks.get(skill) || [];
      for (const unlock of unlocks) {
        const level = this.xpToLevel(xpAfter);
        const levelBefore = this.xpToLevel(xpBefore);
        if (level > levelBefore) {
          // Level up -> potential new content
          bonus += 0.5;
        }
      }
    }

    return bonus;
  }

  /**
   * Combat reward: damage, kills, health management
   */
  private combatReward(context: RewardContext): number {
    const hpBefore = context.before.hp;
    const hpAfter = context.after.hp;
    const inCombat = context.after.inCombat;

    let reward = 0;

    // Staying alive in combat is good
    if (inCombat) {
      if (hpAfter > hpBefore * 0.5) {
        reward += 0.3; // maintained health
      } else if (hpAfter > 0) {
        reward -= 0.2; // losing health
      }
    }

    // Healing when needed
    if (hpBefore < context.after.maxHp * 0.5 && hpAfter > hpBefore) {
      reward += 0.2;
    }

    return reward;
  }

  /**
   * Plan adherence bonus: following the strategist's plan
   */
  private planAdherenceBonus(context: RewardContext): number {
    const adherence = Math.max(0, Math.min(1, context.planAdherence));
    return adherence * 0.5; // up to +0.5 for following plan
  }

  /**
   * Temporal discount: long actions should have diminishing returns
   * Encourages frequent decision-making
   */
  private temporalDiscount(timeSpent: number): number {
    if (timeSpent < 10) return 0;
    if (timeSpent < 30) return -0.1;
    if (timeSpent < 60) return -0.3;
    return -0.5; // heavily penalize very long actions
  }

  /**
   * Death is catastrophic
   */
  private deathPenalty(context: RewardContext): number {
    const died = context.after.hp <= 0;
    return died ? -10 : 0;
  }

  /**
   * Convert XP to RuneScape level (rough approximation)
   */
  private xpToLevel(xp: number): number {
    if (xp < 0) return 1;
    let level = 1;
    let nextLevelXp = 83;

    while (xp >= nextLevelXp && level < 99) {
      xp -= nextLevelXp;
      level++;
      nextLevelXp = Math.floor(nextLevelXp * 1.1);
    }

    return level;
  }

  /**
   * Record skill efficiency for future opportunity cost calculations
   */
  recordSkillEfficiency(skill: string, xpPerHour: number): void {
    this.skillEfficiencies.set(skill, xpPerHour);
  }

  /**
   * Register skill unlocks (e.g., Level 10 Cooking unlocks new recipes)
   */
  registerSkillUnlock(skill: string, unlockedContent: string[]): void {
    this.skillUnlocks.set(skill, unlockedContent);
  }
}
