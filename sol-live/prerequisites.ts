/**
 * prerequisites.ts — the thing that separates Sol from a human player.
 *
 * The game engine states its requirements in plain English ("You need a net to
 * catch these fish."). A human reads that once and goes and gets a net. Sol,
 * measured live on run 37, re-attempted net fishing 15 times after being told
 * twice, and 76% of all its actions produced no measurable change.
 *
 * This module converts refusal messages into (a) a hard block on the action that
 * caused them and (b) an acquisition subgoal that resolves the block.
 */

export type Blocker = {
  id: string;
  /** what the engine actually said */
  evidence: string;
  /** 'skill' = needs a level, 'item' = needs to hold something, 'coins' = needs money */
  kind: 'skill' | 'item' | 'coins' | 'unsellable';
  /** e.g. 'woodcutting' | 'small fishing net' */
  requirement: string;
  /** level needed, when kind === 'skill' */
  level?: number;
  /** action fingerprints suppressed while this blocker stands */
  blocks: string[];
  /** what Sol should do about it instead */
  subgoal: string;
  firstSeenTick: number;
  hits: number;
};

type Rule = {
  re: RegExp;
  /** `last` is the fingerprint of the action that provoked the message, when known. */
  build: (m: RegExpMatchArray, last?: string) => Omit<Blocker, 'id' | 'evidence' | 'firstSeenTick' | 'hits'>;
};

const RULES: Rule[] = [
  {
    // "You need a Woodcutting level of 30 to chop down this tree."
    re: /you need an?\s+(\w+)\s+level of (\d+)/i,
    build: (m) => {
      const skill = m[1].toLowerCase();
      const gathering: Record<string, string> = {
        woodcutting: 'loc:chop down:*',
        mining: 'loc:mine:*',
        fishing: 'npc:*:fishing spot',
      };
      return {
        kind: 'skill',
        requirement: skill,
        level: Number(m[2]),
        blocks: [gathering[skill] ?? `skill:${skill}:*`],
        subgoal: `Raise ${skill} to ${m[2]} before retrying; train on the lowest-requirement target available.`,
      };
    },
  },
  {
    // "You need a net to catch these fish."
    re: /you need an?\s+([a-z ]+?)\s+to\s+(.+)/i,
    build: (m) => {
      const item = m[1].trim().toLowerCase();
      return {
        kind: 'item',
        requirement: item,
        blocks: item.includes('net') ? ['npc:net:fishing spot', 'npc:bait:fishing spot'] : [`item:${item}:*`],
        subgoal: `Acquire a ${item} (shop, drop, or trade) before attempting to ${m[2].replace(/\.$/, '')}.`,
      };
    },
  },
  {
    // "You do not have an axe which you have the level to use."
    re: /you do not have an?\s+([a-z ]+?)\s+which you have the level to use/i,
    build: (m) => ({
      kind: 'item',
      requirement: m[1].trim().toLowerCase(),
      blocks: ['loc:chop down:*'],
      subgoal: `Obtain a usable ${m[1].trim()} at your current level before any woodcutting action.`,
    }),
  },
  {
    // "You don't have enough coins." — bars purchases until funds exist.
    re: /you don'?t have enough coins/i,
    build: () => ({
      kind: 'coins',
      requirement: 'coins',
      blocks: ['shop:buy:*'],
      subgoal: 'Earn coins first: sell sellable loot, or collect drops from a profitable target.',
    }),
  },
  {
    // "You can't sell this item to a shop." — scoped to the exact item, not all selling.
    re: /you can'?t sell this item to a shop/i,
    build: (_m, last) => {
      const item = last?.startsWith('shop:sell:') ? last.slice('shop:sell:'.length) : null;
      return {
        kind: 'unsellable',
        requirement: item ?? 'this item',
        blocks: [item ? `shop:sell:${item}` : 'shop:sell:*'],
        subgoal: item
          ? `Shops will not buy ${item}. Stop offering it; find a buyer or discard it.`
          : 'This shop refuses this item. Try a different shop, or stop attempting to sell it.',
      };
    },
  },
];

/** Glob match supporting '*' anywhere in the pattern. */
function matches(pattern: string, fingerprint: string): boolean {
  if (!pattern.includes('*')) return pattern === fingerprint;
  const rx = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return rx.test(fingerprint);
}

export class PrerequisiteTracker {
  private blockers = new Map<string, Blocker>();

  /** Feed every engine message. Returns newly-created blockers. */
  observe(text: string, tick: number, lastFingerprint?: string): Blocker[] {
    const created: Blocker[] = [];
    for (const rule of RULES) {
      const m = text.match(rule.re);
      if (!m) continue;
      const spec = rule.build(m, lastFingerprint);
      const id = `${spec.kind}:${spec.requirement}${spec.level ? ':' + spec.level : ''}`;
      const existing = this.blockers.get(id);
      if (existing) {
        existing.hits++;
      } else {
        const b: Blocker = { id, evidence: text.trim(), firstSeenTick: tick, hits: 1, ...spec };
        this.blockers.set(id, b);
        created.push(b);
      }
      break; // one rule per message
    }
    return created;
  }

  /** True if this action fingerprint is currently barred by a known prerequisite. */
  isBlocked(fingerprint: string): Blocker | null {
    for (const b of this.blockers.values()) {
      for (const pat of b.blocks) {
        if (matches(pat, fingerprint)) return b;
      }
    }
    return null;
  }

  /** Drop candidates the engine has already refused. */
  filter<T extends { fingerprint: string }>(candidates: T[]): { kept: T[]; removed: { c: T; why: Blocker }[] } {
    const kept: T[] = [];
    const removed: { c: T; why: Blocker }[] = [];
    for (const c of candidates) {
      const b = this.isBlocked(c.fingerprint);
      if (b) removed.push({ c, why: b });
      else kept.push(c);
    }
    return { kept, removed };
  }

  /** Clear a blocker once the requirement is genuinely met. */
  resolve(skills: Record<string, number>, inventoryNames: string[]) {
    const inv = inventoryNames.map((n) => n.toLowerCase());
    for (const [id, b] of [...this.blockers]) {
      if (b.kind === 'skill' && b.level && (skills[b.requirement] ?? 0) >= b.level) this.blockers.delete(id);
      if (b.kind === 'item' && inv.some((n) => n.includes(b.requirement.replace(/^an? /, '')))) this.blockers.delete(id);
      if (b.kind === 'coins' && (skills.__coins ?? 0) > 0) this.blockers.delete(id);
    }
  }

  /** Prerequisite work the strategist should adopt, most-hit first. */
  subgoals(): string[] {
    return [...this.blockers.values()].sort((a, b) => b.hits - a.hits).map((b) => b.subgoal);
  }

  all(): Blocker[] {
    return [...this.blockers.values()];
  }
}
