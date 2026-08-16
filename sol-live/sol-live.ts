import { startSession } from './src/lite/session.js';
import type { BotWorldState } from './src/bot/types.js';
import { appendFile } from 'fs/promises';
import { SolAgentBrain, type AgentCandidate, type AgentChoice, type SolRuntimeConfig } from './agent-brain.js';
import { ControllerRegistry, PersistentBodyState, createFallbackController } from './controller-runtime.js';
import { PersistentStateStore, type PersistentState } from './persistent-state.js';
import { ObligationExecutor } from './obligation-executor.js';
import { ProgressionDirector } from './progression-director.js';

const username = process.env.SOL_USER!;
const password = process.env.SOL_PASS!;
const RUN_MS = 19_800_000; // 5h30m, leaving ~30m for setup/persistence/artifacts/handoff.
const viewerHtml = await Bun.file('./viewer.html').text();
const sessionStartedAt = new Date().toISOString();
const viewerAccessToken = process.env.SOL_VIEWER_TOKEN?.trim() || '';
const directive = 'Understand that you are an autonomous player inside a persistent RuneScape-style MMO. Learn its mechanics from the cloned rs-sdk repository and live outcomes; pursue connected long-term progression through skills, resources, coins, equipment, exploration, combat, NPCs, and relationships with other autonomous players.';
const runNumber = Number(process.env.GITHUB_RUN_NUMBER || 0) || null;

type FeedEvent = {
  tick: number;
  label: string;
  summary: string;
  reason: string;
  target?: string;
  item?: string;
  source?: string;
  reward?:number;
  actionType?:string;
  at:string;
};
type TrailPoint = { x:number; z:number; level:number; tick:number };
type OutgoingChat = { id:string; tick:number; at:string; text:string; target:string|null; replyTo:string|null; status:'submitted' };
type ProcedureState = { skill:string; label:string; status:'running'|'completed'|'failed'; step:string; startedTick:number; finishedTick?:number; start:{x:number;z:number;level:number}; end?:{x:number;z:number;level:number}; primitiveActions:number; message?:string };
type EconomyResolution = { phase:'idle'|'capacity'|'loot'|'transaction'; noProgress:number; lastAction:string|null; lastProgressTick:number; blockedUntil:number; reason:string };


let tick = 0;
let actions = 0;
let nextDecisionTick = 0;
let lastReflexTick = -9999;
let lastState: BotWorldState | null = null;
let decisionInFlight = false;
let actionAwaitingOutcome = false;
let primitiveActions = 0;
let procedureInFlight: ProcedureState | null = null;
let lastProcedureRun: ProcedureState | null = null;
let currentAction: FeedEvent | null = null;
let currentGoal = 'Initialize persistent agent';
let currentWhy = 'Load memory, perception, learned policy, and local teacher model.';
let economyResolution:EconomyResolution={phase:'idle',noProgress:0,lastAction:null,lastProgressTick:0,blockedUntil:0,reason:'No economy obligation is active.'};
let lastDurableFingerprint='';
const actionHistory: FeedEvent[] = [];
const movementTrail: TrailPoint[] = [];
const outgoingChat: OutgoingChat[] = [];
const answeredChatIds = new Set<string>();
let lastPublicSayTick = -9999;
let lastPublicSayText = '';
let sessionEnd:any=null;
type LiveControl = {revision:number;directive:string|null;paused:boolean;command:string|null;config?:Partial<SolRuntimeConfig>;controllerId?:string;controllerVersion?:string;updatedAt:string;source:'http'|'github'|'none'};
const controlToken=process.env.SOL_CONTROL_TOKEN?.trim()||viewerAccessToken;
let controlState:LiveControl={revision:0,directive:null,paused:false,command:null,config:undefined,updatedAt:new Date(0).toISOString(),source:'none'};
let controlPollInFlight=false;
let lastControlPollAt=0;
let controlSha:string|null=null;
let teacherProbeInFlight=false;
let lastTeacherProbeTick=-9999;
let decisionLease=0;
let decisionStartedTick=-1;
let actionStartedTick=-1;
let decisionWatchdog:ReturnType<typeof setTimeout>|null=null;

