/**
 * QUEST SYSTEM - autonomous quest discovery and execution
 *
 * Parses NPC dialogue for quest hints and forms actionable Quest goals
 * "Return the lost sword to Sir Prysin" → Quest("Return Lost Sword")
 */

export interface Quest {
  id: string;
  title: string;
  giver: string;
  objective: string; // "Find lost sword"
  reward?: string; // "500gp, 1000xp"
  steps: string[]; // ["Travel to Sir Prysin", "Search cave", "Return sword"]
  status: 'discovered' | 'active' | 'completed' | 'failed';
  discoveredAt: number;
}

export class QuestSystem {
  private discoveredQuests = new Map<string, Quest>();
  private activeQuest: Quest | null = null;

  /**
   * Parse NPC dialogue for quest hints and form Quest objects
   */
  parseQuestHints(npcName: string, dialogue: string): Quest | null {
    const normalized = dialogue.toLowerCase();

    // Pattern 1: "Return [item] to [npc]"
    const returnMatch = dialogue.match(/return\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s+to\s+(\w+)/i);
    if (returnMatch) {
      const item = returnMatch[1];
      const recipient = returnMatch[2];
      const quest: Quest = {
        id: `quest-return-${item.replace(/\s+/g, '-')}`,
        title: `Return the ${item}`,
        giver: npcName,
        objective: `Find and return the ${item} to ${recipient}`,
        steps: [
          `Travel to ${recipient}`,
          `Search for the ${item}`,
          `Return to ${recipient}`,
        ],
        status: 'discovered',
        discoveredAt: Date.now(),
      };
      this.discoveredQuests.set(quest.id, quest);
      return quest;
    }

    // Pattern 2: "Find [item] in [place]"
    const findMatch = dialogue.match(/find\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s+in\s+(\w+(?:\s+\w+)?)/i);
    if (findMatch) {
      const item = findMatch[1];
      const location = findMatch[2];
      const quest: Quest = {
        id: `quest-find-${item.replace(/\s+/g, '-')}`,
        title: `Find the ${item}`,
        giver: npcName,
        objective: `Locate the ${item} in ${location}`,
        steps: [
          `Travel to ${location}`,
          `Search for the ${item}`,
          `Return with the ${item}`,
        ],
        status: 'discovered',
        discoveredAt: Date.now(),
      };
      this.discoveredQuests.set(quest.id, quest);
      return quest;
    }

    // Pattern 3: "Collect [n] [items]"
    const collectMatch = dialogue.match(/collect\s+(\d+)\s+(\w+(?:\s+\w+)?)/i);
    if (collectMatch) {
      const count = collectMatch[1];
      const items = collectMatch[2];
      const quest: Quest = {
        id: `quest-collect-${items.replace(/\s+/g, '-')}`,
        title: `Collect ${count} ${items}`,
        giver: npcName,
        objective: `Gather ${count} ${items}`,
        steps: [
          `Find source of ${items}`,
          `Collect ${count} ${items}`,
          `Return to ${npcName}`,
        ],
        status: 'discovered',
        discoveredAt: Date.now(),
      };
      this.discoveredQuests.set(quest.id, quest);
      return quest;
    }

    return null;
  }

  /**
   * Get all discovered quests
   */
  getDiscoveredQuests(): Quest[] {
    return Array.from(this.discoveredQuests.values()).filter(q => q.status === 'discovered');
  }

  /**
   * Adopt a quest as active
   */
  adoptQuest(questId: string): Quest | null {
    const quest = this.discoveredQuests.get(questId);
    if (!quest) return null;
    this.activeQuest = quest;
    quest.status = 'active';
    return quest;
  }

  /**
   * Mark quest as completed
   */
  completeQuest(questId: string) {
    const quest = this.discoveredQuests.get(questId);
    if (quest) {
      quest.status = 'completed';
      if (this.activeQuest?.id === questId) {
        this.activeQuest = null;
      }
    }
  }

  /**
   * Get active quest
   */
  getActiveQuest(): Quest | null {
    return this.activeQuest;
  }
}
