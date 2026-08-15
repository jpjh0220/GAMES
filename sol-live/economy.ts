/**
 * ECONOMY MODEL - learn prices and optimize for profit/XP efficiency
 *
 * Humans know: "Yak meat sells for 200gp, salmon for 300gp, cooking heals 5hp per"
 * They optimize: "fishing + cooking yields 500gp + 100xp, vs pure combat 200gp + 80xp"
 *
 * This system:
 * - Observes NPC prices and player transactions
 * - Builds a price model for all items
 * - Computes XP/hour and profit/hour for each activity
 * - Ranks activities by chosen metric (max profit, max XP, max money/XP ratio)
 */

export interface ItemValue {
  name: string;
  buyPrice?: number; // NPC or player offers this price
  sellPrice?: number; // NPC buys at this price
  tradedPrice?: number; // observed in player trading
  lastSeen: number;
  observations: number;
}

export interface ActivityMetrics {
  name: string; // "fishing at draynor"
  profitPerHour: number; // gp/hour (negative if costs money)
  xpPerHour: number;
  profitPerXp: number; // gp per xp (negative = loss)
  successRate: number; // fraction of attempts that succeed
  samples: number;
  lastObserved: number;
}

export class EconomyModel {
  private itemValues = new Map<string, ItemValue>();
  private activityMetrics = new Map<string, ActivityMetrics>();

  /**
   * Observe an NPC price
   */
  observePrice(itemName: string, buyPrice?: number, sellPrice?: number) {
    const item = this.itemValues.get(itemName) || {
      name: itemName,
      lastSeen: Date.now(),
      observations: 0,
    };

    if (buyPrice) item.buyPrice = buyPrice;
    if (sellPrice) item.sellPrice = sellPrice;
    item.observations++;
    item.lastSeen = Date.now();

    this.itemValues.set(itemName, item);
  }

  /**
   * Observe a player trade or transaction
   */
  observeTransaction(itemName: string, price: number, isSale: boolean) {
    const item = this.itemValues.get(itemName) || {
      name: itemName,
      lastSeen: Date.now(),
      observations: 0,
    };

    if (isSale) {
      // player sold at this price
      if (!item.sellPrice) item.sellPrice = price;
      else item.sellPrice = Math.round((item.sellPrice + price) / 2); // average
    } else {
      // player bought at this price
      if (!item.buyPrice) item.buyPrice = price;
      else item.buyPrice = Math.round((item.buyPrice + price) / 2);
    }

    item.observations++;
    item.lastSeen = Date.now();
    this.itemValues.set(itemName, item);
  }

  /**
   * Record metrics for an activity
   */
  recordActivity(name: string, profitGp: number, xpGained: number, ticksSpent: number, success: boolean) {
    const ticksPerHour = 3600 / 0.6; // RuneScape tick is ~0.6s, so ~6000 ticks/hour
    const profitPerHour = (profitGp / ticksSpent) * ticksPerHour;
    const xpPerHour = (xpGained / ticksSpent) * ticksPerHour;
    const profitPerXp = xpGained > 0 ? profitGp / xpGained : 0;

    const existing = this.activityMetrics.get(name) || {
      name,
      profitPerHour: 0,
      xpPerHour: 0,
      profitPerXp: 0,
      successRate: 1,
      samples: 0,
      lastObserved: Date.now(),
    };

    // Running average
    const n = existing.samples + 1;
    existing.profitPerHour = (existing.profitPerHour * (n - 1) + profitPerHour) / n;
    existing.xpPerHour = (existing.xpPerHour * (n - 1) + xpPerHour) / n;
    existing.profitPerXp = (existing.profitPerXp * (n - 1) + profitPerXp) / n;
    existing.successRate = (existing.successRate * (n - 1) + (success ? 1 : 0)) / n;
    existing.samples = n;
    existing.lastObserved = Date.now();

    this.activityMetrics.set(name, existing);
  }

  /**
   * Get estimated value of an item
   */
  getValue(itemName: string): number {
    const item = this.itemValues.get(itemName);
    if (!item) return 0;
    if (item.sellPrice) return item.sellPrice;
    if (item.buyPrice) return item.buyPrice;
    if (item.tradedPrice) return item.tradedPrice;
    return 0;
  }

  /**
   * Rank activities by a chosen metric
   */
  rankActivities(by: 'profit' | 'xp' | 'efficiency'): ActivityMetrics[] {
    const sorted = [...this.activityMetrics.values()].sort((a, b) => {
      let aScore = 0,
        bScore = 0;
      if (by === 'profit') {
        aScore = a.profitPerHour;
        bScore = b.profitPerHour;
      } else if (by === 'xp') {
        aScore = a.xpPerHour;
        bScore = b.xpPerHour;
      } else {
        aScore = a.profitPerXp;
        bScore = b.profitPerXp;
      }
      return bScore - aScore; // descending
    });
    return sorted;
  }

  /**
   * Best activity for a goal
   */
  getBestActivityFor(goal: 'money' | 'xp' | 'balanced'): ActivityMetrics | null {
    if (this.activityMetrics.size === 0) return null;
    const ranked = this.rankActivities(goal === 'money' ? 'profit' : goal === 'xp' ? 'xp' : 'efficiency');
    return ranked[0] || null;
  }
}