const brain = new SolAgentBrain({
  name:username,
  directive,
  motorModel:process.env.SOL_MOTOR_MODEL || process.env.SOL_AGENT_MODEL || 'qwen3:1.7b',
  strategistModel:process.env.SOL_STRATEGIST_MODEL || process.env.SOL_AGENT_MODEL || 'qwen3:1.7b',
  ollamaUrl:process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  githubToken:process.env.GH_TOKEN,
  githubRepo:process.env.GITHUB_REPOSITORY,
  runNumber
});
await brain.init();
const durablePath=process.env.SOL_STATE_PATH||'./sol-state.json';
const durableRemotePath='sol-agent/body-state.json';
const githubJsonHeaders={Accept:'application/vnd.github+json',Authorization:`Bearer ${process.env.GH_TOKEN||''}`,'X-GitHub-Api-Version':'2022-11-28'};
let remoteDurableSha:string|null=null;
let lastRemoteDurableAt=0;
let remoteDurableInFlight=false;
const restoreRemoteDurableState=async()=>{
  if(!process.env.GH_TOKEN||!process.env.GITHUB_REPOSITORY)return;
  try{
    const r=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/${durableRemotePath}?ref=sol-memory&t=${Date.now()}`,{headers:githubJsonHeaders,signal:AbortSignal.timeout(5000)});
    if(r.status===404)return;
    if(!r.ok)throw new Error(`remote durable load ${r.status}`);
    const body:any=await r.json();remoteDurableSha=body.sha||null;
    const parsed=JSON.parse(Buffer.from(String(body.content||'').replace(/\\n/g,''),'base64').toString('utf8'));
    if(parsed?.schemaVersion===1&&parsed?.identity?.name===username)await Bun.write(durablePath,JSON.stringify(parsed,null,2)+'\\n');
  }catch(err){console.warn('REMOTE_DURABLE_LOAD_FAILED',String(err).slice(0,180));}
};
const persistRemoteDurableState=async(state:PersistentState)=>{
  if(!process.env.GH_TOKEN||!process.env.GITHUB_REPOSITORY||remoteDurableInFlight||Date.now()-lastRemoteDurableAt<15000)return;
  remoteDurableInFlight=true;lastRemoteDurableAt=Date.now();
  try{
    const get=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/${durableRemotePath}?ref=sol-memory&t=${Date.now()}`,{headers:githubJsonHeaders,signal:AbortSignal.timeout(5000)});
    if(get.ok){const existing:any=await get.json();remoteDurableSha=existing.sha||remoteDurableSha;}
    const payload:any={message:`Persist Sol body ledger generation ${state.stateGeneration}`,content:Buffer.from(JSON.stringify(state,null,2)+'\\n').toString('base64'),branch:'sol-memory'};
    if(remoteDurableSha)payload.sha=remoteDurableSha;
    const put=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/${durableRemotePath}`,{method:'PUT',headers:{...githubJsonHeaders,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(7000)});
    if(put.status===409||put.status===422){remoteDurableSha=null;return;}
    if(!put.ok)throw new Error(`remote durable save ${put.status}`);
    const saved:any=await put.json();remoteDurableSha=saved?.content?.sha||remoteDurableSha;
  }catch(err){console.warn('REMOTE_DURABLE_SAVE_FAILED',String(err).slice(0,180));}
  finally{remoteDurableInFlight=false;}
};
await restoreRemoteDurableState();
const durableStateStore=await PersistentStateStore.open(durablePath,username);
let durableState:PersistentState=durableStateStore.snapshot();
const persistentBody=new PersistentBodyState(username,'llm-brain@1.0.0');
const controllerRegistry=new ControllerRegistry(createFallbackController());
const obligationExecutor=new ObligationExecutor();
const progressionDirector=new ProgressionDirector();
let currentProgression:any={id:'boot',objective:'Initialize progression curriculum',reason:'Await first verified observation.',success:'First milestone selected.',priorityFingerprints:[],stage:0,blocked:false};
controllerRegistry.register({id:'llm-brain',version:'1.0.0',decide:(state,candidates)=>brain.decide(state,candidates)});
controllerRegistry.stage('llm-brain','1.0.0');
controllerRegistry.activateAtTick(0);

const log = async (event:string,data?:unknown) => {
  const line = `[${new Date().toISOString()}] ${event}${data === undefined ? '' : ' ' + JSON.stringify(data)}\n`;
  process.stdout.write(line);
  await appendFile('../../sol-session.log',line).catch(()=>{});
};
const feed = (label:string,summary:string,reason:string,data:Partial<FeedEvent>&{setCurrent?:boolean}={}) => {
  const e:FeedEvent = {tick,label,summary,reason,target:data.target,item:data.item,source:data.source,reward:data.reward,actionType:data.actionType,at:new Date().toISOString()};
  if(data.setCurrent!==false) currentAction=e;
  actionHistory.push(e);
  if(actionHistory.length>200) actionHistory.shift();
};

const commandDirective=(command:string|null)=>command==='force_bank'?'Immediately travel to Draynor Bank using the verified waypoint route; do not fish or change combat style until arrival is verified.':command==='force_fishing'?'Travel to the Draynor fishing area and fish only if the action produces measurable XP or inventory progress; abandon fishing after one failed interaction.':command==='abandon_objective'?'Abandon the current objective and choose a new measurable progression goal outside the current bank-fishing loop.':null;
const applyLiveControl=(next:LiveControl)=>{
  const directive=next.directive||commandDirective(next.command);
  brain.applyExternalDirective(directive);
  if(next.config)brain.applyRuntimeConfig(next.config);
  if(next.controllerId&&next.controllerVersion){try{controllerRegistry.stage(next.controllerId,next.controllerVersion);void log('CONTROLLER_STAGED',{id:next.controllerId,version:next.controllerVersion,activation:'next_tick'});}catch(err){void log('CONTROLLER_STAGE_REJECTED',{id:next.controllerId,version:next.controllerVersion,error:String(err)});}}
  if(next.command==='abandon_objective'){currentGoal='Abandon current objective';currentWhy='Operator control requested a new measurable progression goal.';nextDecisionTick=tick+1;}
  else if(next.command==='force_bank'){currentGoal='Force travel to Draynor Bank';currentWhy='Operator control requested verified bank travel.';nextDecisionTick=tick+1;}
  else if(next.command==='force_fishing'){currentGoal='Force travel to Draynor fishing';currentWhy='Operator control requested bounded fishing progression.';nextDecisionTick=tick+1;}
};
const acceptControl=(doc:any,source:'http'|'github')=>{
  const revision=Number(doc?.revision);if(!Number.isSafeInteger(revision)||revision<=controlState.revision)return false;
  if(doc?.expiresAt&&Date.parse(String(doc.expiresAt))<=Date.now())return false;
  const allowed=['pause','resume','abandon_objective','clear_directive','force_bank','force_fishing','set_config'];
  const command=allowed.includes(String(doc?.command))?String(doc.command):null;
  const directive=doc?.directive===null?null:String(doc?.directive||'').trim().slice(0,300)||null;
  const config=doc?.config&&typeof doc.config==='object'?doc.config:undefined;
  const controllerId=typeof doc?.controllerId==='string'?doc.controllerId.trim().slice(0,80):undefined;
  const controllerVersion=typeof doc?.controllerVersion==='string'?doc.controllerVersion.trim().slice(0,40):undefined;
  if(!command&&!directive&&doc?.directive!==null)return false;
  controlState={revision,directive:command==='clear_directive'?null:directive??controlState.directive,paused:command==='pause'?true:command==='resume'?false:controlState.paused,command,config:config??controlState.config,controllerId,controllerVersion,updatedAt:new Date().toISOString(),source};
  applyLiveControl(controlState);return true;
};
const superviseTeacher=()=>{
  if(teacherProbeInFlight||tick-lastTeacherProbeTick<20)return;
  teacherProbeInFlight=true;lastTeacherProbeTick=tick;
  void brain.checkTeacherHealth().then(online=>{
    const active=controllerRegistry.status.activeId;
    if(!online&&active==='llm-brain'){
      controllerRegistry.stage('deterministic-fallback','1.0.0');controllerRegistry.activateAtTick(tick);
      currentGoal='Maintain verified progression while teacher reconnects';currentWhy='Teacher model is unavailable; deterministic progression owns the body until a health probe succeeds.';
      void log('TEACHER_OFFLINE_DETERMINISTIC_FALLBACK',{tick,teacher:brain.motorModel});
    }else if(online&&active!=='llm-brain'){
      controllerRegistry.stage('llm-brain','1.0.0');controllerRegistry.activateAtTick(tick);
      currentWhy='Teacher model health probe succeeded; restoring teacher-supervised decisions at this tick boundary.';
      void log('TEACHER_RECOVERED',{tick,teacher:brain.motorModel});
    }
  }).catch(err=>void log('TEACHER_HEALTH_PROBE_FAILED',{tick,error:String(err).slice(0,180)})).finally(()=>{teacherProbeInFlight=false;});
};

const pollLiveControl=async()=>{
  if(controlPollInFlight||!process.env.GH_TOKEN||!process.env.GITHUB_REPOSITORY||Date.now()-lastControlPollAt<4000)return;
  controlPollInFlight=true;lastControlPollAt=Date.now();
  try{
    const r=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/sol-agent/control.json?ref=sol-control&t=${Date.now()}`,{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${process.env.GH_TOKEN}`,'X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(3500)});
    if(r.status===404)return;if(!r.ok)throw new Error(`control fetch ${r.status}`);
    const body:any=await r.json();if(body.sha&&body.sha===controlSha)return;controlSha=body.sha||controlSha;
    const content=Buffer.from(String(body.content||''),'base64').toString('utf8');const doc=JSON.parse(content);
    if(acceptControl(doc,'github'))await log('LIVE_CONTROL_APPLIED',{revision:controlState.revision,command:controlState.command,directive:controlState.directive,paused:controlState.paused,source:'github'});
  }catch(err){console.warn('LIVE_CONTROL_POLL_FAILED',String(err).slice(0,180));}
  finally{controlPollInFlight=false;}
};

let snapshot:any = {
  updatedAt:new Date().toISOString(),online:false,inGame:false,tick:0,revision:0,sessionStartedAt,directive,runNumber,runtimeConfig:brain.runtime,
  player:null,skills:[],inventory:[],equipment:[],nearbyNpcs:[],nearbyPlayers:[],groundItems:[],nearbyLocs:[],opFeedback:{opRejectedCount:0},sessionEnd:null,
  combatStyle:null,combatEvents:[],gameMessages:[],outgoingChat:[],recentDialogs:[],prayers:null,
  worldUi:{shopOpen:false,bankOpen:false,tradeOpen:false,dialogOpen:false,modalOpen:false},
  currentAction:null,currentGoal,currentWhy,thinking:false,currentProcedure:null,economyResolution,obligationExecutor:obligationExecutor.status(),progression:currentProgression,durableState,actions:[],actionCount:0,primitiveActionCount:0,movementTrail:[],lessons:[],agent:brain.publicState(),controller:controllerRegistry.status,body:persistentBody.envelope
};

const publicSnapshot=()=>({
  updatedAt:snapshot.updatedAt,online:snapshot.online,inGame:snapshot.inGame,tick:snapshot.tick,runNumber:snapshot.runNumber,
  sessionStartedAt:snapshot.sessionStartedAt,currentGoal:snapshot.currentGoal,currentWhy:snapshot.currentWhy,thinking:snapshot.thinking,
  player:snapshot.player?{combatLevel:snapshot.player.combatLevel,hp:snapshot.player.hp,maxHp:snapshot.player.maxHp,runEnergy:snapshot.player.runEnergy,isDead:snapshot.player.isDead,respawnCount:snapshot.player.respawnCount,worldX:snapshot.player.worldX,worldZ:snapshot.player.worldZ,level:snapshot.player.level,combat:{inCombat:!!snapshot.player.combat?.inCombat,targetType:snapshot.player.combat?.targetType||'none',targetIndex:snapshot.player.combat?.targetIndex??-1}}:null,
  skills:(snapshot.skills||[]).map((skill:any)=>({name:skill.name,level:skill.level})),
  combatStyle:snapshot.combatStyle||null,nearbyNpcs:snapshot.nearbyNpcs||[],nearbyPlayers:snapshot.nearbyPlayers||[],groundItems:snapshot.groundItems||[],nearbyLocs:snapshot.nearbyLocs||[],opFeedback:snapshot.opFeedback||{opRejectedCount:0},sessionEnd:snapshot.sessionEnd||null,inventory:snapshot.inventory||[],equipment:snapshot.equipment||[],combatEvents:snapshot.combatEvents||[],gameMessages:[],outgoingChat:[],recentDialogs:[],actions:snapshot.actions||[],movementTrail:snapshot.movementTrail||[],lessons:snapshot.lessons||[],
  currentAction:snapshot.currentAction?{tick:snapshot.currentAction.tick,label:snapshot.currentAction.label,summary:snapshot.currentAction.summary,reason:snapshot.currentAction.reason,actionType:snapshot.currentAction.actionType,reward:snapshot.currentAction.reward}:null,
  actionCount:snapshot.actionCount,primitiveActionCount:snapshot.primitiveActionCount,runtimeConfig:snapshot.runtimeConfig,
  agent:{currentController:snapshot.agent?.currentController||'offline',motorOnline:!!snapshot.agent?.motorOnline,teacherOnline:!!snapshot.agent?.teacherOnline,strategistOnline:!!snapshot.agent?.strategistOnline,teacherConsecutiveFailures:snapshot.agent?.teacherConsecutiveFailures||0,lastTeacherHealthyAt:snapshot.agent?.lastTeacherHealthyAt||null,lastTeacherError:snapshot.agent?.lastTeacherError||null,lastStrategistError:snapshot.agent?.lastStrategistError||null,studentMode:snapshot.agent?.studentMode||'unknown',sessionMotorChoices:snapshot.agent?.sessionMotorChoices||0,repoKnowledgeSegments:snapshot.agent?.repoKnowledgeSegments||0,repoKnowledgeSources:snapshot.agent?.repoKnowledgeSources||0,retrievedRepoKnowledge:snapshot.agent?.retrievedRepoKnowledge||[],planTree:snapshot.agent?.planTree||[]},
  controller:snapshot.controller,body:snapshot.body,economyResolution:snapshot.economyResolution,obligationExecutor:snapshot.obligationExecutor,progression:snapshot.progression,durableState:snapshot.durableState,
  viewerAccess:'summary',syncRevision:snapshot.revision??snapshot.tick??0
});

const refreshSnapshot = (state:BotWorldState|null) => {
  const s:any=state;
  if(state?.player && (tick%2===0 || movementTrail.length===0)){
    const last=movementTrail[movementTrail.length-1];
    const next={x:state.player.worldX,z:state.player.worldZ,level:state.player.level,tick};
    if(!last || last.x!==next.x || last.z!==next.z || last.level!==next.level){
      movementTrail.push(next);
      if(movementTrail.length>420) movementTrail.shift();
    }
  }
  const agent=brain.publicState();
  snapshot={
    updatedAt:new Date().toISOString(),online:!!state?.player,inGame:!!s?.inGame,tick,revision:s?.revision??0,runtimeConfig:brain.runtime,
    sessionStartedAt,directive,runNumber,player:state?.player?{...state.player,animId:(state.player as any).animId}:null,skills:state?.skills??[],
    inventory:state?.inventory?.map(i=>({id:i.id,name:i.name,count:i.count,slot:i.slot}))??[],
    equipment:state?.equipment?.map(i=>({id:i.id,name:i.name,count:i.count,slot:i.slot}))??[],
    nearbyNpcs:s?.nearbyNpcs?.map((n:any)=>({id:n.id,index:n.index,name:n.name,combatLevel:n.combatLevel,x:n.x,z:n.z,hp:n.hp,maxHp:n.maxHp,healthPercent:n.healthPercent,inCombat:n.inCombat,targetIndex:n.targetIndex,animId:n.animId,spotanimId:n.spotanimId,lastCombatTick:n.lastCombatTick,distance:n.distance,reachable:n.reachable,options:n.options}))??[],
    nearbyPlayers:s?.nearbyPlayers?.map((p:any)=>({index:p.index,name:p.name,combatLevel:p.combatLevel,x:p.x,z:p.z,distance:p.distance,reachable:p.reachable,animId:p.animId,spotanimId:p.spotanimId,inCombat:p.inCombat,targetIndex:p.targetIndex}))??[],
    groundItems:s?.groundItems?.map((g:any)=>({id:g.id,name:g.name,count:g.count,x:g.x,z:g.z,distance:g.distance,reachable:g.reachable}))??[],
    nearbyLocs:s?.nearbyLocs?.slice?.(0,180)?.map((l:any)=>({id:l.id,name:l.name,x:l.x,z:l.z,level:l.level,distance:l.distance,reachable:l.reachable,options:l.options}))??[],
    combatStyle:s?.combatStyle??null,
    combatEvents:s?.combatEvents?.slice?.(-100)?.map((e:any)=>({tick:e.tick,observationId:e.observationId,type:e.type,damage:e.damage,sourceType:e.sourceType,sourceIndex:e.sourceIndex,targetType:e.targetType,targetIndex:e.targetIndex}))??[],
    gameMessages:s?.gameMessages?.slice?.(-50)?.map((m:any)=>({type:m.type,text:m.text,sender:m.sender,tick:m.tick,observationId:m.observationId,fromSelf:m.fromSelf}))??[],
    outgoingChat:outgoingChat.slice(-50),
    recentDialogs:s?.recentDialogs?.slice?.(-20)?.map((d:any)=>({text:d.text,tick:d.tick,observationId:d.observationId,interfaceId:d.interfaceId}))??[],
    opFeedback:s?.opFeedback??{opRejectedCount:0},sessionEnd,
    prayers:s?.prayers??null,
    worldUi:{shopOpen:!!s?.shop?.isOpen,bankOpen:!!s?.bank?.isOpen,tradeOpen:!!s?.trade?.isOpen,tradePartner:s?.trade?.partner??null,dialogOpen:!!s?.dialog?.isOpen,modalOpen:!!s?.modalOpen},
    currentAction,currentGoal,currentWhy,thinking:decisionInFlight||actionAwaitingOutcome,currentProcedure:procedureInFlight||lastProcedureRun,actions:actionHistory,actionCount:actions,primitiveActionCount:primitiveActions,movementTrail,
    lessons:(agent.recentMemories||[]).map((m:any)=>m.text),economyResolution,obligationExecutor:obligationExecutor.status(),progression:currentProgression,durableState,agent,controller:controllerRegistry.status,body:persistentBody.envelope
  };
};

const server=Bun.serve({
  port:8787,
  async fetch(req){
    const url=new URL(req.url),path=url.pathname;
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
    const fullAccess=viewerAccessToken.length>0&&url.searchParams.get('token')===viewerAccessToken;
    const bearer=req.headers.get('authorization')||'';
    const controlAccess=controlToken.length>0&&bearer===`Bearer ${controlToken}`;
    if(path==='/state') return Response.json(fullAccess?{...snapshot,control:controlState,viewerAccess:'full'}:publicSnapshot(),{headers});
    if(path==='/control'&&req.method==='POST'){
      if(!controlAccess)return Response.json({ok:false,error:'unauthorized'},{status:401,headers});
      let body:any;try{body=await req.json();}catch{return Response.json({ok:false,error:'invalid_json'},{status:400,headers});}
      const revision=Number(body?.revision);if(!Number.isSafeInteger(revision)||revision<=controlState.revision)return Response.json({ok:false,error:'revision_must_increase',currentRevision:controlState.revision},{status:409,headers});
      const command=['pause','resume','abandon_objective','clear_directive','force_bank','force_fishing','set_config'].includes(String(body?.command))?String(body.command):null;
      const directive=body?.directive===null?null:String(body?.directive||'').trim().slice(0,300)||null;
      const config=body?.config&&typeof body.config==='object'?body.config:undefined;
      if(!command&&!directive&&body?.directive!==null)return Response.json({ok:false,error:'missing_command_or_directive'},{status:400,headers});
      controlState={revision,directive:command==='clear_directive'?null:directive??controlState.directive,paused:command==='pause'?true:command==='resume'?false:controlState.paused,command,config:config??controlState.config,controllerId:typeof body?.controllerId==='string'?body.controllerId.trim().slice(0,80):undefined,controllerVersion:typeof body?.controllerVersion==='string'?body.controllerVersion.trim().slice(0,40):undefined,updatedAt:new Date().toISOString(),source:'http'};
      applyLiveControl(controlState);
      await log('LIVE_CONTROL_APPLIED',{revision,command,directive:controlState.directive,paused:controlState.paused,source:'http'});
      return Response.json({ok:true,control:controlState},{headers});
    }
    if(path==='/health'){
      const ready=!!snapshot.online&&!!snapshot.inGame&&!!snapshot.player&&snapshot.agent?.motorOnline===true;
      return Response.json({ok:ready,online:snapshot.online,inGame:snapshot.inGame,tick,actionCount:actions,sessionStartedAt,runNumber,agentController:snapshot.agent?.currentController,teacherOnline:snapshot.agent?.teacherOnline,controlRevision:controlState.revision,paused:controlState.paused},{status:ready?200:503,headers});
    }
    return new Response(viewerHtml,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
  }
});
await log('VIEWER_LOCAL',{url:`http://127.0.0.1:${server.port}`});

const session=await startSession({host:'rs-sdk-demo.fly.dev',username,password,quiet:false,profanityFilter:true,onEnd:(end)=>{sessionEnd=end;currentGoal='Recover ended game session';currentWhy=`The SDK session ended with reason: ${end.reason}.`;void log('SDK_SESSION_END',end);}});
const client=session.client;

const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const slug=(s:string)=>norm(s).replace(/\s+/g,'-').slice(0,24)||'x';
type ItemDisposition='use'|'keep'|'bank'|'sell'|'discard';
const isCurrency=(name:string)=>/^coins?$|^coin pouch$|^gp$/i.test(String(name||'').trim());
const itemDisposition=(item:any,state:BotWorldState):ItemDisposition=>{
  const name=String(item?.name||'').trim();
  if(isCurrency(name)||/^(bronze|iron|steel|mithril|adamant|rune) (axe|pickaxe)|tinderbox|fishing (net|rod)|fly fishing rod/i.test(name))return 'keep';
  if(/^bones?$/i.test(name)||/^(big )?bones$/i.test(name))return item?.optionsWithIndex?.some((o:any)=>/bury/i.test(String(o.text||'')))?'use':'bank';
  if(/^raw /i.test(name)&&/(shrimp|anchov|fish|sardine|herring|trout|salmon)/i.test(name))return 'bank';
  if(/^(cooked |burnt )?(shrimp|anchov|fish|sardine|herring|trout|salmon|lobster|bread|cake)/i.test(name))return 'keep';
  if(/^(ash|empty|junk|weed|rotten food)$/i.test(name))return 'discard';
  if(/(logs?|ore|bar|rune|coal|leather|herb|seed|quest|key)/i.test(name))return 'bank';
  return state.shop?.isOpen?'sell':'bank';
};
const dispositionLabel=(item:any,state:BotWorldState)=>itemDisposition(item,state);
const isCapacityPressure=(state:BotWorldState)=>Math.max(0,28-(state.inventory||[]).length)<8;
const economyAction=(type:string)=>/^(shopSell|bankDeposit|clickDialogOption|shopBuy|bankWithdraw|closeShop|closeModal)$/.test(type);
const meaningfulWithdrawal=(c:AgentCandidate)=>c.action?.type!=='bankWithdraw'||/withdraw.*(pickaxe|axe|fishing net|fishing rod|tinderbox|shrimp|anchov|bread|food|cooked|lobster|trout|salmon)/i.test(`${c.label} ${(c.tags||[]).join(' ')}`);
const position=()=>lastState?.player?{x:lastState.player.worldX,z:lastState.player.worldZ,level:lastState.player.level}:null;
const tileDistance=(a:{x:number;z:number},b:{x:number;z:number})=>Math.hypot(a.x-b.x,a.z-b.z);
const waitTicks=async(count:number)=>{const start=tick,deadline=Date.now()+Math.max(4000,count*1100);while(tick<start+count&&Date.now()<deadline)await Bun.sleep(180);};
const dispatchPrimitive=async(label:string,action:any)=>{
  primitiveActions++;
  if(procedureInFlight){procedureInFlight.step=label;procedureInFlight.primitiveActions++;}
  try{
    const result:any=await Promise.resolve(client.executeBotAction(action));
    const normalized={success:result?.success!==false,message:String(result?.message||label),phase:result?.phase,reason:result?.reason};
    void log('WORLD_SKILL_PRIMITIVE',{tick,label,action:action.type,result:normalized});
    return normalized;
  }catch(err){const failed={success:false,message:String(err),reason:'executor_exception'};void log('WORLD_SKILL_PRIMITIVE_ERROR',{tick,label,error:String(err)});return failed;}
};

const openNearestDoorToward=async(target:{x:number;z:number})=>{
  const state=lastState;if(!state?.player)return false;
  const candidates=(state.nearbyLocs||[]).filter(loc=>{
    const open=loc.optionsWithIndex?.some(o=>/^open$/i.test(o.text));
    const frontDoor=(loc.x===3108||loc.x===3109)&&loc.z===3353;
    return open&&loc.id!==131&&loc.reachable!==false&&!frontDoor&&loc.level===state.player!.level&&/door|gate/i.test(loc.name);
  }).sort((a,b)=>(a.distance+tileDistance(a,target)*.65)-(b.distance+tileDistance(b,target)*.65));
  const door=candidates[0];if(!door)return false;
  const option=door.optionsWithIndex.find(o=>/^open$/i.test(o.text));if(!option)return false;
  const started=tick,result=await dispatchPrimitive(`Open route obstacle ${door.name} at ${door.x},${door.z}`,{type:'interactLoc',x:door.x,z:door.z,locId:door.id,optionIndex:option.opIndex,reason:'Repository-guided navigation opened a verified obstacle.'});
  await waitTicks(4);const blocked=(lastState?.gameMessages||[]).some((m:any)=>Number(m.tick)>started&&/locked|won't open|can't reach/i.test(String(m.text||'')));return result.success&&!blocked;
};

const walkToward=async(target:{x:number;z:number;level?:number},radius=2,allowDoors=false,maxAttempts=7)=>{
  const desiredLevel=target.level??position()?.level??0;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    const before=position();if(!before)return false;
    const beforeDistance=tileDistance(before,target);if(before.level===desiredLevel&&beforeDistance<=radius)return true;
    const result=await dispatchPrimitive(`Walk toward ${target.x},${target.z} (attempt ${attempt})`,{type:'walkTo',x:target.x,z:target.z,running:true,reason:'Follow a model-selected verified route.'});
    await waitTicks(7);
    const after=position();if(!after)return false;
    const afterDistance=tileDistance(after,target);if(after.level===desiredLevel&&afterDistance<=radius)return true;
    const progressed=afterDistance<beforeDistance-.75;
    if(!result.success||!progressed){if(allowDoors&&await openNearestDoorToward(target)){continue;}if(!result.success)return false;}
  }
  const end=position();return !!end&&end.level===desiredLevel&&tileDistance(end,target)<=radius;
};

const descendManorToGround=async()=>{
  for(let attempt=1;attempt<=4;attempt++){
    const p=position();if(!p)return false;if(p.level===0)return true;
    const transition=p.level===2
      // forceapproach=13 blocks north/south/west; the level-2 staircase must be used from its east tile.
      ?{level:2,x:3105,z:3363,id:1740,approach:{x:3106,z:3363,level:2},option:/climb-down/i}
      :p.level===1
        // forceapproach=14 blocks east/south/west; the 2x2 level-1 staircase must be used from its north edge.
        ?{level:1,x:3108,z:3364,id:1731,approach:{x:3108,z:3366,level:1},option:/walk-down/i}
        :null;
    if(!transition)return false;
    if(!await walkToward(transition.approach,0,true,10))continue;
    const state=lastState;
    const loc=(state?.nearbyLocs||[]).find(l=>l.level===transition.level&&l.x===transition.x&&l.z===transition.z&&l.id===transition.id);
    const option=loc?.optionsWithIndex?.find(o=>transition.option.test(o.text));
    const result=await dispatchPrimitive(`Descend Draynor Manor staircase from level ${transition.level}`,{type:'interactLoc',x:transition.x,z:transition.z,locId:transition.id,optionIndex:option?.opIndex||1,reason:'Execute the model-selected manor escape by returning to the ground floor.'});
    await waitTicks(10);
    const after=position();if(result.success&&after&&after.level<transition.level)continue;
    await openNearestDoorToward(transition.approach);
  }
  return position()?.level===0;
};

const openDocumentedDoor=async(x:number,z:number,locId:number)=>{
  const state=lastState;if(!state?.player)return false;
  const loc=(state.nearbyLocs||[]).find(l=>l.x===x&&l.z===z&&l.level===state.player!.level);
  const open=loc?.optionsWithIndex?.find(o=>/^open$/i.test(o.text));
  if(loc&&!open)return true;
  const started=tick,result=await dispatchPrimitive(`Open documented Draynor door at ${x},${z}`,{type:'interactLoc',x,z,locId:loc?.id||locId,optionIndex:open?.opIndex||1,reason:'Use the rs-sdk Draynor Manor escape procedure.'});
  await waitTicks(4);const blocked=(lastState?.gameMessages||[]).some((m:any)=>Number(m.tick)>started&&/locked|won't open|can't reach/i.test(String(m.text||'')));return result.success&&!blocked;
};

const crossDocumentedDoor=async(args:{x:number;z:number;id:number;approach:{x:number;z:number};exit:{x:number;z:number};farSide:(p:{x:number;z:number;level:number})=>boolean})=>{
  const initial=position();if(!initial)return false;if(args.farSide(initial))return true;
  if(!await walkToward(args.approach,0,false,5))return false;
  await dispatchPrimitive(`Test whether documented door ${args.x},${args.z} is already open`,{type:'walkTo',x:args.exit.x,z:args.exit.z,running:true,reason:'Verify door state before interacting.'});
  await waitTicks(5);const afterTest=position();if(afterTest&&args.farSide(afterTest))return true;
  if(!await walkToward(args.approach,0,false,3))return false;
  if(!await openDocumentedDoor(args.x,args.z,args.id))return false;
  return walkToward(args.exit,0,false,5);
};

const executeWorldSkill=async(action:any)=>{
  const start=position();if(!start)return{success:false,message:'No live player position.'};
  const skill=String(action.skill||'unknown'),label=skill==='escape-draynor-manor'?'Escape Draynor Manor':`Travel to ${action.destination||'landmark'}`;
  const procedure:ProcedureState={skill,label,status:'running',step:'Starting verified procedure',startedTick:tick,start,primitiveActions:0};
  procedureInFlight=procedure;let success=false;let message='Procedure failed before completion.';
  try{
    if(skill==='escape-draynor-manor'){
      success=await descendManorToGround();
      const p0=position();
      success=success&&!!p0
        &&(p0.z>=3358||await crossDocumentedDoor({x:3109,z:3358,id:1530,approach:{x:3109,z:3357},exit:{x:3109,z:3359},farSide:p=>p.z>=3358}))
        &&await walkToward({x:3106,z:3367},0,false,6)
        &&await crossDocumentedDoor({x:3106,z:3368,id:1530,approach:{x:3106,z:3367},exit:{x:3106,z:3369},farSide:p=>p.z>=3369})
        &&await walkToward({x:3114,z:3370},0,false,6)
        &&await walkToward({x:3114,z:3368},0,false,5)
        &&await walkToward({x:3118,z:3368},0,false,5)
        &&await walkToward({x:3118,z:3361},0,false,6)
        &&await walkToward({x:3119,z:3357},0,false,6)
        &&await crossDocumentedDoor({x:3119,z:3356,id:1530,approach:{x:3119,z:3357},exit:{x:3120,z:3356},farSide:p=>p.x>=3120})
        &&await walkToward({x:3123,z:3359},0,false,6)
        &&await crossDocumentedDoor({x:3123,z:3360,id:136,approach:{x:3123,z:3359},exit:{x:3123,z:3361},farSide:p=>p.z>=3361})
        &&await walkToward({x:3125,z:3369},0,false,6);
      const end=position();success=success&&!!end&&(end.x>3124||end.z>3368);message=success?'Reached the Draynor Manor courtyard through the verified four-door route.':'Could not verify escape from the manor boundary.';
    }else if(skill==='travel-waypoints'){
      const points=(Array.isArray(action.waypoints)?action.waypoints:[]).map((p:any)=>({x:Number(p[0]??p.x),z:Number(p[1]??p.z)})).filter((p:any)=>Number.isFinite(p.x)&&Number.isFinite(p.z));
      success=points.length>0;
      for(const point of points){if(!await walkToward(point,4,true)){success=false;break;}}
      message=success?`Verified arrival at ${action.destination||'the selected landmark'}.`:`Could not verify arrival at ${action.destination||'the selected landmark'}.`;
    }else message=`Unknown world skill ${skill}.`;
  }catch(err){message=String(err);success=false;}
  const end=position(),failedStep=procedure.step;
  if(!success){const game=(lastState?.gameMessages||[]).slice(-3).map((m:any)=>String(m.text||'')).filter(Boolean).join(' | ');message=`${message} Last attempted step: ${failedStep}.${game?` Recent game messages: ${game}`:''}`.slice(0,700);}
  procedure.status=success?'completed':'failed';procedure.step=success?'Outcome verified':'Verification failed';procedure.finishedTick=tick;procedure.end=end||undefined;procedure.message=message;lastProcedureRun={...procedure};procedureInFlight=null;
  void log('WORLD_SKILL_OUTCOME',{tick,skill,success,message,start,end,primitiveActions:procedure.primitiveActions});
  return{success,message,phase:'completion',reason:success?undefined:'verification_failed'};
};

const buildCandidates=(state:BotWorldState):AgentCandidate[]=>{
  const p=state.player!;
  const out:AgentCandidate[]=[];
  const inventoryCapacity=28;
  const inventorySlots=(state.inventory||[]).length;
  const freeInventorySlots=Math.max(0,inventoryCapacity-inventorySlots);
  const capacityPressure=freeInventorySlots<=(brain.runtime.inventoryWarningSlots??3);
  const reachableGroundItems=(state.groundItems||[]).filter((g:any)=>g.reachable!==false);
  const valuableGroundItems=reachableGroundItems.filter((g:any)=>!/(ash|bones|empty|junk|weed)/i.test(String(g.name||'')));

  let seq=0;
  const add=(c:Omit<AgentCandidate,'id'>)=>{ if(out.length<(brain.runtime.candidateLimit||96)) out.push({...c,id:`a${seq++}_${slug(c.category)}`}); };

  add({label:'Wait and observe for a moment',category:'wait',fingerprint:'wait',settleTicks:3,action:{type:'wait',reason:'Observe before acting.'},tags:['observe','patience']});

  if(state.dialog?.isOpen){
    const recent=actionHistory.slice(-4).filter(e=>e.actionType==='clickDialogOption').length;
    if(economyResolution.noProgress>=2){
        const optionIndex=Number(state.dialog.options?.[0]?.index||0);
        add({label:'Advance stalled economy dialog and re-evaluate',category:'dialog',fingerprint:'dialog:recover-stalled-economy',settleTicks:4,action:{type:'clickDialogOption',optionIndex,reason:'Use the SDK dialogue primitive; generic modal close cannot dismiss chat dialogs.'},tags:['economy','dialog','anti-loop','sdk-correct']});
    }else for(const o of state.dialog.options?.slice(0,8)||[]) add({label:`Dialog ${o.index}: ${o.text||'(continue)'}`,category:'dialog',fingerprint:`dialog:${o.index}:${norm(o.text||'continue')}`,settleTicks:4,action:{type:'clickDialogOption',optionIndex:o.index,reason:'Advance the merchant or bank dialog toward a transaction.'},tags:['conversation','dialog','economy',o.text||'continue']});
    return out;
  }

  if(state.shop?.isOpen){
    const pressure=isCapacityPressure(state);
    if(economyResolution.noProgress<2&&!pressure)for(const item of (state.shop.shopItems||[]).slice(0,14)) add({label:`Buy 1 ${item.name} for about ${item.buyPrice}`,category:'shop',fingerprint:`shop:buy:${norm(item.name)}`,settleTicks:5,action:{type:'shopBuy',slot:item.slot,amount:1,reason:'Buy from the open shop.'},tags:['economy','buy',item.name]});
    if(economyResolution.noProgress<2)for(const item of (state.shop.playerItems||[]).filter((i:any)=>!isCurrency(i.name)).slice(0,10)) add({label:`Sell 1 ${item.name} for about ${item.sellPrice}`,category:'shop',fingerprint:`shop:sell:${norm(item.name)}`,settleTicks:5,action:{type:'shopSell',slot:item.slot,amount:1,reason:pressure?'Sell surplus to create inventory capacity.':'Sell to the open shop.'},tags:['economy','sell',item.name]});
    add({label:'Close the shop',category:'modal',fingerprint:'modal:close-shop',settleTicks:3,action:{type:'closeShop',reason:economyResolution.noProgress>=2?'Abort stalled shop transaction.':'Close the shop.'},tags:['shop','transaction-abort']});
    return out;
  }

  if(state.bank?.isOpen){
    const pressure=isCapacityPressure(state);
    const purposeful=(state.inventory||[]).filter((item:any)=>!isCurrency(item.name)&&itemDisposition(item,state)!=='keep');
    if(economyResolution.noProgress<2)for(const item of purposeful.filter((i:any)=>itemDisposition(i,state)==='bank').slice(0,14)) add({label:`Deposit all ${item.name} because it is persistent material or future-use stock`,category:'bank',fingerprint:`bank:deposit:${norm(item.name)}`,settleTicks:5,action:{type:'bankDeposit',slot:item.slot,amount:-1,reason:`Item policy classified ${item.name} as bank: preserve it for a future skill, quest, or resource goal.`},tags:['bank','store','learned-item-policy',item.name]});
    if(!pressure&&economyResolution.noProgress<2)for(const item of (state.bank.items||[]).slice(0,14)) add({label:`Withdraw 1 ${item.name}`,category:'bank',fingerprint:`bank:withdraw:${norm(item.name)}`,settleTicks:5,action:{type:'bankWithdraw',slot:item.slot,amount:1,reason:'Withdraw only when the active plan explicitly needs this item.'},tags:['bank','retrieve',item.name]});
    add({label:purposeful.some((i:any)=>/^(use|discard)$/.test(itemDisposition(i,state)))?'Close the bank to process item-purpose actions':'Close the bank',category:'modal',fingerprint:'modal:close-bank',settleTicks:3,action:{type:'closeModal',reason:economyResolution.noProgress>=2?'Abort stalled bank transaction.':'Close the bank after storage decisions.'},tags:['bank','transaction-abort','item-policy']});
    return out;
  }

  if(isCapacityPressure(state)){
    for(const item of (state.inventory||[]).filter((i:any)=>itemDisposition(i,state)==='use').slice(0,6)){
      const opt=(item.optionsWithIndex||[]).find((o:any)=>/bury|eat|use/i.test(String(o.text||'')));
      if(opt)add({label:`Use ${item.name} according to item policy (${opt.text})`,category:'inventory',fingerprint:`inventory:use:${norm(item.name)}:${opt.opIndex}`,settleTicks:4,action:{type:'useInventoryItem',slot:item.slot,optionIndex:opt.opIndex,reason:`Learned item policy classified ${item.name} as a consumable/use item, not storage.`},tags:['item-policy','use',item.name]});
    }
    for(const item of (state.inventory||[]).filter((i:any)=>itemDisposition(i,state)==='discard').slice(0,4)) add({label:`Discard ${item.name} as confirmed junk`,category:'inventory',fingerprint:`inventory:drop:${norm(item.name)}:${item.slot}`,settleTicks:3,action:{type:'dropItem',slot:item.slot,reason:`Learned item policy classified ${item.name} as junk with no current or future use.`},tags:['item-policy','discard',item.name]});
  }

  if(state.interface?.isOpen){
    add({label:'Close the blocking interface',category:'modal',fingerprint:'modal:close-interface',settleTicks:3,action:{type:'closeModal',reason:'Close the current interface.'},tags:['interface']});
    return out;
  }

  const insideDraynorManor=(p.level===0&&p.worldX>=3095&&p.worldX<=3124&&p.worldZ>=3345&&p.worldZ<=3368)||(p.level>0&&p.level<=2&&p.worldX>=3092&&p.worldX<=3128&&p.worldZ>=3344&&p.worldZ<=3376);
  if(insideDraynorManor) add({label:`Execute rs-sdk skill: escape Draynor Manor${p.level>0?' by descending to ground first':''}, then use the documented east-wing doors`,category:'navigation-skill',fingerprint:'skill:escape-draynor-manor',settleTicks:18,action:{type:'worldSkill',skill:'escape-draynor-manor'},tags:['escape','draynor-manor','staircase','door','repository-tested','measurable-position']});

  const distance=(x:number,z:number)=>Math.hypot(p.worldX-x,p.worldZ-z);
  const bankVisible=(state.nearbyLocs||[]).some((l:any)=>l.reachable!==false&&/bank/i.test(String(l.name||'')))||(state.nearbyNpcs||[]).some((n:any)=>n.reachable!==false&&/banker/i.test(String(n.name||'')));
  if(!insideDraynorManor&&p.level===0&&distance(3092,3243)>6&&distance(3092,3243)<230){
    const waypoints=p.worldZ>3300?[[3130,3320],[3120,3280],[3092,3243]]:[[3092,3243]];
    add({label:'Travel to Draynor Bank at 3092,3243 using verified waypoint navigation',category:'navigation-skill',fingerprint:'skill:travel:draynor-bank',settleTicks:16,action:{type:'worldSkill',skill:'travel-waypoints',destination:'Draynor Bank',waypoints},tags:['travel','bank','draynor','repository-coordinate']});
  }
  if(!insideDraynorManor&&p.level===0&&distance(3087,3230)>6&&distance(3087,3230)<180) add({label:'Travel to the Draynor fishing area at 3087,3230 and verify arrival',category:'navigation-skill',fingerprint:'skill:travel:draynor-fishing',settleTicks:16,action:{type:'worldSkill',skill:'travel-waypoints',destination:'Draynor fishing area',waypoints:[[3087,3230]]},tags:['travel','fishing','resource','repository-coordinate']});

  // Always leave room for navigation so a crowded scene cannot trap the agent in local interactions.
  const walks=[['north',0,5],['south',0,-5],['east',5,0],['west',-5,0],['northeast',4,4],['northwest',-4,4],['southeast',4,-4],['southwest',-4,-4]] as const;
  for(const [name,dx,dz] of walks) add({label:`Explore ${name} about ${Math.max(Math.abs(dx),Math.abs(dz))} tiles`,category:'explore',fingerprint:`walk:${name}`,settleTicks:6,action:{type:'walkTo',x:p.worldX+dx,z:p.worldZ+dz,running:true,reason:`Explore ${name}.`},tags:['explore',name]});

  const foodItems=(state.inventory||[]).filter(i=>i.optionsWithIndex?.some(o=>/^eat$|^drink$/i.test(o.text))).slice(0,5);
  for(const item of foodItems){
    for(const o of item.optionsWithIndex.filter(o=>/^eat$|^drink$/i.test(o.text)).slice(0,1)) add({label:`${o.text} ${item.name}`,category:'recovery',fingerprint:`inventory:${norm(o.text)}:${norm(item.name)}`,settleTicks:4,action:{type:'useInventoryItem',slot:item.slot,optionIndex:o.opIndex,reason:`Use ${item.name}.`},tags:['recovery',item.name,o.text]});
  }

  if((state.nearbyPlayers?.length||0)>0){
    const latestIncoming=[...((state.gameMessages||[]) as any[])].reverse().find(m=>m?.sender&&norm(m.sender)!==norm(username)&&[1,2,3,7].includes(Number(m.type)));
    const incomingId=latestIncoming?`${latestIncoming.observationId??''}:${latestIncoming.tick??''}:${latestIncoming.sender}:${latestIncoming.text}`:null;
    const target=latestIncoming?.sender||state.nearbyPlayers[0]?.name||null;
    add({label:latestIncoming?`Speak publicly; latest message from ${target}: ${String(latestIncoming.text||'').slice(0,90)}`:`Speak publicly to nearby agents: ${state.nearbyPlayers.slice(0,4).map(x=>x.name).join(', ')}`,category:'say',fingerprint:'social:say',settleTicks:5,action:{type:'say',message:'Hello.',reason:'Model chose to communicate.',chatReplyId:incomingId,chatTarget:target},tags:['social','agent','communication']});
  }

  for(const npc of (state.nearbyNpcs||[]).filter(n=>n.reachable!==false).sort((a,b)=>a.distance-b.distance).slice(0,12)){
    for(const o of (npc.optionsWithIndex||[]).slice(0,4)){
      const text=o.text||`option ${o.opIndex}`;
      const lower=text.toLowerCase();
      const category=/attack/.test(lower)?'combat':/pickpocket|steal|trade|shop|sell|buy/.test(lower)?'economy':/talk/.test(lower)?'social':'npc';
      if(category==='combat'&&capacityPressure)continue;
      if(capacityPressure&&bankVisible&&category==='economy'&&!/bank|deposit|banker/i.test(`${npc.name} ${text}`))continue;
      add({label:`${text} ${npc.name} (level ${npc.combatLevel||0}, distance ${npc.distance})`,category,fingerprint:`npc:${norm(text)}:${norm(npc.name)}`,settleTicks:category==='combat'?12:category==='economy'?8:6,action:{type:'interactNpc',npcIndex:npc.index,optionIndex:o.opIndex,reason:`Interact with ${npc.name}.`},tags:[npc.name,text,category,`level-${npc.combatLevel||0}`,capacityPressure?'capacity-pressure':'']});
    }
  }

  for(const g of reachableGroundItems.sort((a,b)=>Number(a.distance||999)-Number(b.distance||999)).slice(0,8)) add({label:`Pick up ${g.count>1?g.count+' ':''}${g.name} (distance ${g.distance})`,category:'pickup',fingerprint:`pickup:${norm(g.name)}`,settleTicks:5,action:{type:'pickupItem',x:g.x,z:g.z,itemId:g.id,reason:`Pick up ${g.name}.`},tags:['item','resource',g.name,valuableGroundItems.includes(g)?'valuable-drop':'']});

  const bankLocs=(state.nearbyLocs||[]).filter((loc:any)=>loc.reachable!==false&&/bank booth|bank chest/i.test(String(loc.name||''))&&Array.isArray(loc.optionsWithIndex)&&loc.optionsWithIndex.length>0).sort((a:any,b:any)=>a.distance-b.distance).slice(0,4);
  for(const loc of bankLocs){
    const option=loc.optionsWithIndex.find((o:any)=>/use[- ]quickly/i.test(String(o.text||'')))||loc.optionsWithIndex.find((o:any)=>/^use$/i.test(String(o.text||'')))||loc.optionsWithIndex[0];
    add({label:`Bank at ${loc.name} (distance ${loc.distance})`,category:'bank',fingerprint:`bank:open:${loc.x}:${loc.z}`,settleTicks:8,action:{type:'interactLoc',x:loc.x,z:loc.z,locId:loc.id,optionIndex:option.opIndex,reason:'Open the nearest usable bank booth; prefer the SDK quick-use operation and verify the bank interface.'},tags:['bank','open',loc.name,option.text]});
  }
  for(const loc of (state.nearbyLocs||[]).filter((l:any)=>l.reachable!==false&&!/bank booth|bank chest/i.test(String(l.name||''))).sort((a:any,b:any)=>a.distance-b.distance).slice(0,12)){
    for(const o of (loc.optionsWithIndex||[]).slice(0,2)) add({label:`${o.text} ${loc.name} (distance ${loc.distance})`,category:'world',fingerprint:`loc:${norm(o.text)}:${norm(loc.name)}`,settleTicks:6,action:{type:'interactLoc',x:loc.x,z:loc.z,locId:loc.id,optionIndex:o.opIndex,reason:`Interact with ${loc.name}.`},tags:['world',loc.name,o.text]});
  }

  for(const item of (state.inventory||[]).slice(0,10)){
    for(const o of (item.optionsWithIndex||[]).filter(o=>!/^eat$|^drink$/i.test(o.text)).slice(0,3)) add({label:`${o.text} ${item.name}${item.count>1?` x${item.count}`:''}`,category:'inventory',fingerprint:`inventory:${norm(o.text)}:${norm(item.name)}`,settleTicks:4,action:{type:'useInventoryItem',slot:item.slot,optionIndex:o.opIndex,reason:`Use ${item.name}: ${o.text}.`},tags:['inventory',item.name,o.text]});
  }

  for(const style of state.combatStyle?.styles||[]) add({label:`Combat style ${style.name}: ${style.type}; trains ${(style.trainsSkills||[]).join(', ')||'unknown'}`,category:'combat-style',fingerprint:`style:${norm(style.type)}:${(style.trainsSkills||[]).join('+').toLowerCase()}`,settleTicks:3,action:{type:'setCombatStyle',style:style.index,reason:`Select ${style.name}.`},tags:['combat-style',style.type,...(style.trainsSkills||[])]});

  return out;
};

const executeChoice=(candidate:AgentCandidate,choice:AgentChoice,state:BotWorldState)=>{
  const action={...candidate.action,reason:choice.reason};
  if(action.type==='say'){
    const proposed=(choice.speech?.trim()||'Hello.').slice(0,80);
    action.message=proposed;
    lastPublicSayTick=tick;lastPublicSayText=action.message;
    if(action.chatReplyId)answeredChatIds.add(action.chatReplyId);
    const chat:OutgoingChat={id:`out-${runNumber||0}-${tick}`,tick,at:new Date().toISOString(),text:action.message,target:action.chatTarget||null,replyTo:action.chatReplyId||null,status:'submitted'};
    outgoingChat.push(chat);if(outgoingChat.length>80)outgoingChat.shift();
    void log('OUTGOING_CHAT',chat);
    delete action.chatReplyId;delete action.chatTarget;
  }
  actions++;
  currentGoal=choice.goal;
  currentWhy=choice.reason;
  const decisionLabel=choice.source==='teacher'?'AGENT_TEACHER':choice.source==='student'?'AGENT_STUDENT':'AGENT_DETERMINISTIC';
  feed(decisionLabel,candidate.label,choice.reason,{source:choice.source,target:candidate.label,actionType:String(action?.type||'unknown')});
  brain.beginExperience(choice,candidate,state,tick);
  obligationExecutor.begin(action,tick);
  actionAwaitingOutcome=true;
  actionStartedTick=tick;
  if(candidate.category==='bank'&&action.type==='interactLoc'){
    candidate.action.executionResult={success:true,pending:true};
    void (async()=>{
      await dispatchPrimitive(candidate.label,action);
      const bankDeadline=Date.now()+10000;
      while(Date.now()<bankDeadline){
        if(lastState?.bank?.isOpen||lastState?.interface?.isOpen)break;
        if(lastState?.dialog?.isOpen){
          const option=Number(lastState.dialog.options?.[0]?.index||0);
          if(option>0||lastState.dialog.options?.length===0){
            await dispatchPrimitive('Advance bank access dialogue',{type:'clickDialogOption',optionIndex:option,reason:'SDK bank helper advances the first bank access dialogue option.'});
          }
        }
        await waitTicks(1);
      }
      const interfaceOpen=!!(lastState?.bank?.isOpen||lastState?.interface?.isOpen);
      candidate.action.executionResult=interfaceOpen?{success:true,message:'Bank interface verified open'}:{success:false,message:'Bank booth interaction did not open a bank interface',reason:'bank_interface_not_open'};
      refreshSnapshot(lastState);
    })().catch(err=>{candidate.action.executionResult={success:false,message:String(err),reason:'bank_open_exception'};refreshSnapshot(lastState);});
    void log('AGENT_ACTION',{tick,source:choice.source,goal:choice.goal,reason:choice.reason,expected:choice.expectedOutcome,confidence:choice.confidence,action:candidate.label,actionType:action.type,actionPayload:action,fingerprint:candidate.fingerprint,result:'verified-bank-open-procedure'});
    return;
  }
  if(action.type==='worldSkill'){
    candidate.action.executionResult={success:true,pending:true};
    void executeWorldSkill(action).then(result=>{candidate.action.executionResult=result;refreshSnapshot(lastState);}).catch(err=>{candidate.action.executionResult={success:false,message:String(err),reason:'world_skill_exception'};procedureInFlight=null;refreshSnapshot(lastState);});
    void log('AGENT_ACTION',{tick,source:choice.source,goal:choice.goal,reason:choice.reason,expected:choice.expectedOutcome,confidence:choice.confidence,action:candidate.label,actionType:action.type,actionPayload:action,fingerprint:candidate.fingerprint,result:'verified-world-skill'});
    return;
  }
  try{
    const result:any=client.executeBotAction(action);
    if(result instanceof Promise)void result.then((resolved:any)=>{candidate.action.executionResult=resolved;}).catch((err:any)=>{candidate.action.executionResult={success:false,message:String(err),reason:'executor_exception'};});
    else candidate.action.executionResult=result;
    void log('AGENT_ACTION',{tick,source:choice.source,goal:choice.goal,reason:choice.reason,expected:choice.expectedOutcome,confidence:choice.confidence,action:candidate.label,actionType:action.type,actionPayload:action,fingerprint:candidate.fingerprint,result:result instanceof Promise?'async':result});
  }catch(err){candidate.action.executionResult={success:false,message:String(err),reason:'executor_exception'};void log('AGENT_ACTION_ERROR',{tick,action:candidate.label,error:String(err)});}
};

const runEmergencyReflex=(state:BotWorldState)=>{
  const p=state.player!;
  if(p.hp<=0) return false;
  const threshold=Math.max(3,Math.floor(p.maxHp*(p.combat.inCombat ? .45 : .32)));
  if(p.hp>threshold) return false;
  const food=state.inventory.find(i=>i.optionsWithIndex?.some(o=>/^eat$/i.test(o.text)));
  const eat=food?.optionsWithIndex?.find(o=>/^eat$/i.test(o.text));
  if(food&&eat){
    client.executeBotAction({type:'useInventoryItem',slot:food.slot,optionIndex:eat.opIndex,reason:'Emergency reflex: health crossed the imminent-danger threshold.'});
    actions++;lastReflexTick=tick;brain.noteReflex();
    currentGoal='Survive immediate danger';currentWhy='Emergency reflex temporarily overrides deliberation because HP is critically low.';
    feed('REFLEX_EAT',`Eat ${food.name}`,currentWhy,{source:'reflex',item:food.name});
    void log('REFLEX_EAT',{tick,hp:[p.hp,p.maxHp],item:food.name});
    return true;
  }
  if(p.combat.inCombat){
    client.executeBotAction({type:'walkTo',x:p.worldX+8,z:p.worldZ+8,running:true,reason:'Emergency reflex: critically low HP with no food; create distance.'});
    actions++;lastReflexTick=tick;brain.noteReflex();
    currentGoal='Escape immediate danger';currentWhy='Emergency reflex temporarily overrides deliberation because HP is critical and no food is available.';
    feed('REFLEX_RETREAT','Run away from combat',currentWhy,{source:'reflex'});
    void log('REFLEX_RETREAT',{tick,hp:[p.hp,p.maxHp]});
    return true;
  }
  return false;
};

const lootGate=(state:BotWorldState,candidates:AgentCandidate[])=>{
  if(state.player?.combat?.inCombat)return candidates;
  const drops=(state.groundItems||[]).filter((g:any)=>g.reachable!==false&&!/(ash|bones|empty|junk|weed)/i.test(String(g.name||'')));
  if(!drops.length)return candidates;
  const safe=candidates.filter(c=>['pickup','bank','shop','economy','modal'].includes(c.category)||c.action?.type==='pickupItem'||c.action?.type==='worldSkill'&&/travel:draynor-bank/.test(c.fingerprint));
  return safe.length?safe:candidates;
};

const capacityGate=(state:BotWorldState,candidates:AgentCandidate[])=>{
  const free=Math.max(0,28-(state.inventory||[]).length);
  const pressured=free<=(brain.runtime.inventoryWarningSlots??3);
  if(!pressured)return candidates;
  const bankOpen=!!state.bank?.isOpen;
  const bankNearby=(state.nearbyNpcs||[]).some((n:any)=>n.reachable!==false&&/banker|bank/i.test(String(n.name||''))&&(n.optionsWithIndex||[]).some((o:any)=>/bank|deposit/i.test(String(o.text||''))))||(state.nearbyLocs||[]).some((l:any)=>l.reachable!==false&&/bank/i.test(String(l.name||'')));
  const shopOpen=!!state.shop?.isOpen;
  const safe=candidates.filter(c=>{
    if(['bank','shop','pickup','modal','dialog'].includes(c.category))return true;
    if(c.category==='economy')return true;
    if(c.action?.type==='worldSkill'&&/travel:draynor-bank/.test(c.fingerprint))return true;
    if(c.action?.type==='interactLoc'&&/bank/i.test(String(c.label)))return true;
    return false;
  });
  if(safe.length>0&&(bankOpen||bankNearby||shopOpen||safe.some(c=>c.category==='pickup')))return safe;
  return candidates.filter(c=>c.category==='navigation-skill'&&/bank/i.test(c.label)||c.category==='economy'||c.category==='pickup'||c.category==='bank'||c.category==='shop'||c.category==='modal');
};

const launchDecision=(stateAtStart:BotWorldState)=>{
  if(decisionInFlight||actionAwaitingOutcome) return;
  const rawCandidates=buildCandidates(stateAtStart);
  const lootCandidates=lootGate(stateAtStart,rawCandidates);
  const gatedCandidates=capacityGate(stateAtStart,lootCandidates);
  const obs={hp:stateAtStart.player?.hp||0,maxHp:stateAtStart.player?.maxHp||1,inCombat:!!stateAtStart.player?.combat?.inCombat,freeSlots:Math.max(0,28-(stateAtStart.inventory||[]).length),warningSlots:Math.max(7,brain.runtime.inventoryWarningSlots??3),groundItems:(stateAtStart.groundItems||[]).map((g:any)=>({name:String(g.name||''),reachable:g.reachable,value:0})),bankOpen:!!stateAtStart.bank?.isOpen,shopOpen:!!stateAtStart.shop?.isOpen,dialogOpen:!!stateAtStart.dialog?.isOpen,interfaceOpen:!!stateAtStart.interface?.isOpen,nearbyBank:(stateAtStart.nearbyLocs||[]).some((l:any)=>/bank/i.test(String(l.name||''))),nearbyShop:(stateAtStart.nearbyNpcs||[]).some((n:any)=>/shop|merchant|diango/i.test(String(n.name||''))),actionStale:false,objectiveActive:true};
  const legalActions=obligationExecutor.legalActions(obs,gatedCandidates.map(c=>c.action as any),tick);
  const legalSet=new Set(legalActions);
  const blockedFingerprints=new Set<string>((brain.publicState() as any).blockedFingerprints||[]);
  let candidates=gatedCandidates.filter(c=>legalSet.has(c.action as any)&&!blockedFingerprints.has(c.fingerprint));
  candidates=candidates.filter(meaningfulWithdrawal);
  const productive=candidates.filter(c=>/^(worldSkill|walkTo|interactNpc|interactLoc|bankDeposit|shopSell|pickupItem|useInventoryItem|travelToBank|openBank)$/.test(String(c.action?.type||''))||['bank','economy','navigation-skill','pickup','world','explore','inventory'].includes(c.category));
  if(productive.length)candidates=candidates.filter(c=>!['say','wait'].includes(String(c.action?.type||'')));
  if(rawCandidates.length!==candidates.length)void log('SAFETY_GATE',{tick,gate:'hierarchical_obligation',before:rawCandidates.length,after:candidates.length,phase:obligationExecutor.status().phase,freeSlots:obs.freeSlots,groundItems:obs.groundItems.map((g:any)=>g.name).slice(0,8)});
  currentProgression=progressionDirector.plan(stateAtStart,candidates,tick);
  if(!candidates.length) return;
  const startedTick=tick;
  const startedLife=stateAtStart.player?.lifeId;
  const lease=++decisionLease;
  decisionInFlight=true;
  decisionStartedTick=startedTick;
  if(decisionWatchdog)clearTimeout(decisionWatchdog);
  decisionWatchdog=setTimeout(()=>{
    if(lease!==decisionLease||!decisionInFlight)return;
    decisionInFlight=false;
    decisionStartedTick=-1;
    nextDecisionTick=tick+1;
    currentGoal='Recover stalled cognition';
    currentWhy='The controller exceeded its body-level lease; discard the stale decision and resume with the deterministic safety path.';
    void log('AGENT_DECISION_WATCHDOG',{startedTick,lease,tick,timeoutMs:30000});
    refreshSnapshot(lastState);
  },30000);
  refreshSnapshot(stateAtStart);
  void log('AGENT_THINK',{tick:startedTick,candidates:candidates.length,agent:brain.publicState()});
  controllerRegistry.activateAtTick(startedTick);
  controllerRegistry.decide(stateAtStart,candidates,{tick:startedTick,currentTask:currentProgression.objective,externalDirective:controlState.directive}).then(choice=>{
    if(lease!==decisionLease){void log('AGENT_DECISION_STALE',{startedTick,resolvedTick:tick,reason:'body watchdog already released the decision lease'});return;}
    if(decisionWatchdog)clearTimeout(decisionWatchdog);decisionWatchdog=null;
    decisionInFlight=false;
    decisionStartedTick=-1;
    const latest=lastState;
    if(!latest?.player){nextDecisionTick=tick+2;return;}
    if(latest.player.lifeId!==startedLife||lastReflexTick>startedTick){
      void log('AGENT_DECISION_STALE',{startedTick,resolvedTick:tick,reason:'life changed or emergency reflex intervened'});
      nextDecisionTick=tick+1;return;
    }
    let freshCandidates=capacityGate(latest,lootGate(latest,buildCandidates(latest)));
    freshCandidates=freshCandidates.filter(meaningfulWithdrawal);
    const blockedByBrain=new Set<string>((brain.publicState() as any).blockedFingerprints||[]);
    const unblockedFresh=freshCandidates.filter(c=>!blockedByBrain.has(c.fingerprint));
    const usableFresh=unblockedFresh.length?unblockedFresh:freshCandidates;
    const latestPlan=progressionDirector.plan(latest,usableFresh,tick);currentProgression=latestPlan;
    const modelCandidate=usableFresh.find(c=>c.fingerprint===choice.fingerprint);
    const directedCandidate=usableFresh.find(c=>latestPlan.priorityFingerprints.includes(c.fingerprint));
    const forceProgression=progressionDirector.shouldOverride(latestPlan,directedCandidate,tick);
    const candidate=forceProgression?directedCandidate:modelCandidate;
    const effectiveChoice=forceProgression&&candidate?{...choice,source:'deterministic' as const,goal:latestPlan.objective,reason:`Deterministic progression director: ${latestPlan.reason}`,expectedOutcome:latestPlan.success,fingerprint:candidate.fingerprint,actionId:candidate.id,confidence:.98}:choice;
    if(!candidate){
      void log('AGENT_DECISION_STALE',{startedTick,resolvedTick:tick,fingerprint:choice.fingerprint,reason:'action no longer available'});
      nextDecisionTick=tick+1;return;
    }
    if(forceProgression)void log('PROGRESSION_DIRECTOR',{tick,stage:latestPlan.stage,id:latestPlan.id,objective:latestPlan.objective,action:candidate.label,success:latestPlan.success});
    executeChoice(candidate,effectiveChoice,latest);
    nextDecisionTick=tick+2;
    refreshSnapshot(latest);
  }).catch(err=>{
    if(lease===decisionLease){if(decisionWatchdog)clearTimeout(decisionWatchdog);decisionWatchdog=null;}
    decisionInFlight=false;
    decisionStartedTick=-1;
    currentGoal='Recover reasoning loop';
    currentWhy=`Agent decision failed: ${String(err).slice(0,180)}`;
    void log('AGENT_DECISION_ERROR',String(err));
    nextDecisionTick=tick+3;
  });
};

await log('SOL_AWAKE',{username,directive,architecture:'local Qwen teacher + outcome-trained student policy',teacherModel:brain.model,runNumber});

client.setOnGameTickCallback(()=>{
  tick++;
  try{
    const state=client.collectBotState(tick) as BotWorldState|null;
    if(decisionInFlight&&decisionStartedTick>=0&&tick-decisionStartedTick>35){const stalledStart=decisionStartedTick;decisionInFlight=false;decisionStartedTick=-1;decisionLease++;nextDecisionTick=tick+1;currentGoal='Recover stalled cognition';currentWhy='Tick watchdog released a decision that exceeded the body lease.';void log('AGENT_DECISION_TICK_WATCHDOG',{tick,startedTick:stalledStart,timeoutTicks:35});}
    if(actionAwaitingOutcome&&actionStartedTick>=0&&tick-actionStartedTick>35&&(!procedureInFlight||tick-actionStartedTick>120)){const actionStart=actionStartedTick;const procedure=procedureInFlight?.label||null;procedureInFlight=null;const aborted=brain.abortExperience(`body action lease exceeded ${procedure?'120':'35'} ticks after action at tick ${actionStart}`);actionAwaitingOutcome=false;actionStartedTick=-1;nextDecisionTick=tick+1;currentGoal='Recover stalled action';currentWhy='Tick watchdog discarded a pending action outcome and quarantined the stale action.';void log('AGENT_ACTION_TICK_WATCHDOG',{tick,aborted,procedure,startedTick:actionStart,timeoutTicks:procedure?'120':'35'});}

    if(!state?.player){
      currentGoal='Reconnect to world state';currentWhy='No player state is available; decisions are held until perception returns.';
      refreshSnapshot(state);return;
    }
    lastState=state;
    void pollLiveControl();
    superviseTeacher();
    if(controlState.paused){
      currentGoal='Paused by operator';currentWhy='Live control is paused; no new gameplay actions will be dispatched.';
      refreshSnapshot(state);return;
    }

    const outcome=procedureInFlight?null:brain.maybeFinishExperience(state,tick);
    if(outcome){
      actionAwaitingOutcome=false;
      actionStartedTick=-1;
      const verification=obligationExecutor.verify({type:outcome.actionType},{inventoryChanged:outcome.inventoryChanged,coinDelta:outcome.coinGain,moved:outcome.moved,success:!outcome.rejected},tick);
      if(outcome.xpGain>0||outcome.inventoryChanged||outcome.coinGain!==0){
        progressionDirector.recordVerifiedProgress();
        const evidence=[outcome.xpGain?`+${outcome.xpGain} XP`:'',outcome.inventoryChanged?'inventory changed':'',outcome.coinGain?`${outcome.coinGain>0?'+':''}${outcome.coinGain} coins`:''].filter(Boolean).join(', ')||outcome.summary;
        void durableStateStore.recordMilestone({id:`${currentProgression.id}:${tick}`,label:currentProgression.objective,tick,evidence},tick).then(next=>{durableState=next}).catch(err=>void log('MILESTONE_COMMIT_FAILED',String(err)));
        void log('PROGRESSION_MILESTONE',{tick,stage:currentProgression.stage,id:currentProgression.id,objective:currentProgression.objective,evidence});
      }
      if(outcome.category==='shop'||outcome.category==='bank'||outcome.category==='dialog'||outcome.category==='modal') economyResolution={...economyResolution,phase:verification.progressed?'idle':'transaction',noProgress:verification.noProgressAttempts,lastAction:outcome.actionType,lastProgressTick:verification.progressed?tick:economyResolution.lastProgressTick,blockedUntil:verification.blockedUntilTick,reason:verification.progressed?'Transaction verified.':'Transaction produced no measurable state change.'};
      else if(outcome.moved&&economyResolution.phase==='transaction') economyResolution={phase:'idle',noProgress:0,lastAction:null,lastProgressTick:tick,blockedUntil:0,reason:'Transaction context cleared after verified non-economy movement.'};
      feed('LEARNED_OUTCOME',outcome.summary,`Measured reward ${outcome.reward} from ${outcome.choice.source} action.`,{source:'learning',reward:outcome.reward,setCurrent:false});
      void log('AGENT_OUTCOME',{tick,reward:outcome.reward,summary:outcome.summary,source:outcome.choice.source,action:outcome.candidateLabel});
      nextDecisionTick=Math.max(nextDecisionTick,tick+1);
    }

    if(tick<=3||tick%100===0) void log('OBSERVE',{tick,pos:[state.player.worldX,state.player.worldZ,state.player.level],hp:[state.player.hp,state.player.maxHp],combatLevel:state.player.combatLevel,skills:Object.fromEntries(state.skills.map(s=>[s.name,s.level])),inventory:state.inventory.map(i=>i.name),nearbyAgents:state.nearbyPlayers.map(p=>p.name),agent:brain.publicState()});

     persistentBody.commitTick(tick,currentGoal,`${controllerRegistry.status.activeId}@${controllerRegistry.status.activeVersion}`);
     const freeSlots=Math.max(0,28-(state.inventory||[]).length);const coins=(state.inventory||[]).filter((i:any)=>isCurrency(i.name)).reduce((n:number,i:any)=>n+Number(i.count||0),0);const invSig=(state.inventory||[]).map((i:any)=>`${i.slot}:${i.id}:${i.count}`).join('|');
     const obligationKind=state.player.hp<=Math.max(8,state.player.maxHp*.32)?'survival':(state.groundItems||[]).some((g:any)=>g.reachable!==false&&!/(ash|bones|empty|junk|weed)/i.test(String(g.name||'')))?'loot-resolution':isCapacityPressure(state)?(state.bank?.isOpen||state.shop?.isOpen||state.dialog?.isOpen?'transaction':'capacity-resolution'):'objective';
     const durableFingerprint=`${tick%10===0?'checkpoint':'event'}|${obligationKind}|${state.player.worldX},${state.player.worldZ},${state.player.level}|${invSig}|${coins}|${controllerRegistry.status.activeId}@${controllerRegistry.status.activeVersion}|${currentGoal}`;
     if(durableFingerprint!==lastDurableFingerprint){lastDurableFingerprint=durableFingerprint;void durableStateStore.commit({position:{x:state.player.worldX,z:state.player.worldZ,level:state.player.level},currentObligation:{...durableState.currentObligation,kind:obligationKind as any,reason:currentWhy},objective:{...durableState.objective,label:currentGoal},inventoryLedger:{signature:invSig,freeSlots,coins,updatedTick:tick},controller:{activeId:controllerRegistry.status.activeId,activeVersion:controllerRegistry.status.activeVersion,pendingId:controllerRegistry.status.pendingId||undefined,pendingVersion:controllerRegistry.status.pendingVersion||undefined,lastSwitchTick:controllerRegistry.status.lastSwitchTick}},tick).then(next=>{durableState=next;void persistRemoteDurableState(next)}).catch(err=>void log('PERSISTENT_STATE_COMMIT_FAILED',String(err)));}
     if(!decisionInFlight&&!actionAwaitingOutcome&&tick>=nextDecisionTick) launchDecision(state);
    refreshSnapshot(state);
  }catch(err){void log('TICK_ERROR',String(err));}
});

await Bun.sleep(RUN_MS);
client.setOnGameTickCallback(null);
refreshSnapshot(lastState);
await brain.save(true);
const finalState:BotWorldState|null=lastState as BotWorldState|null;
await log('SOL_HANDOFF',{ticks:tick,actions,agent:brain.publicState(),final:finalState?{player:finalState.player,skills:Object.fromEntries(finalState.skills.map(s=>[s.name,s.level])),inventory:finalState.inventory.map(i=>({name:i.name,count:i.count}))}:null});
session.stop();
await session.stopped;
server.stop(true);
