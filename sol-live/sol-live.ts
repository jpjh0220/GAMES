import { startSession } from './src/lite/session.js';
import { BotStateCollector } from './src/bot/StateCollector.js';
import { ActionExecutor } from './src/bot/ActionExecutor.js';
import type { Client } from './src/client/Client.js';
import type { BotWorldState } from './src/bot/types.js';
import { appendFile } from 'fs/promises';
import { SolAgentBrain, type AgentCandidate, type AgentChoice } from './agent-brain.js';

const username = process.env.SOL_USER!;
const password = process.env.SOL_PASS!;
const RUN_MS = 19_800_000; // 5h30m: leave generous room for model setup, persistence, artifacts and handoff.
const viewerHtml = await Bun.file('./viewer.html').text();
const sessionStartedAt = new Date().toISOString();
const directive = 'remain alive, learn continuously, avoid loops, expand capabilities indefinitely';
const runNumber = Number(process.env.GITHUB_RUN_NUMBER || 0) || null;

type FeedEvent = {
  tick: number;
  label: string;
  summary: string;
  reason: string;
  target?: string;
  item?: string;
  source?: string;
  reward?: number;
  at: string;
};
type TrailPoint = { x: number; z: number; level: number; tick: number };

let tick = 0;
let actions = 0;
let nextDecisionTick = 0;
let lastReflexTick = -9999;
let lastState: BotWorldState | null = null;
let currentAction: FeedEvent | null = null;
let currentGoal = 'Initialize persistent agent';
let currentWhy = 'Load memory, connect perception, and wait for the local teacher model.';
let decisionInFlight = false;
const actionHistory: FeedEvent[] = [];
const movementTrail: TrailPoint[] = [];

const brain = new SolAgentBrain({
  name: username,
  directive,
  model: process.env.SOL_AGENT_MODEL || 'qwen3:1.7b',
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  githubToken: process.env.GH_TOKEN,
  githubRepo: process.env.GITHUB_REPOSITORY,
  runNumber
});
await brain.init();

const log = async (event: string, data?: unknown) => {
  const line = `[${new Date().toISOString()}] ${event}${data === undefined ? '' : ' ' + JSON.stringify(data)}\n`;
  process.stdout.write(line);
  await appendFile('../../sol-session.log', line).catch(() => {});
};

const feed = (label: string, summary: string, reason: string, data: Partial<FeedEvent> = {}) => {
  const e: FeedEvent = {
    tick,
    label,
    summary,
    reason,
    source:data.source,
    reward:data.reward,
    target:data.target,
    item:data.item,
    at:new Date().toISOString()
  };
  currentAction = e;
  actionHistory.push(e);
  if (actionHistory.length > 200) actionHistory.shift();
};

let snapshot: any = {
  updatedAt:new Date().toISOString(), online:false, inGame:false, tick:0, revision:0,
  sessionStartedAt, directive, runNumber,
  player:null, skills:[], inventory:[], equipment:[], nearbyNpcs:[], nearbyPlayers:[], groundItems:[], nearbyLocs:[],
  combatStyle:null, combatEvents:[], gameMessages:[], recentDialogs:[], prayers:null,
  worldUi:{shopOpen:false,bankOpen:false,tradeOpen:false,dialogOpen:false,modalOpen:false},
  currentAction:null, currentGoal, currentWhy, actions:[], actionCount:0, movementTrail:[], lessons:[], agent:brain.publicState()
};

