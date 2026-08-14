import { startSession } from './src/lite/session.js';
import { BotStateCollector } from './src/bot/StateCollector.js';
import { ActionExecutor } from './src/bot/ActionExecutor.js';
import type { Client } from './src/client/Client.js';
import type { BotWorldState } from './src/bot/types.js';
import { appendFile } from 'fs/promises';

const username = process.env.SOL_USER!;
const password = process.env.SOL_PASS!;
const RUN_MS = 21_300_000;
const viewerHtml = await Bun.file('./viewer.html').text();
const sessionStartedAt = new Date().toISOString();
const directive = 'remain alive, learn continuously, avoid loops, expand capabilities indefinitely';

type FeedEvent = {
  tick: number;
  label: string;
  summary: string;
  reason: string;
  target?: string;
  item?: string;
  skill?: string;
  at: string;
};
type TrailPoint = { x: number; z: number; level: number; tick: number };

let tick = 0;
let actions = 0;
let nextActionTick = 0;
let lastState: BotWorldState | null = null;
let lastStyle = -1;
let preferredWeaponChosen = false;
let shieldAttempted = false;
let currentAction: FeedEvent | null = null;
let currentGoal = 'Orient to the world';
let currentWhy = 'Observe surroundings and choose the next useful action.';
const actionHistory: FeedEvent[] = [];
const movementTrail: TrailPoint[] = [];
const talked = new Set<string>();
const lessons = new Set<string>();

const summarize = (data: any = {}) => {
  if (data.target) return `→ ${data.target}`;
  if (data.item) return `→ ${data.item}`;
  if (data.npc) return `→ ${data.npc}`;
  if (data.desiredSkill) return `→ ${data.desiredSkill}`;
  return '';
};
const feed = (label: string, data: any = {}, reason = '') => {
  const e: FeedEvent = {
    tick,
    label,
    summary: summarize(data),
    reason: reason || data.reason || '',
    target: data.target || data.npc,
    item: data.item,
    skill: data.desiredSkill,
    at: new Date().toISOString()
  };
  currentAction = e;
  actionHistory.push(e);
  if (actionHistory.length > 160) actionHistory.shift();
};
const log = async (event: string, data?: unknown) => {
  const line = `[${new Date().toISOString()}] ${event}${data === undefined ? '' : ' ' + JSON.stringify(data)}\n`;
  process.stdout.write(line);
  await appendFile('../../sol-session.log', line).catch(() => {});
};

let snapshot: any = {
  updatedAt: new Date().toISOString(), online: false, inGame: false, tick: 0, revision: 0,
  sessionStartedAt, directive, runNumber: null,
  player: null, skills: [], inventory: [], equipment: [], nearbyNpcs: [], nearbyPlayers: [], groundItems: [], nearbyLocs: [],
  combatStyle: null, combatEvents: [], gameMessages: [], recentDialogs: [], prayers: null,
  worldUi: { shopOpen:false, bankOpen:false, tradeOpen:false, dialogOpen:false, modalOpen:false },
  currentAction: null, currentGoal, currentWhy, actions: [], actionCount: 0, movementTrail: [], lessons: []
};

