import type { BotWorldState } from './src/bot/types.js';
import type { AgentCandidate } from './agent-brain.js';

export type ProgressionContract={prerequisites:string[];requiredResources:string[];terminalEvidence:string[];forbiddenWhileActive:string[];replanTriggers:string[]};
export type ProgressionPlan={id:string;objective:string;reason:string;success:string;priorityFingerprints:string[];stage:number;blocked:boolean;contract:ProgressionContract};
const lvl=(state:BotWorldState,name:string)=>Number((state.skills||[]).find((s:any)=>String(s.name||'').toLowerCase()===name)?.level||1);
const text=(c:AgentCandidate)=>`${c.label} ${(c.tags||[]).join(' ')}`.toLowerCase();
const matching=(candidates:AgentCandidate[],re:RegExp)=>candidates.filter(c=>re.test(text(c))).map(c=>c.fingerprint);
const has=(state:BotWorldState,re:RegExp)=>[...(state.inventory||[]),...(state.equipment||[])].some((i:any)=>re.test(String(i.name||'')));

export class ProgressionDirector{
  private lastPlan='';private lastPlanTick=-9999;private progressTick=-9999;
  plan(state:BotWorldState,candidates:AgentCandidate[],tick:number):ProgressionPlan{
    const mining=lvl(state,'mining'),smithing=lvl(state,'smithing'),woodcutting=lvl(state,'woodcutting'),fishing=lvl(state,'fishing'),cooking=lvl(state,'cooking'),attack=lvl(state,'attack'),strength=lvl(state,'strength'),defence=lvl(state,'defence');
    const free=Math.max(0,28-(state.inventory||[]).length);
    const hasPickaxe=has(state,/pickaxe/i),hasAxe=has(state,/axe/i),hasNetOrRod=has(state,/fishing net|fishing rod/i);
    const bank=matching(candidates,/bank|deposit|travel.*bank/i);
    const productiveBuy=matching(candidates,/buy.*(pickaxe|axe|fishing net|fishing rod|tinderbox)/i);
    const productiveWithdraw=matching(candidates,/withdraw.*(pickaxe|axe|fishing net|fishing rod|tinderbox)/i);
    const equip=matching(candidates,/^(wield|wear|equip).*?(bronze|iron|steel|shortbow|shield|helmet|body|legs)/i);
    const shop=matching(candidates,/shop|trade|merchant|diango/i);
    const capacityRoute=bank.length?bank:shop;
    const mine=matching(candidates,/mine|copper rock|tin rock|iron rock/i);
    const smelt=matching(candidates,/smelt|furnace/i);
    const chop=matching(candidates,/chop|tree|woodcut/i);
    const fish=matching(candidates,/fish|net fishing|bait fishing/i);
    const cook=matching(candidates,/cook|range|fire/i);
    const combat=matching(candidates,/attack.*(man|goblin|chicken|rat)|combat/i);
    const explore=matching(candidates,/explore|walk|travel/i);
    const plan=(id:string,objective:string,reason:string,success:string,priorityFingerprints:string[],stage:number,blocked=false):ProgressionPlan=>{this.lastPlan=id;this.lastPlanTick=tick;const capacity=/capacity|bank|merchant|shop|store|deposit|sell/i.test(objective);const training=/train|fish|mine|smith|woodcut|cook|combat/i.test(objective);const contract:ProgressionContract={prerequisites:capacity?['reachable bank, shop, or valid use/discard route']:training?['required tool or interaction','survival resources','reachable target']:['reachable legal action'],requiredResources:capacity?['inventory slots','item disposition evidence']:training?['food or safe HP margin','tool/equipment if required']:['position and legal action'],terminalEvidence:[success,'measured state delta compatible with the selected action'],forbiddenWhileActive:capacity?['unrelated combat','low-value pickup','zero-value sale']:training?['indefinite gathering','unverified target repetition']:['repeated no-progress action'],replanTriggers:['SDK refusal','no measurable change','postcondition failure','stale world state','resource threshold changed']};return{id,objective,reason,success,priorityFingerprints,stage,blocked,contract};};

    return plan('open-ended-play','Explore, learn, and play purposefully','No permanent progression milestone is imposed. Let Sol choose a temporary subgoal from novelty, usefulness, safety, social opportunity, and the mechanics it has not yet understood.','A verified discovery, learned mechanic, meaningful interaction, useful state change, or deliberate safe experiment is recorded.',[...new Set([...explore,...mine,...smelt,...chop,...fish,...cook,...combat,...shop,...equip])],1,false);
  }
  shouldOverride(plan:ProgressionPlan,candidate:AgentCandidate|undefined,tick:number){if(!candidate||!plan.priorityFingerprints.includes(candidate.fingerprint))return false;return tick-this.progressTick>2;}
  recordVerifiedProgress(){this.progressTick=this.lastPlanTick;}
}
