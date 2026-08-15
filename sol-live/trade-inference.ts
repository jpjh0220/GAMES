/**
 * TRADE INFERENCE - learns NPC trade chains and finds arbitrage
 *
 * Observes: "NPC A sells net for 500gp, NPC B buys net for 600gp"
 * Infers: Arbitrage opportunity (+100gp per transaction)
 *
 * Builds trade graphs and optimal routes
 */

export interface TradeOpportunity {
  item: string;
  sellNpc: string;
  sellPrice: number;
  buyNpc: string;
  buyPrice: number;
  profit: number; // buyPrice - sellPrice
  profitPerHour: number;
  observations: number;
  lastSeen: number;
}

export interface NpcTradeProfile {
  name: string;
  sells: Map<string, number>; // item → price
  buys: Map<string, number>; // item → price (what they pay)
  type: 'merchant' | 'general' | 'specialist'; // inferred from what they trade
}

export class TradeInference {
  private opportunities = new Map<string, TradeOpportunity>();
  private npcProfiles = new Map<string, NpcTradeProfile>();

  /**
   * Record an NPC trade (sell or buy)
   */
  recordTrade(npcName: string, item: string, price: number, type: 'sell' | 'buy') {
    const profile = this.npcProfiles.get(npcName) || {
      name: npcName,
      sells: new Map(),
      buys: new Map(),
      type: 'general',
    };

    if (type === 'sell') {
      profile.sells.set(item, price);
    } else {
      profile.buys.set(item, price);
    }

    // Update type based on what they trade
    const tradeCount = profile.sells.size + profile.buys.size;
    if (tradeCount > 20) profile.type = 'merchant';
    else if (tradeCount > 5) profile.type = 'specialist';

    this.npcProfiles.set(npcName, profile);
    this.computeArbitrage();
  }

  /**
   * Compute arbitrage opportunities
   */
  private computeArbitrage() {
    // Find items that multiple NPCs trade at different prices
    const itemPrices = new Map<string, { seller: string; price: number }[]>();

    for (const [npcName, profile] of this.npcProfiles) {
      for (const [item, price] of profile.sells) {
        if (!itemPrices.has(item)) itemPrices.set(item, []);
        itemPrices.get(item)!.push({ seller: npcName, price });
      }
    }

    // For each item with multiple sellers, find best buy/sell combo
    for (const [item, prices] of itemPrices) {
      if (prices.length < 2) continue;

      const sorted = prices.sort((a, b) => a.price - b.price);
      const cheapest = sorted[0];
      const expensive = sorted[sorted.length - 1];

      if (expensive.price > cheapest.price) {
        const key = `${item}-${cheapest.seller}-${expensive.seller}`;
        const opportunity: TradeOpportunity = {
          item,
          sellNpc: cheapest.seller,
          sellPrice: cheapest.price,
          buyNpc: expensive.seller,
          buyPrice: expensive.price,
          profit: expensive.price - cheapest.price,
          profitPerHour: (expensive.price - cheapest.price) * 3600, // assume 1 trade/sec
          observations: 1,
          lastSeen: Date.now(),
        };

        const existing = this.opportunities.get(key);
        if (existing) {
          existing.observations++;
          existing.lastSeen = Date.now();
        } else {
          this.opportunities.set(key, opportunity);
        }
      }
    }
  }

  /**
   * Get best arbitrage opportunities
   */
  getBestOpportunities(limit: number = 5): TradeOpportunity[] {
    return Array.from(this.opportunities.values())
      .filter(o => o.observations >= 2) // only trust multi-observed trades
      .sort((a, b) => b.profit - a.profit)
      .slice(0, limit);
  }

  /**
   * Get NPC trade profile
   */
  getProfileFor(npcName: string): NpcTradeProfile | null {
    return this.npcProfiles.get(npcName) || null;
  }

  /**
   * Find most profitable trading route
   */
  getMostProfitableRoute(): TradeOpportunity | null {
    const best = this.getBestOpportunities(1);
    return best.length > 0 ? best[0] : null;
  }
}