const refreshSnapshot = (state: BotWorldState | null) => {
  const s: any = state;
  if (state?.player && (tick % 2 === 0 || movementTrail.length === 0)) {
    const last = movementTrail[movementTrail.length - 1];
    const next = { x: state.player.worldX, z: state.player.worldZ, level: state.player.level, tick };
    if (!last || last.x !== next.x || last.z !== next.z || last.level !== next.level) {
      movementTrail.push(next);
      if (movementTrail.length > 320) movementTrail.shift();
    }
  }

  snapshot = {
    updatedAt: new Date().toISOString(),
    online: !!state?.player,
    inGame: !!s?.inGame,
    tick,
    revision: s?.revision ?? 0,
    sessionStartedAt,
    directive,
    runNumber: Number(process.env.GITHUB_RUN_NUMBER || 0) || null,
    player: state?.player ?? null,
    skills: state?.skills ?? [],
    inventory: state?.inventory?.map(i => ({ id:i.id, name:i.name, count:i.count, slot:i.slot })) ?? [],
    equipment: state?.equipment?.map(i => ({ id:i.id, name:i.name, count:i.count, slot:i.slot })) ?? [],
    nearbyNpcs: s?.nearbyNpcs?.map((n: any) => ({
      id:n.id, index:n.index, name:n.name, combatLevel:n.combatLevel, x:n.x, z:n.z,
      hp:n.hp, maxHp:n.maxHp, healthPercent:n.healthPercent, inCombat:n.inCombat,
      targetIndex:n.targetIndex, animId:n.animId, spotanimId:n.spotanimId,
      lastCombatTick:n.lastCombatTick, distance:n.distance, reachable:n.reachable, options:n.options
    })) ?? [],
    nearbyPlayers: s?.nearbyPlayers?.map((p: any) => ({
      index:p.index, name:p.name, combatLevel:p.combatLevel, x:p.x, z:p.z,
      distance:p.distance, reachable:p.reachable
    })) ?? [],
    groundItems: s?.groundItems?.map((g: any) => ({
      id:g.id, name:g.name, count:g.count, x:g.x, z:g.z, distance:g.distance, reachable:g.reachable
    })) ?? [],
    nearbyLocs: s?.nearbyLocs?.slice?.(0, 160)?.map((l: any) => ({
      id:l.id, name:l.name, x:l.x, z:l.z, level:l.level, distance:l.distance,
      reachable:l.reachable, options:l.options
    })) ?? [],
    combatStyle: s?.combatStyle ?? null,
    combatEvents: s?.combatEvents?.slice?.(-80)?.map((e:any) => ({
      tick:e.tick, observationId:e.observationId, type:e.type, damage:e.damage,
      sourceType:e.sourceType, sourceIndex:e.sourceIndex, targetType:e.targetType, targetIndex:e.targetIndex
    })) ?? [],
    gameMessages: s?.gameMessages?.slice?.(-40)?.map((m:any) => ({
      type:m.type, text:m.text, sender:m.sender, tick:m.tick, observationId:m.observationId, fromSelf:m.fromSelf
    })) ?? [],
    recentDialogs: s?.recentDialogs?.slice?.(-16)?.map((d:any) => ({
      text:d.text, tick:d.tick, observationId:d.observationId, interfaceId:d.interfaceId
    })) ?? [],
    prayers: s?.prayers ?? null,
    worldUi: {
      shopOpen: !!s?.shop?.isOpen,
      bankOpen: !!s?.bank?.isOpen,
      tradeOpen: !!s?.trade?.isOpen,
      tradePartner: s?.trade?.partner ?? null,
      dialogOpen: !!s?.dialog?.isOpen,
      modalOpen: !!s?.modalOpen
    },
    currentAction,
    currentGoal,
    currentWhy,
    actions: actionHistory,
    actionCount: actions,
    movementTrail,
    lessons: [...lessons]
  };
};

const server = Bun.serve({
  port: 8787,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    if (path === '/state') return Response.json(snapshot, { headers });
    if (path === '/health') return Response.json({
      ok: true, online: snapshot.online, inGame: snapshot.inGame, tick,
      actionCount: actions, sessionStartedAt, runNumber:snapshot.runNumber
    }, { headers });
    return new Response(viewerHtml, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
  }
});
await log('VIEWER_LOCAL', { url: `http://127.0.0.1:${server.port}` });

const session = await startSession({ host: 'rs-sdk-demo.fly.dev', username, password, quiet: false, profanityFilter: true });
const client = session.client;
const asClient = client as unknown as Client;
const collector = new BotStateCollector(asClient);
const executor = new ActionExecutor(asClient);
executor.setScanProvider(collector);

const level = (s: BotWorldState, name: string) => s.skills.find(x => x.name.toLowerCase() === name.toLowerCase())?.level ?? 1;
const act = (action: any, label: string, data: any = {}) => {
  const result = executor.execute(action);
  actions++;
  currentWhy = action.reason || data.reason || currentWhy;
  feed(label, data, currentWhy);
  void log(label, { tick, ...data, reason: currentWhy, result: result instanceof Promise ? 'async' : result });
  return result;
};

await log('SOL_AWAKE', { username, directive });

