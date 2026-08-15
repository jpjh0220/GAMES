/**
 * GOAL SYSTEM - converts tactical moment-to-moment decisions into hierarchical gameplay
 *
 * A human player has GOALS: "earn money", "unlock fishing", "get a net", "reach level 50".
 * Each goal has STEPS (subgoals), each step has ACTIONS.
 * The goal doesn't get abandoned for a higher-reward distraction.
 *
 * Sol's architecture replaces tactical-only with:
 *   - Active Goal (what we're working toward)
 *   - Goal Step (where in the plan we are)
 *   - Action Filter (only allow actions that progress the goal)
 *   - Completion Check (did we succeed? move to next step or form new goal)
 */

export type GoalStatus = 'active' | 'blocked' | 'completed' | 'failed';
export type GoalPriority = 'critical' | 'high' | 'medium' | 'low';

export interface GoalStep {
  id: string;
  description: string; // "Acquire net from fishmonger"
  targetAction?: string; // fingerprint like "npc:trade:fishmonger"
  successCondition?: (inventory: any[], equipment: any[]) => boolean; // "have small net"
  maxAttempts?: number;
  timeoutTicks?: number;
}

export interface Goal {
  id: string;
  name: string; // "Unlock fishing skill"
  description: string;
  priority: GoalPriority;
  status: GoalStatus;
  steps: GoalStep[];
  currentStepIndex: number;
  failureReason?: string;
  createdAt: number;
  completedAt?: number;
  attemptCount: number;
}

export class GoalSystem {
  private activeGoal: Goal | null = null;
  private completedGoals: Goal[] = [];
  private failedGoals: Goal[] = [];

  /**
   * Form a new goal (usually triggered by a prerequisite or opportunity)
   */
  createGoal(name: string, description: string, steps: GoalStep[], priority: GoalPriority = 'medium'): Goal {
    const goal: Goal = {
      id: `goal-${Date.now()}`,
      name,
      description,
      priority,
      status: 'active',
      steps,
      currentStepIndex: 0,
      attemptCount: 0,
      createdAt: Date.now(),
    };
    return goal;
  }

  /**
   * Adopt a goal (replaces current active goal)
   */
  adoptGoal(goal: Goal) {
    // If critical/high priority, interrupt current goal
    if (this.activeGoal && goal.priority === 'critical') {
      this.activeGoal.status = 'blocked';
    }
    this.activeGoal = goal;
  }

  /**
   * Get current step of active goal
   */
  currentStep(): GoalStep | null {
    if (!this.activeGoal || this.activeGoal.currentStepIndex >= this.activeGoal.steps.length) {
      return null;
    }
    return this.activeGoal.steps[this.activeGoal.currentStepIndex];
  }

  /**
   * Check if an action matches the current goal step
   */
  matchesCurrentGoal(actionFingerprint: string): boolean {
    const step = this.currentStep();
    if (!step?.targetAction) return true; // no constraint
    return actionFingerprint === step.targetAction || actionFingerprint.startsWith(step.targetAction + ':');
  }

  /**
   * Mark current step as complete and advance
   */
  completeStep(inventory: any[], equipment: any[]) {
    if (!this.activeGoal) return;
    const step = this.currentStep();
    if (!step) return;

    if (step.successCondition && !step.successCondition(inventory, equipment)) {
      return; // condition not met
    }

    this.activeGoal.currentStepIndex++;

    if (this.activeGoal.currentStepIndex >= this.activeGoal.steps.length) {
      this.activeGoal.status = 'completed';
      this.activeGoal.completedAt = Date.now();
      this.completedGoals.push(this.activeGoal);
      this.activeGoal = null;
    }
  }

  /**
   * Mark goal as failed (attempt exceeded or timeout)
   */
  failGoal(reason: string) {
    if (!this.activeGoal) return;
    this.activeGoal.status = 'failed';
    this.activeGoal.failureReason = reason;
    this.failedGoals.push(this.activeGoal);
    this.activeGoal = null;
  }

  /**
   * Get the active goal's current description for prompting
   */
  getGoalContext(): string {
    if (!this.activeGoal) return 'No active goal. Optimize for immediate rewards.';
    const step = this.currentStep();
    return `GOAL: ${this.activeGoal.name}. CURRENT STEP: ${step?.description || 'Complete'}`;
  }