const refreshSnapshot = (state: BotWorldState | null) => {
  const s: any = state;
  if (state?.player && (tick % 2 === 0 || movementTrail.length === 0)) {
    const last = movementTrail[movementTrail.length - 1];
    const next = { x:state.player.worldX, z:state.player.worldZ, level:state.player.level, tick };
    if (!last || last.x !== next.x || last.z !== next.z || last.level !== next.level) {
      movementTrail.push(next);
      if (movementTrail.length > 420) movementTrail.shift();
    }
  }
  const agent = brain.publicState();
  snapshot = {
    updatedAt:new Date().toISOString(),
    online:!!state?.player,
    inGame:!!s?.inGame,
    tick,
    revision:s?.revision ?? 0,
    sessionStartedAt,
    directive,
    runNumber,
    player:state?.player ?? null,
    skills:state?.skills ?? [],
    inventory:state?.inventory?.map(i => ({id:i.id,name:i.name,count:i.count,slot:i.slot})) ?? [],
    equipment:state?.equipment?.map(i => ({id:i.id,name:i.name,count:i.count,slot:i.slot})) ?? [],
    nearbyNpcs:s?.nearbyNpcs?.map((n:any) => ({
      id:n.id,index:n.index,name:n.name,combatLevel:n.combatLevel,x:n.x,z:n.z,hp:n.hp,maxHp:n.maxHp,
      healthPercent:n.healthPercent,inCombat:n.inCombat,targetIndex:n.targetIndex,animId:n.animId,spotanimId:n.spotanimId,
      lastCombatTick:n.lastCombatTick,distance:n.distance,reachable:n.reachable,options:n.options
    })) ?? [],
    nearbyPlayers:s?.nearbyPlayers?.map((p:any) => ({
      index:p.index,name:p.name,combatLevel:p.combatLevel,x:p.x,z:p.z,distance:p.distance,reachable:p.reachable
    })) ?? [],
    groundItems:s?.groundItems?.map((g:any) => ({
      id:g.id,name:g.name,count:g.count,x:g.x,z:g.z,distance:g.distance,reachable:g.reachable
    })) ?? [],
    nearbyLocs:s?.nearbyLocs?.slice?.(0,180)?.map((l:any) => ({
      id:l.id,name:l.name,x:l.x,z:l.z,level:l.level,distance:l.distance,reachable:l.reachable,options:l.options
    })) ?? [],
    combatStyle:s?.combatStyle ?? null,
    combatEvents:s?.combatEvents?.slice?.(-100)?.map((e:any) => ({
      tick:e.tick,observationId:e.observationId,type:e.type,damage:e.damage,sourceType:e.sourceType,sourceIndex:e.sourceIndex,
      targetType:e.targetType,targetIndex:e.targetIndex
    })) ?? [],
    gameMessages:s?.gameMessages?.slice?.(-50)?.map((m:any) => ({
      type:m.type,text:m.text,sender:m.sender,tick:m.tick,observationId:m.observationId,fromSelf:m.fromSelf
    })) ?? [],
    recentDialogs:s?.recentDialogs?.slice?.(-20)?.map((d:any) => ({
      text:d.text,tick:d.tick,observationId:d.observationId,interfaceId:d.interfaceId
    })) ?? [],
    prayers:s?.prayers ?? null,
    worldUi:{
      shopOpen:!!s?.shop?.isOpen,
      bankOpen:!!s?.bank?.isOpen,
      tradeOpen:!!s?.trade?.isOpen,
      tradePartner:s?.trade?.partner ?? null,
      dialogOpen:!!s?.dialog?.isOpen,
      modalOpen:!!s?.modalOpen
    },
    currentAction,
    currentGoal,
    currentWhy,
    actions:actionHistory,
    actionCount:actions,
    movementTrail,
    lessons:(agent.recentMemories || []).map((m:any) => m.text),
    agent
  };
};

const server = Bun.serve({
  port:8787,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const headers = {'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'};
    if (path === '/state') return Response.json(snapshot,{headers});
    if (path === '/health') return Response.json({
      ok:true,online:snapshot.online,inGame:snapshot.inGame,tick,actionCount:actions,sessionStartedAt,runNumber,
      agentController:snapshot.agent?.currentController,teacherOnline:snapshot.agent?.teacherOnline,
      learnedActions:snapshot.agent?.learnedActions ?? 0,memoryCount:snapshot.agent?.memoryCount ?? 0
    },{headers});
    return new Response(viewerHtml,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
  }
});
await log('VIEWER_LOCAL',{url:`http://127.0.0.1:${server.port}`});