client.setOnGameTickCallback(() => {
  tick++;
  try {
    const state = collector.collectState(tick, true) as BotWorldState | null;
    if (!state?.player) { currentGoal = 'Reconnect to world state'; refreshSnapshot(state); return; }
    lastState = state;

    const atk=level(state,'Attack'),str=level(state,'Strength'),def=level(state,'Defence'),thv=level(state,'Thieving');
    const weakest=[{name:'Attack',level:atk},{name:'Strength',level:str},{name:'Defence',level:def}].sort((a,b)=>a.level-b.level)[0];
    const meleeFloor=Math.min(atk,str,def);
    const shouldThieve=thv+4<meleeFloor&&state.player.hp>Math.max(6,Math.floor(state.player.maxHp*.7));
    currentGoal = state.player.hp <= Math.max(4, Math.floor(state.player.maxHp * 0.55))
      ? 'Survive and recover'
      : shouldThieve ? 'Build economy through Thieving' : `Train ${weakest.name}`;
    refreshSnapshot(state);

    if (tick <= 3 || tick % 100 === 0) void log('OBSERVE', {
      tick, pos:[state.player.worldX,state.player.worldZ,state.player.level], hp:[state.player.hp,state.player.maxHp],
      combatLevel:state.player.combatLevel, skills:Object.fromEntries(state.skills.map(s=>[s.name,s.level])),
      inventory:state.inventory.map(i=>i.name), nearby:state.nearbyNpcs.slice(0,10).map(n=>({name:n.name,level:n.combatLevel,distance:n.distance}))
    });

    if (state.dialog?.isOpen) {
      const option = state.dialog.options?.[0]?.index ?? 1;
      act({ type:'clickDialogOption', optionIndex:option, reason:'Advance the open conversation to learn what it offers.' }, 'DIALOG');
      nextActionTick = tick + 2; return;
    }
    if (state.interface?.isOpen) {
      act({ type:'closeModal', reason:'Clear a blocking interface so autonomous play can continue.' }, 'CLEAR_MODAL');
      nextActionTick = tick + 2; return;
    }
    if (tick < nextActionTick) return;

    if (state.player.hp > 0 && state.player.hp <= Math.max(4, Math.floor(state.player.maxHp * 0.55))) {
      const food = state.inventory.find(i => i.optionsWithIndex.some(o => /^eat$/i.test(o.text)));
      const eat = food?.optionsWithIndex.find(o => /^eat$/i.test(o.text));
      if (food && eat) {
        act({ type:'useInventoryItem', slot:food.slot, optionIndex:eat.opIndex, reason:'Health is below the safety threshold; heal before taking more risk.' }, 'SURVIVE_EAT', { item:food.name });
        lessons.add('Heal before continuing when health becomes unsafe.'); nextActionTick=tick+3; return;
      }
      if (state.player.combat.inCombat) {
        act({ type:'walkTo', x:state.player.worldX+7, z:state.player.worldZ+7, running:true, reason:'Health is unsafe and no food is available; create distance from combat.' }, 'SURVIVE_RETREAT');
        nextActionTick=tick+5; return;
      }
    }

    if (!preferredWeaponChosen) {
      const weapon = state.inventory.find(i=>/bronze sword/i.test(i.name)) ?? state.inventory.find(i=>/bronze dagger/i.test(i.name));
      const wield = weapon?.optionsWithIndex.find(o=>/^wield$/i.test(o.text)); preferredWeaponChosen=true;
      if (weapon && wield) {
        act({type:'useInventoryItem',slot:weapon.slot,optionIndex:wield.opIndex,reason:'Equip a reliable starter weapon once before training.'},'EQUIP_WEAPON',{item:weapon.name});
        nextActionTick=tick+3; return;
      }
    }
    if (!shieldAttempted) {
      const shield=state.inventory.find(i=>/shield/i.test(i.name)); const wield=shield?.optionsWithIndex.find(o=>/^(wield|wear)$/i.test(o.text)); shieldAttempted=true;
      if(shield&&wield){
        act({type:'useInventoryItem',slot:shield.slot,optionIndex:wield.opIndex,reason:'Equip available defensive gear to reduce unnecessary risk.'},'EQUIP_SHIELD',{item:shield.name});
        nextActionTick=tick+3;return;
      }
    }

    const drop=state.groundItems.filter(g=>g.reachable!==false&&g.distance<=8).find(g=>/coins|bones|rune|arrow|food|meat|sword|axe|shield/i.test(g.name));
    if(drop){
      act({type:'pickupItem',x:drop.x,z:drop.z,itemId:drop.id,reason:'A useful reachable resource is nearby; collect it before it disappears.'},'PICKUP',{item:drop.name});
      nextActionTick=tick+4;return;
    }
    const bones=state.inventory.find(i=>/bones/i.test(i.name)&&i.optionsWithIndex.some(o=>/bury/i.test(o.text)));
    const bury=bones?.optionsWithIndex.find(o=>/bury/i.test(o.text));
    if(bones&&bury&&!state.player.combat.inCombat){
      act({type:'useInventoryItem',slot:bones.slot,optionIndex:bury.opIndex,reason:'Convert carried bones into Prayer progress while out of combat.'},'BURY',{item:bones.name});
      nextActionTick=tick+3;return;
    }

    const desiredSkill=shouldThieve?null:weakest.name;
    const combatStyle=(state as any).combatStyle;
    if(desiredSkill&&combatStyle?.styles?.length){
      const style=combatStyle.styles.find((s:any)=>s.trainsSkills?.includes(desiredSkill));
      if(style&&style.index!==lastStyle){
        act({type:'setCombatStyle',style:style.index,reason:`Switch combat style so the weakest melee skill, ${desiredSkill}, catches up.`},'COMBAT_STYLE',{desiredSkill});
        lastStyle=style.index;nextActionTick=tick+2;return;
      }
    }
    if(state.player.combat.inCombat){currentWhy='Already engaged in combat; wait for the exchange to resolve.';nextActionTick=tick+2;refreshSnapshot(state);return;}

    if(shouldThieve){
      const mark=state.nearbyNpcs.filter(n=>n.reachable!==false&&/^(man|woman)$/i.test(n.name)).find(n=>n.optionsWithIndex.some(o=>/pickpocket/i.test(o.text)));
      const op=mark?.optionsWithIndex.find(o=>/pickpocket/i.test(o.text));
      if(mark&&op){
        act({type:'interactNpc',npcIndex:mark.index,optionIndex:op.opIndex,reason:'Thieving is lagging behind melee progression; build skill and coin income.'},'THIEVE',{target:mark.name});
        nextActionTick=tick+8;return;
      }
    }

    const attackable=state.nearbyNpcs
      .filter(n=>n.reachable!==false&&n.combatLevel>0&&n.combatLevel<=Math.max(2,state.player.combatLevel+2)&&n.optionsWithIndex.some(o=>/attack/i.test(o.text))&&!/^(man|woman)$/i.test(n.name))
      .sort((a,b)=>{const goal=Math.max(1,state.player.combatLevel-2);return (Math.abs(a.combatLevel-goal)*10+a.distance)-(Math.abs(b.combatLevel-goal)*10+b.distance)});
    const target=attackable[0];
    const op=target?.optionsWithIndex.find(o=>/attack/i.test(o.text));
    if(target&&op&&state.player.hp>Math.max(4,Math.floor(state.player.maxHp*.6))){
      act({type:'interactNpc',npcIndex:target.index,optionIndex:op.opIndex,reason:`Train ${weakest.name} against a controlled nearby opponent without exceeding the risk ceiling.`},'COMBAT',{target:target.name,desiredSkill:weakest.name});
      nextActionTick=tick+7;return;
    }

    const interesting=state.nearbyNpcs
      .filter(n=>n.reachable!==false&&!talked.has(n.name))
      .find(n=>!/^(man|woman|rat|chicken|goblin|butterfly|imp|duck)$/i.test(n.name)&&n.optionsWithIndex.some(o=>/talk-to/i.test(o.text)));
    if(interesting){
      const op=interesting.optionsWithIndex.find(o=>/talk-to/i.test(o.text))!;
      talked.add(interesting.name);
      act({type:'interactNpc',npcIndex:interesting.index,optionIndex:op.opIndex,reason:'No immediate training target is better; inspect an unfamiliar named NPC for services, quests, or knowledge.'},'DISCOVER_NPC',{npc:interesting.name});
      nextActionTick=tick+6;return;
    }

    currentGoal = 'Explore for new opportunities';
    currentWhy = 'No better nearby combat, economy, resource, or discovery action is available.';
    if(tick%10===0){
      const offsets=[[3,0],[0,3],[-3,0],[0,-3],[2,2],[-2,2],[-2,-2],[2,-2]];
      const [dx,dz]=offsets[Math.floor(tick/10)%offsets.length];
      act({type:'walkTo',x:state.player.worldX+dx,z:state.player.worldZ+dz,running:true,reason:'Probe a nearby route to expose new NPCs, objects, resources, or paths.'},'EXPLORE');
      nextActionTick=tick+5;
    }
  } catch(err){void log('TICK_ERROR',String(err));}
});

await Bun.sleep(RUN_MS);
client.setOnGameTickCallback(null);
refreshSnapshot(lastState);
await log('SOL_HANDOFF',{
  ticks:tick,actions,lessons:[...lessons],
  final:lastState?{player:lastState.player,skills:Object.fromEntries(lastState.skills.map(s=>[s.name,s.level])),inventory:lastState.inventory.map(i=>({name:i.name,count:i.count}))}:null
});
session.stop();
await session.stopped;
server.stop(true);