  /**
   * Get reward bonus for goal completion
   */
  getGoalCompletionBonus(goalId: string): number {
    const completed = this.completedGoals.find((g) => g.id === goalId);
    if (!completed) return 0;
    // Bonus scales with priority
    const bonusMap = { critical: 5.0, high: 3.0, medium: 1.5, low: 0.5 };
    return bonusMap[completed.priority] || 1.0;
  }

  /**
   * Prerequisite -> Goal factory
   */
  static createGoalFromPrerequisite(blockReason: string): Goal | null {
    // "You need a net to catch these fish" -> Goal("Acquire net")
    if (blockReason.includes('need a net')) {
      return {
        id: `prereq-net`,
        name: 'Acquire net',
        description: 'Get a fishing net from a shop or NPC',
        priority: 'high',
        status: 'active',
        steps: [
          {
            id: 'travel-shop',
            description: 'Travel to a shop that sells fishing nets',
            timeoutTicks: 200,
          },
          {
            id: 'trade-net',
            description: 'Trade for or buy a net',
            targetAction: 'npc:trade:',
            successCondition: (inv) => inv.some((i) => i.name?.includes('net')),
          },
        ],
        currentStepIndex: 0,
        attemptCount: 0,
        createdAt: Date.now(),
      };
    }

    if (blockReason.includes('Woodcutting level')) {
      const match = blockReason.match(/level (\d+)/);
      const level = match ? match[1] : '30';
      return {
        id: `prereq-woodcutting`,
        name: `Raise Woodcutting to ${level}`,
        description: 'Train woodcutting on low-level trees',
        priority: 'high',
        status: 'active',
        steps: [
          {
            id: 'train-woodcutting',
            description: `Train on willows or trees until level ${level}`,
            targetAction: 'loc:chop down:',
            timeoutTicks: 1000,
          },
        ],
        currentStepIndex: 0,
        attemptCount: 0,
        createdAt: Date.now(),
      };
    }

    return null;
  }

  /**
   * Form a subgoal from a failure reason (e.g., "MISSING_NET" -> "Acquire net")
   */
  formSubgoalFromFailure(parentAction: string, failureReason: string): Goal | null {
    const subgoals: Record<string, Goal> = {
      'MISSING_NET': {
        id: `subgoal-net-${Date.now()}`,
        name: 'Acquire fishing net',
        description: 'Get a small net to fish',
        priority: 'high',
        status: 'active',
        steps: [
          {
            id: 'find-net-shop',
            description: 'Travel to a shop selling nets',
            timeoutTicks: 300,
          },
          {
            id: 'trade-net',
            description: 'Buy or trade for a net',
            targetAction: 'npc:trade:',
            successCondition: (inv) => inv.some((i) => String(i.name || '').toLowerCase().includes('net')),
          },
        ],
        currentStepIndex: 0,
        attemptCount: 0,
        createdAt: Date.now(),
      },
      'MISSING_BAIT': {
        id: `subgoal-bait-${Date.now()}`,
        name: 'Acquire fishing bait',
        description: 'Get bait (shrimp, anchovies) for fishing',
        priority: 'high',
        status: 'active',
        steps: [
          {
            id: 'find-bait-source',
            description: 'Travel to a shop or fishing spot with bait',
            timeoutTicks: 300,
          },
          {
            id: 'acquire-bait',
            description: 'Buy or catch bait',
            timeoutTicks: 400,
          },
        ],
        currentStepIndex: 0,
        attemptCount: 0,
        createdAt: Date.now(),
      },
      'INVENTORY_FULL': {
        id: `subgoal-bank-${Date.now()}`,
        name: 'Visit bank to store items',
        description: 'Go to a bank and deposit items to make room',
        priority: 'high',
        status: 'active',
        steps: [
          {
            id: 'travel-bank',
            description: 'Travel to nearest bank',
            targetAction: 'walk:',
            timeoutTicks: 300,
          },
          {
            id: 'use-bank',
            description: 'Use bank booth and deposit items',
            targetAction: 'loc:use:bank',
            timeoutTicks: 200,
          },
        ],
        currentStepIndex: 0,
        attemptCount: 0,
        createdAt: Date.now(),
      },
    };

    const subgoal = subgoals[failureReason];
    if (subgoal) {
      this.adoptGoal(subgoal);
      return subgoal;
    }
    return null;
  }
}