const session = await startSession({host:'rs-sdk-demo.fly.dev',username,password,quiet:false,profanityFilter:true});
const client = session.client;
const asClient = client as unknown as Client;
const collector = new BotStateCollector(asClient);
const executor = new ActionExecutor(asClient);
executor.setScanProvider(collector);

const slug = (s:string) => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,28) || 'x';
const norm = (s:string) => s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

const buildCandidates = (state:BotWorldState):AgentCandidate[] => {
  const p = state.player!;
  const out:AgentCandidate[] = [];
  let seq = 0;
  const add = (c:Omit<AgentCandidate,'id'>) => {
    if (out.length >= 48) return;
    out.push({...c,id:`a${seq++}_${slug(c.category)}`});
  };

  add({
    label:'Wait and observe for a moment',category:'wait',fingerprint:'wait',settleTicks:3,
    action:{type:'wait',reason:'Wait to observe how the world changes.'},tags:['observe','patience']
  });

  if (state.dialog?.isOpen) {
    for (const o of state.dialog.options?.slice(0,8) || []) add({
      label:`Choose dialog option ${o.index}: ${o.text || '(continue)'}`,
      category:'dialog',fingerprint:`dialog:${o.index}:${norm(o.text || 'continue')}`,settleTicks:4,
      action:{type:'clickDialogOption',optionIndex:o.index,reason:'Choose a dialog response.'},tags:['conversation','dialog']
    });
    return out;
  }

  if (state.shop?.isOpen) {
    for (const item of (state.shop.shopItems || []).slice(0,10)) add({
      label:`Buy 1 ${item.name} for about ${item.buyPrice}`,
      category:'shop',fingerprint:`shop:buy:${norm(item.name)}`,settleTicks:5,
      action:{type:'shopBuy',slot:item.slot,amount:1,reason:'Buy an item from the open shop.'},tags:['economy','buy',item.name]
    });
    for (const item of (state.shop.playerItems || []).slice(0,8)) add({
      label:`Sell 1 ${item.name} for about ${item.sellPrice}`,
      category:'shop',fingerprint:`shop:sell:${norm(item.name)}`,settleTicks:5,
      action:{type:'shopSell',slot:item.slot,amount:1,reason:'Sell an item to the open shop.'},tags:['economy','sell',item.name]
    });
    add({label:'Close the shop',category:'modal',fingerprint:'modal:close-shop',settleTicks:3,action:{type:'closeShop',reason:'Close the shop.'},tags:['shop']});
  }

  if (state.bank?.isOpen) {
    for (const item of (state.inventory || []).slice(0,10)) add({
      label:`Deposit all ${item.name} into bank`,category:'bank',fingerprint:`bank:deposit:${norm(item.name)}`,settleTicks:5,
      action:{type:'bankDeposit',slot:item.slot,amount:item.count || 1,reason:'Deposit an inventory item.'},tags:['bank','store',item.name]
    });
    for (const item of (state.bank.items || []).slice(0,10)) add({
      label:`Withdraw 1 ${item.name} from bank`,category:'bank',fingerprint:`bank:withdraw:${norm(item.name)}`,settleTicks:5,
      action:{type:'bankWithdraw',slot:item.slot,amount:1,reason:'Withdraw an item from the bank.'},tags:['bank','retrieve',item.name]
    });
    add({label:'Close the bank',category:'modal',fingerprint:'modal:close-bank',settleTicks:3,action:{type:'closeModal',reason:'Close the bank interface.'},tags:['bank']});
  }

  if (state.interface?.isOpen && !state.shop?.isOpen && !state.bank?.isOpen) add({
    label:'Close the blocking interface',category:'modal',fingerprint:'modal:close-interface',settleTicks:3,
    action:{type:'closeModal',reason:'Close the current blocking interface.'},tags:['interface']
  });

  for (const npc of (state.nearbyNpcs || []).filter(n => n.reachable !== false).sort((a,b)=>a.distance-b.distance).slice(0,12)) {
    for (const o of (npc.optionsWithIndex || []).slice(0,4)) {
      const text = o.text || `option ${o.opIndex}`;
      const lower = text.toLowerCase();
      const category = /attack/.test(lower) ? 'combat' : /pickpocket|steal/.test(lower) ? 'economy' : /talk/.test(lower) ? 'social' : 'npc';
      add({
        label:`${text} ${npc.name} (level ${npc.combatLevel || 0}, distance ${npc.distance})`,
        category,
        fingerprint:`npc:${norm(text)}:${norm(npc.name)}`,
        settleTicks:category==='combat'?12:category==='economy'?8:6,
        action:{type:'interactNpc',npcIndex:npc.index,optionIndex:o.opIndex,reason:`Interact with ${npc.name}.`},
        tags:[npc.name,text,category,`level-${npc.combatLevel || 0}`]
      });
    }
  }

  for (const g of (state.groundItems || []).filter(g => g.reachable !== false).sort((a,b)=>a.distance-b.distance).slice(0,10)) add({
    label:`Pick up ${g.count > 1 ? g.count+' ' : ''}${g.name} (distance ${g.distance})`,
    category:'pickup',fingerprint:`pickup:${norm(g.name)}`,settleTicks:5,
    action:{type:'pickupItem',x:g.x,z:g.z,itemId:g.id,reason:`Pick up ${g.name}.`},tags:['item','resource',g.name]
  });

  for (const loc of (state.nearbyLocs || []).filter(l => l.reachable !== false).sort((a,b)=>a.distance-b.distance).slice(0,14)) {
    for (const o of (loc.optionsWithIndex || []).slice(0,3)) add({
      label:`${o.text} ${loc.name} (distance ${loc.distance})`,
      category:'world',fingerprint:`loc:${norm(o.text)}:${norm(loc.name)}`,settleTicks:6,
      action:{type:'interactLoc',x:loc.x,z:loc.z,locId:loc.id,optionIndex:o.opIndex,reason:`Interact with ${loc.name}.`},
      tags:['world',loc.name,o.text]
    });
  }

  for (const item of (state.inventory || []).slice(0,16)) {
    for (const o of (item.optionsWithIndex || []).slice(0,4)) add({
      label:`${o.text} ${item.name}${item.count>1?` x${item.count}`:''}`,
      category:/eat|drink/i.test(o.text)?'recovery':'inventory',fingerprint:`inventory:${norm(o.text)}:${norm(item.name)}`,settleTicks:4,
      action:{type:'useInventoryItem',slot:item.slot,optionIndex:o.opIndex,reason:`Use ${item.name}: ${o.text}.`},
      tags:['inventory',item.name,o.text]
    });
  }

  for (const item of (state.equipment || []).slice(0,12)) {
    for (const o of (item.optionsWithIndex || []).slice(0,3)) add({
      label:`Equipment: ${o.text} ${item.name}`,category:'equipment',fingerprint:`equipment:${norm(o.text)}:${norm(item.name)}`,settleTicks:4,
      action:{type:'useEquipmentItem',slot:item.slot,optionIndex:o.opIndex,reason:`Use equipped ${item.name}: ${o.text}.`},tags:['equipment',item.name,o.text]
    });
  }

  for (const style of state.combatStyle?.styles || []) add({
    label:`Combat style ${style.name}: ${style.type}; trains ${(style.trainsSkills || []).join(', ') || 'unknown'}`,
    category:'combat-style',fingerprint:`style:${norm(style.type)}:${(style.trainsSkills || []).join('+').toLowerCase()}`,settleTicks:3,
    action:{type:'setCombatStyle',style:style.index,reason:`Select ${style.name} combat style.`},tags:['combat-style',style.type,...(style.trainsSkills || [])]
  });

  const walks = [
    ['north',0,5],['south',0,-5],['east',5,0],['west',-5,0],
    ['northeast',4,4],['northwest',-4,4],['southeast',4,-4],['southwest',-4,-4]
  ] as const;
  for (const [name,dx,dz] of walks) add({
    label:`Explore ${name} about ${Math.max(Math.abs(dx),Math.abs(dz))} tiles`,category:'explore',fingerprint:`walk:${name}`,settleTicks:6,
    action:{type:'walkTo',x:p.worldX+dx,z:p.worldZ+dz,running:true,reason:`Explore ${name}.`},tags:['explore',name]
  });

  if ((state.nearbyPlayers?.length || 0) > 0) add({
    label:`Say something to nearby agent(s): ${state.nearbyPlayers.slice(0,4).map(x=>x.name).join(', ')}`,
    category:'say',fingerprint:'social:say',settleTicks:5,
    action:{type:'say',message:'Hello.',reason:'Communicate with nearby agents.'},tags:['social','agent','communication']
  });

  return out;
};

