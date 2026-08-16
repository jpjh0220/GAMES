import type { BotWorldState } from './src/bot/types.js';
import type { AgentCandidate } from './agent-brain.js';

export type ProgressionPlan={id:string;objective:string;reason:string;success:string;priorityFingerprints:string[];stage:number;blocked:boolean};
const lvl=(state:BotWorldState,name:string)=>Number((state.skills||[]).find((s:any)=>String(s.name||'').toLowerCase()===name)?.level||1);
const text=(c:AgentCandidate)=>`${c.label} ${(c.tags||[]).join(' ')}`.toLowerCase();
const matching=(candidates:AgentCandidate[],re:RegExp)=>candidates.filter(c=>re.test(text(c))).map(c=>c.fingerprint);
const has=(state:BotWorldState,re:RegExp)=>[...(state.inventory||[]),...(state.equipment||[])].some((i:any)=>re.test(String(i.name||'')));

export class ProgressionDirector{
  private lastPlan='';private lastPlanTick=-9999;private progressTick=-9999;
  plan(state:BotWorldState,candidates:AgentCandidate[],tick:number):ProgressionPlan{
    const mining=lvl(state,'mining'),smithing=lvl(state,'smithing'),woodcutting=lvl(state,'woodcutting'),fishing=lvl(state,'fishing'),cooking=lvl(state,'cooking'),attack=lvl(state,'attack'),strength=lvl(state,'strength'),defence=lvl(state,'defence');
    const free=Math.max(0,28-(state.inventory||[]).length);
    const toolMissing=!has(state,/bronze pickaxe|pickaxe|axe|small fishing net|fishing rod/);
    const bank=matching(candidates,/bank|deposit|travel.*bank/i);
    const shop=matching(candidates,/shop|trade|merchant|diango|buy/i);
    const mine=matching(candidates,/mine|copper rock|tin rock|iron rock/i);
    const smelt=matching(candidates,/smelt|furnace/i);
    const chop=matching(candidates,/chop|tree|woodcut/i);
    const fish=matching(candidates,/fish|net fishing|bait fishing/i);
    const cook=matching(candidates,/cook|range|fire/i);
    const combat=matching(candidates,/attack.*(man|goblin|chicken|rat)|combat/i);
    const explore=matching(candidates,/explore|walk|travel/i);
    const plan=(id:string,objective:string,reason:string,success:string,priorityFingerprints:string[],stage:number,blocked=false):ProgressionPlan=>{this.lastPlan=id;this.lastPlanTick=tick;return{id,objective,reason,success,priorityFingerprints,stage,blocked};};

    if(free<=3)return plan('resolve-capacity','Resolve inventory capacity before training','Space is a prerequisite for every productive loop. Deposit or sell, then verify free slots increased.','At least 8 free inventory slots.',[...bank,...shop],0,true);
    if(toolMissing&&shop.length)return plan('acquire-core-tools','Acquire one verified gathering tool','A pickaxe, axe, or net unlocks durable resource loops. Only buy a tool with an immediate use case and verify it appears in inventory.','A usable gathering tool is observed in inventory or equipment.',shop,1);
    if(mining<15&&mine.length)return plan('mine-to-15','Train Mining to level 15 with copper/tin/iron as available','Mining is a durable early resource skill; stop only after a level-up, full inventory, or an explicit access failure.','Mining level increases or a banked ore stack grows.',mine,2);
    if(smithing<15&&smelt.length)return plan('smelt-to-15','Train Smithing toward level 15 by smelting available ore','Smithing unlocks the iron-bar capability Sol previously identified as blocked. Smelt only ore already carried or banked, then verify XP or bars.','Smithing level increases or a bar is added.',smelt,3);
    if(woodcutting<15&&chop.length)return plan('woodcut-to-15','Train Woodcutting to level 15','Woodcutting creates fuel and a second reliable resource route. Bank logs after a verified inventory gain.','Woodcutting level increases or banked logs increase.',chop,4);
    if(cooking<10&&cook.length&&has(state,/raw shrimp|raw anchov|raw fish|shrimp|anchov/i))return plan('cook-foundation','Cook existing raw food into survival supplies','Cooking turns gathered fish into a verified survival buffer and prevents unnecessary merchant spending.','Cooking XP increases or cooked food replaces raw food.',cook,5);
    if(fishing<10&&fish.length)return plan('fish-for-food','Train Fishing only until a defined food milestone','Fish for usable food and XP, not indefinitely. End the trip after a level-up, enough food, or capacity pressure.','Fishing level increases or at least five useful fish are carried/banked.',fish,6);
    if(attack<10||strength<10||defence<10){if(combat.length)return plan('combat-foundation','Train combat fundamentals against a safe target','Build combat only with food, free inventory space, and a loot-resolution plan.','One combat skill increases, equipment improves, or a valuable drop is banked.',combat,7);}
    if(mining>=15&&smithing>=15&&smelt.length)return plan('iron-industry','Convert iron resources into the first productive industry loop','Mine or retrieve iron, smelt bars, then bank the result. This is a measurable progression loop rather than random gathering.','Iron bars or equivalent value are banked and the relevant skill increases.',smelt,8);
    return plan('directed-exploration','Find the next reachable progression resource or trainer','No current milestone action is visible. Explore deliberately until a bank, tool shop, resource node, furnace, trainer, or safe target appears.','A new actionable resource, NPC, route, or skill interaction becomes visible.',explore,9);
  }
  shouldOverride(plan:ProgressionPlan,candidate:AgentCandidate|undefined,tick:number){if(!candidate||!plan.priorityFingerprints.includes(candidate.fingerprint))return false;return tick-this.progressTick>2;}
  recordVerifiedProgress(){this.progressTick=this.lastPlanTick;}
}
