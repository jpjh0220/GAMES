/**
 * SKILL-TREE MODEL - tracks unlock chains and prerequisites
 * 
 * RuneScape: "Can't catch lobsters at level 30. Need level 40."
 * This system observes these patterns and builds unlock chains.
 * 
 * Result: Goals can form chains like [Get 30 Fishing] → [Get 40 Fishing] → [Catch Lobsters]
 */

export interface SkillUnlock {
  skill: string;      // "Fishing"
  minLevel: number;   // 40
  activity?: string;  // "Catch lobster"
  reward?: string;    // "500gp/hour"
  observedAt?: number;
}

export class SkillTree {
  private unlocks = new Map<string, SkillUnlock[]>();
  private observedMessages = new Set<string>();

  /**
   * Observe a level requirement message (e.g., "You need 40 Fishing")
   */
  observeSkillRequirement(message: string, skill: string, activity?: string) {
    const normalized = message.toLowerCase();
    if (this.observedMessages.has(normalized)) return;
    this.observedMessages.add(normalized);

    // Extract level from message
    const levelMatch = message.match(/(\d+)/);
    if (!levelMatch) return;

    const minLevel = parseInt(levelMatch[1]);
    const unlock: SkillUnlock = { skill, minLevel, activity, observedAt: Date.now() };

    const existing = this.unlocks.get(skill) || [];
    if (!existing.some(u => u.minLevel === minLevel && u.activity === activity)) {
      existing.push(unlock);
      this.unlocks.set(skill, existing.sort((a, b) => a.minLevel - b.minLevel));
    }
  }

  /**
   * Get next achievable unlock for a skill
   * Returns the lowest-level unlock the player can't yet do
   */
  getNextUnlock(skill: string, currentLevel: number): SkillUnlock | null {
    const unlocks = this.unlocks.get(skill) || [];
    for (const u of unlocks) {
      if (u.minLevel > currentLevel) return u;
    }
    return null;
  }

  /**
   * Get all skills with progression available
   */
  getProgressionTargets(skillLevels: Record<string, number>): { skill: string; nextLevel: number; activity?: string }[] {
    const targets = [];
    for (const [skill, level] of Object.entries(skillLevels)) {
      const next = this.getNextUnlock(skill, level);
      if (next) {
        targets.push({ skill: next.skill, nextLevel: next.minLevel, activity: next.activity });
      }
    }
    return targets.sort((a, b) => (a.nextLevel - b.nextLevel)); // Level up lowest skills first
  }

  /**
   * Form a "level up" goal for a skill
   */
  formLevelUpGoal(skill: string, currentLevel: number, targetLevel: number): { name: string; description: string } {
    const levelDiff = targetLevel - currentLevel;
    return {
      name: `Level up ${skill} (${currentLevel} → ${targetLevel})`,
      description: `Train ${skill.toLowerCase()} ${levelDiff} levels to unlock new activities`,
    };
  }
}