const execute = (candidate:AgentCandidate, choice:AgentChoice, state:BotWorldState) => {
  const action = {...candidate.action,reason:choice.reason};
  if (action.type === 'say') action.message = choice.speech?.trim() || 'Hello.';
  const result = executor.execute(action);
  actions++;
  currentGoal = choice.goal;
  currentWhy = choice.reason;
  feed(choice.source === 'teacher' ? 'AGENT_TEACHER' : 'AGENT_STUDENT',candidate.label,choice.reason,{source:choice.source,target:candidate.label});
  brain.beginExperience(choice,candidate,state,tick);
  void log('AGENT_ACTION',{
    tick,source:choice.source,goal:choice.goal,reason:choice.reason,expected:choice.expectedOutcome,
    confidence:choice.confidence,action:candidate.label,fingerprint:candidate.fingerprint,
    result:result instanceof Promise?'async':result
  });
};

const reflex = (state:BotWorldState) => {
  const p = state.player!;
  if (p.hp <= 0) return false;
  const threshold = Math.max(3,Math.floor(p.maxHp*(p.combat.inCombat?.45:.32)));
  if (p.hp > threshold) return false;
  const food = state.inventory.find(i => i.optionsWithIndex?.some(o => /^eat$/i.test(o.text)));
  const eat = food?.optionsWithIndex?.find(o => /^eat$/i.test(o.text));
  if (food && eat) {
    executor.execute({type:'useInventoryItem',slot:food.slot,optionIndex:eat.opIndex,reason:'Emergency reflex: health crossed the imminent-danger threshold.'});
    actions++; lastReflexTick=tick; brain.noteReflex();
    currentGoal='Survive immediate danger'; currentWhy='Emergency reflex temporarily overrides deliberation because HP is critically low.';
    feed('REFLEX_EAT',`Eat ${food.name}`,currentWhy,{source:'reflex',item:food.name});
    void log('REFLEX_EAT',{tick,hp:[p.hp,p.maxHp],item:food.name});
    return true;
  }
  if (p.combat.inCombat) {
    executor.execute({type:'walkTo',x:p.worldX+8,z:p.worldZ+8,running:true,reason:'Emergency reflex: critically low HP with no food; create distance.'});
    actions++; lastReflexTick=tick; brain.noteReflex();
    currentGoal='Escape immediate danger'; currentWhy='Emergency reflex temporarily overrides deliberation because critical HP and no food are available.';
    feed('REFLEX_RETREAT','Run away from combat',currentWhy,{source:'reflex'});
    void log('REFLEX_RETREAT',{tick,hp:[p.hp,p.maxHp]});
    return true;
  }
  return false;
};

