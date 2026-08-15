/**
 * GOAL DECOMPOSITION - break complex goals into multi-step chains
 *
 * "Get 50 Fishing" decomposes into:
 * 1. Go to fishing spot
 * 2. Get fishing net (if needed)
 * 3. Fish until level 50
 * 4. Celebrate completion
 */

export interface GoalChain {
  id: string;
  title: string; // "Get 50 Fishing"
  description: string;
  steps: GoalStep[]; // Ordered sequence
  currentStepIndex: number;
  status: 'active' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
}

export interface GoalStep {
  id: string;
  label: string; // "Acquire fishing net"
  description: string;
  targetAction?: string; // fingerprint
  isComplete?: () => boolean; // Predicate to check completion
  timeoutTicks?: number;
  maxRetries?: number;
}

export class GoalDecomposer {
  private chains = new Map<string, GoalChain>();

  /**
   * Decompose a complex goal into steps
   */
  decomposeGoal(title: string, description: string, domain: string): GoalChain {
    const steps = this.generateSteps(title, domain);
    const chain: GoalChain = {
      id: `chain-${Date.now()}`,
      title,
      description,
      steps,
      currentStepIndex: 0,
      status: 'active',
      startedAt: Date.now(),
    };
    this.chains.set(chain.id, chain);
    return chain;
  }

  /**
   * Generate steps based on goal type
   */
  private generateSteps(goal: string, domain: string): GoalStep[] {
    const steps: GoalStep[] = [];

    // Pattern: "Get X [Skill] to level Y"
    if (goal.match(/level\s+(\d+)/i)) {
      const level = goal.match(/(\d+)/)?.[1] || '50';
      const skill = goal.split(' ')[1] || 'Combat';
      steps.push(
        { id: 'locate', label: 'Locate training area', description: `Find a good spot to train ${skill}` },
        { id: 'gather-tools', label: 'Gather tools', description: `Get any tools needed for ${skill}` },
        { id: 'train', label: `Train to level ${level}`, description: `Practice ${skill} until level ${level}`, timeoutTicks: 5000 },
        { id: 'verify', label: 'Verify completion', description: `Check that level ${level} was achieved` }
      );
    }

    // Pattern: "Complete [Quest]"
    else if (goal.toLowerCase().includes('quest') || goal.toLowerCase().includes('return')) {
      steps.push(
        { id: 'understand', label: 'Understand quest', description: 'Review quest requirements' },
        { id: 'gather', label: 'Gather items', description: 'Collect items needed' },
        { id: 'travel', label: 'Travel to location', description: 'Go to quest destination' },
        { id: 'complete', label: 'Complete objectives', description: 'Fulfill quest tasks' },
        { id: 'return', label: 'Return to giver', description: 'Bring items/report to quest giver' }
      );
    }

    // Pattern: "[Item] Crafting" or "[Skill] Production"
    else if (goal.includes('craft') || goal.includes('make') || goal.includes('cook')) {
      steps.push(
        { id: 'find-recipe', label: 'Find recipe', description: 'Learn how to make it' },
        { id: 'gather-materials', label: 'Gather materials', description: 'Collect ingredients' },
        { id: 'craft', label: 'Craft items', description: 'Produce the items' },
        { id: 'sell-or-use', label: 'Sell or use', description: 'Profit or apply items' }
      );
    }

    // Fallback: 2-step (prepare + execute)
    else {
      steps.push(
        { id: 'prepare', label: 'Prepare', description: `Get ready for ${goal}` },
        { id: 'execute', label: 'Execute', description: `Pursue ${goal}` }
      );
    }

    return steps;
  }

  /**
   * Get current step in active chain
   */
  getCurrentStep(chainId: string): GoalStep | null {
    const chain = this.chains.get(chainId);
    if (!chain || chain.currentStepIndex >= chain.steps.length) return null;
    return chain.steps[chain.currentStepIndex];
  }

  /**
   * Advance to next step
   */
  advanceStep(chainId: string) {
    const chain = this.chains.get(chainId);
    if (!chain) return;
    chain.currentStepIndex++;
    if (chain.currentStepIndex >= chain.steps.length) {
      chain.status = 'completed';
      chain.completedAt = Date.now();
    }
  }

  /**
   * Get progress on chain (0-100%)
   */
  getProgress(chainId: string): number {
    const chain = this.chains.get(chainId);
    if (!chain) return 0;
    return Math.round((chain.currentStepIndex / chain.steps.length) * 100);
  }

  /**
   * Get active chain
   */
  getActiveChain(): GoalChain | null {
    for (const chain of this.chains.values()) {
      if (chain.status === 'active') return chain;
    }
    return null;
  }
}
