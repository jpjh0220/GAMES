/**
 * NPC RELATIONSHIP MODEL - tracks stance, dialogue history, quest hints
 * 
 * Humans recognize: "This NPC keeps mentioning 'lost sword' → quest hint"
 * This system tracks dialogue patterns and infers NPC intent.
 */

export interface NPCRelationship {
  name: string;
  stance: 'hostile' | 'neutral' | 'friendly' | 'unknown';
  dialogueHistory: string[];
  questHints: string[];
  tradeOffers: Map<string, number>; // item → price
  lastInteraction?: number;
}

export class NPCRelationships {
  private npcMap = new Map<string, NPCRelationship>();

  /**
   * Record dialogue or NPC interaction
   */
  recordInteraction(npcName: string, dialogue: string, stance?: string) {
    const npc = this.npcMap.get(npcName) || {
      name: npcName,
      stance: 'unknown' as const,
      dialogueHistory: [],
      questHints: [],
      tradeOffers: new Map(),
    };

    npc.dialogueHistory.push(dialogue);
    if (stance) npc.stance = stance as any;
    npc.lastInteraction = Date.now();

    // Heuristic: if dialogue contains keywords, infer quest
    const keywords = [
      'find',
      'lost',
      'stolen',
      'need',
      'bring',
      'help',
      'reward',
      'danger',
      'cursed',
    ];
    for (const kw of keywords) {
      if (dialogue.toLowerCase().includes(kw) && !npc.questHints.includes(dialogue)) {
        npc.questHints.push(dialogue);
      }
    }

    this.npcMap.set(npcName, npc);
  }

  /**
   * Record an NPC price offer
   */
  recordPrice(npcName: string, item: string, price: number) {
    const npc = this.npcMap.get(npcName) || {
      name: npcName,
      stance: 'neutral',
      dialogueHistory: [],
      questHints: [],
      tradeOffers: new Map(),
    };
    npc.tradeOffers.set(item, price);
    this.npcMap.set(npcName, npc);
  }

  /**
   * Get NPCs with unmet quest hints
   */
  getPotentialQuests(): { npc: string; hint: string }[] {
    const quests = [];
    for (const [name, rel] of this.npcMap) {
      for (const hint of rel.questHints) {
        quests.push({ npc: name, hint });
      }
    }
    return quests;
  }

  /**
   * Get friendly NPCs (good for trading)
   */
  getFriendlyNPCs(): string[] {
    return Array.from(this.npcMap.values())
      .filter(n => n.stance === 'friendly')
      .map(n => n.name);
  }
}