const launchDecision = (stateAtStart:BotWorldState) => {
  if (decisionInFlight) return;
  const candidates = buildCandidates(stateAtStart);
  if (!candidates.length) return;
  const startedTick = tick;
  const startedLife = stateAtStart.player?.lifeId;
  decisionInFlight = true;
  currentGoal='Deliberating';
  currentWhy='Sol is comparing the current world, memories, learned policy, and available actions.';
  refreshSnapshot(stateAtStart);
  void log('AGENT_THINK',{tick:startedTick,candidates:candidates.length,agent:brain.publicState()});
  brain.decide(stateAtStart,candidates).then(choice => {
    decisionInFlight=false;
    const latest = lastState;
    if (!latest?.player) { nextDecisionTick=tick+2; return; }
    if (latest.player.lifeId !== startedLife || lastReflexTick > startedTick) {
      void log('AGENT_DECISION_STALE',{startedTick,resolvedTick:tick,reason:'life changed or emergency reflex intervened'});
      nextDecisionTick=tick+1;
      return;
    }
    const fresh = buildCandidates(latest).find(c => c.fingerprint === choice.fingerprint);
    const original = candidates.find(c => c.id === choice.actionId);
    const candidate = fresh || original;
    if (!candidate) {
      void log('AGENT_DECISION_STALE',{startedTick,resolvedTick:tick,fingerprint:choice.fingerprint,reason:'action no longer available'});
      nextDecisionTick=tick+1;
      return;
    }
    execute(candidate,choice,latest);
    nextDecisionTick=tick+2;
    refreshSnapshot(latest);
  }).catch(err => {
    decisionInFlight=false;
    currentGoal='Recover reasoning loop';
    currentWhy=`Agent decision failed: ${String(err).slice(0,180)}`;
    void log('AGENT_DECISION_ERROR',String(err));
    nextDecisionTick=tick+3;
  });
};

await log('SOL_AWAKE',{username,directive,architecture:'local teacher + learned student policy',teacherModel:brain.model,runNumber});

client.setOnGameTickCallback(() => {
  tick++;
  try {
    const state = collector.collectState(tick,true) as BotWorldState | null;
    if (!state?.player) {
      currentGoal='Reconnect to world state';
      currentWhy='No player state is currently available; hold decisions until perception returns.';
      refreshSnapshot(state);
      return;
    }
    lastState=state;

    const outcome = brain.maybeFinishExperience(state,tick);
    if (outcome) {
      feed('LEARNED_OUTCOME',outcome.summary,`Measured reward ${outcome.reward} from ${outcome.choice.source} action.`,{source:'learning',reward:outcome.reward});
      void log('AGENT_OUTCOME',{tick,reward:outcome.reward,summary:outcome.summary,source:outcome.choice.source,action:outcome.candidateLabel});
      nextDecisionTick=Math.max(nextDecisionTick,tick+1);
    }

    if (tick<=3 || tick%100===0) void log('OBSERVE',{
      tick,pos:[state.player.worldX,state.player.worldZ,state.player.level],hp:[state.player.hp,state.player.maxHp],combatLevel:state.player.combatLevel,
      skills:Object.fromEntries(state.skills.map(s=>[s.name,s.level])),inventory:state.inventory.map(i=>i.name),
      nearbyAgents:state.nearbyPlayers.map(p=>p.name),agent:brain.publicState()
    });

    if (reflex(state)) {
      nextDecisionTick=tick+4;
      refreshSnapshot(state);
      return;
    }

    if (!decisionInFlight && tick>=nextDecisionTick && !brain.publicState().lastChoice?.actionId === false) {
      // Deliberation begins only when no previous action is still awaiting an outcome.
      if (!brain.publicState().lastChoice || brain.publicState().lastOutcome || actions===0) launchDecision(state);
    }

    // If the prior choice has completed, maybeFinishExperience cleared it internally; use a simple cadence guard.
    if (!decisionInFlight && tick>=nextDecisionTick && outcome) launchDecision(state);
    if (!decisionInFlight && tick>=nextDecisionTick && actions===0) launchDecision(state);

    refreshSnapshot(state);
  } catch(err) {
    void log('TICK_ERROR',String(err));
  }
});

await Bun.sleep(RUN_MS);
client.setOnGameTickCallback(null);
refreshSnapshot(lastState);
await brain.save(true);
await log('SOL_HANDOFF',{
  ticks:tick,actions,agent:brain.publicState(),
  final:lastState?{
    player:lastState.player,
    skills:Object.fromEntries(lastState.skills.map(s=>[s.name,s.level])),
    inventory:lastState.inventory.map(i=>({name:i.name,count:i.count}))
  }:null
});
session.stop();
await session.stopped;
server.stop(true);
