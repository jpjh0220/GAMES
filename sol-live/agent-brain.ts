import type { BotWorldState } from './src/bot/types.js';
import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { PrerequisiteTracker } from './prerequisites.js';
import { GoalSystem } from './goals.js';
import { EconomyModel } from './economy.js';
import { SkillTree } from './skill-tree.js';
import { QuestSystem } from './quest-system.js';
import { TradeInference } from './trade-inference.js';
import { GoalDecomposer } from './goal-decomposition.js';

export type AgentCandidate = {
  id:string; label:string; category:string; fingerprint:string; action:any;
  tags?:string[]; settleTicks?:number;
};

export type AgentChoice = {
  source:'teacher'|'student'; goal:string; reason:string; expectedOutcome:string;
  actionId:string; speech?:string; confidence:number; contextKey:string; fingerprint:string;
  followUp?:string[]; planNote?:string;
};

type PolicyStat = {
  n:number; avgReward:number; positive:number; negative:number; lastReward:number;
  lastAt:string; exampleGoal:string; exampleReason:string;
};

type MemoryEntry = {
  id:string; createdAt:string; tick:number; runNumber:number|null;
  kind:'episode'|'strategy'|'relationship'|'place'; text:string; importance:number;
  tags:string[]; location?:{x:number;z:number;level:number};
};

type Strategy = {
  focus:string; reason:string; risk:'low'|'balanced'|'high'; priorities:string[]; avoid:string[];
  updatedAt:string; sourceModel:string; objective?:string;
  plan?:{id:string;label:string;status:'pending'|'active'|'done'|'blocked';evidence?:string}[];
  successSignals?:string[]; failures?:number;
};

type Relationship = {
  name:string;firstSeenAt:string;lastSeenAt:string;encounters:number;combatLevel?:number;
  trust:number;stance:'unknown'|'friendly'|'cooperative'|'cautious'|'distrusted';
  conversations:number;cooperation:number;suspicion:number;
  facts:string[];questions:string[];lastMessages:{at:string;direction:'incoming'|'outgoing';text:string}[];
};

type SequenceStat = {sequence:string[];n:number;avgReward:number;positive:number;lastAt:string;example:string};

type PersistentState = {
  version:number;
  identity:{name:string;bornAt:string;directive:string};
  lifetime:{
    totalChoices:number;teacherChoices:number;studentChoices:number;reflexActions:number;
    completedExperiences:number;totalReward:number;saves:number;
    shadowPredictions?:number;shadowMatches?:number;strategistRefreshes?:number;strategistFailures?:number;
    studentDecisions?:number;studentPromotions?:number;
  };
  memories:MemoryEntry[];
  policy:Record<string,Record<string,PolicyStat>>;
  relationships:Record<string,Relationship>;
  places:Record<string,{key:string;x:number;z:number;level:number;firstSeenAt:string;lastSeenAt:string;visits:number;npcs:string[];locs:string[]}>;
  sequences:Record<string,SequenceStat>;
  discoveries:{id:string;at:string;kind:'route'|'resource'|'npc'|'danger'|'place';text:string;location?:{x:number;z:number;level:number};confidence:number}[];
  activePlan?:Strategy|null;
  updatedAt:string;
};

type Metrics = {
  hp:number;maxHp:number;lifeId:number;x:number;z:number;level:number;
  totalXp:number;totalLevels:number;inventoryCount:number;coins:number;
  inventorySig:string;equipmentSig:string;combatStyleSig:string;
  npcNames:Set<string>;playerNames:Set<string>;locNames:Set<string>;opRejectedCount:number;
};

type Experience = {choice:AgentChoice;candidate:AgentCandidate;startTick:number;settleTick:number;before:Metrics};

export type AgentOutcome = {
  tick:number;reward:number;summary:string;choice:AgentChoice;candidateLabel:string;
  xpGain:number;hpDelta:number;moved:boolean;kills:number;damageDealt:number;
  damageTaken:number;newThings:string[];rejected:boolean;inventoryChanged:boolean;
  equipmentChanged:boolean;styleChanged:boolean;executionFailed:boolean;
};

const now=()=>new Date().toISOString();
const clamp=(n:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,n));
const uniq=<T>(xs:T[])=>[...new Set(xs)];
const norm=(s:string)=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const toks=(s:string)=>new Set(norm(s).split(/\s+/).filter(x=>x.length>2));
const parseModelJson=(value:unknown)=>{
  const raw=String(value||'').replace(/^\s*```(?:json)?/i,'').replace(/```\s*$/,'').trim();
  try{return JSON.parse(raw)}catch{}
  const start=raw.indexOf('{');if(start<0)throw new Error('model returned no JSON object');
  let text=raw.slice(start),depth=0,inString=false,escape=false,lastComplete=-1;
  for(let i=0;i<text.length;i++){const c=text[i];if(escape){escape=false;continue}if(c==='\\'&&inString){escape=true;continue}if(c==='"'){inString=!inString;continue}if(inString)continue;if(c==='{')depth++;else if(c==='}'&&--depth===0){lastComplete=i;break}}
  if(lastComplete>=0)text=text.slice(0,lastComplete+1);else{text=text.replace(/[,\s:]+$/,'');if(inString)text+='"';text+='}'.repeat(Math.max(1,depth));}
  return JSON.parse(text);
};

const freshState=(name:string,directive:string):PersistentState=>({
  version:1,
  identity:{name,bornAt:now(),directive},
  lifetime:{totalChoices:0,teacherChoices:0,studentChoices:0,reflexActions:0,completedExperiences:0,totalReward:0,saves:0,shadowPredictions:0,shadowMatches:0,strategistRefreshes:0,strategistFailures:0},
  memories:[],policy:{},relationships:{},places:{},sequences:{},discoveries:[],updatedAt:now()
});

export class SolAgentBrain {
  private memory:PersistentState;
  private pending:Experience|null=null;
  private githubSha:string|null=null;
  private dirty=false;
  private dirtyRevision=0;
  private lastSaveAt=0;
  private persistenceLoaded=false;
  private persistenceLoadedAt:string|null=null;
  private loadOutcome:'pending'|'loaded'|'absent'|'malformed'|'error'|'unconfigured'='pending';
  private loadError:string|null=null;
  private saveBlockedLogged=false;
  private lastSaveSucceededAt:string|null=null;
  private lastSaveError:string|null=null;
  private saveFailures=0;
  private saveInFlight:Promise<boolean>|null=null;
  private motorReady=false;
  private strategistReady=false;
  private motorFailures=0;
  private strategistInFlight=false;
  private lastStrategistError:string|null=null;
  private strategy:Strategy|null=null;
  private sessionMotorChoices=0;
  private lastStrategySessionChoice=-9999;
  private lastChoice:AgentChoice|null=null;
  private lastOutcome:AgentOutcome|null=null;
  private lastShadowPrediction:AgentChoice|null=null;
  private recentOutcomes:AgentOutcome[]=[];
  private repoKnowledge:{source:string;text:string}[]=[];
  private gameplayCurriculum='';
  private blockedFingerprints:string[]=[];
  private prereqs=new PrerequisiteTracker();
  private paidResolutions=new Set<string>();
  private goals=new GoalSystem();
  private economy=new EconomyModel();
  private skillTree=new SkillTree();
  private quests=new QuestSystem();
  private trades=new TradeInference();
  private decomposer=new GoalDecomposer();
  private stagnationCounter=new Map<string,number>();
  private recentActions:string[]=[];
  private lastGoalReeval:number=0;
  private lastRecommendedActivity:string='';
  private lastRecommendedProfit:number=0;
  private lastArbitrageKey:string='';
  // Planner is opt-in because, measured, it hurt: see the note in decide().
  private plannerEnabled:boolean=String(process.env.SOL_PLANNER||'')==='1';
  private goalTickBudget:number=400;
  private goalTicksRemaining:number=0;
  private goalFormCooldown:number=40;
  private lastGoalFormedAt:number=-9999;
  private posHistory:string[]=[];
  private lastTelemetryAt:number=0;
  private lastTelemetryXp:number=0;
  private lastStudentChoice:AgentChoice|null=null;
  private studentDecisionOutcomes:{choice:string;reward:number}[]=[];
  private seenMessages=new Set<string>();
  private currentGuidance:string[]=[];
  private externalDirective:string|null=null;
  private recentSequence:{fingerprint:string;label:string;reward:number}[]=[];
  private replay:{tick:number;perception:string;retrieved:string[];prediction:string|null;decision:string|null;action:string|null;outcome:string|null;lesson:string|null}[]=[];
  private lastAutonomousProposal:{goal:string;action:string;followUp:string[];planNote:string;speech:string;at:string}|null=null;

  constructor(private readonly opts:{
    name:string;directive:string;motorModel?:string;strategistModel?:string;model?:string;
    ollamaUrl?:string;githubToken?:string;githubRepo?:string;runNumber?:number|null;
  }){this.memory=freshState(opts.name,opts.directive);}

  get model(){return this.motorModel;}
  get motorModel(){return this.opts.motorModel||'qwen3:0.6b';}
  get strategistModel(){return this.opts.strategistModel||this.opts.model||'qwen3:1.7b';}
  get ollamaUrl(){return this.opts.ollamaUrl||'http://127.0.0.1:11434';}

  applyExternalDirective(directive:string|null){
    const next=String(directive||'').trim().slice(0,300)||null;
    if(next===this.externalDirective)return;
    this.externalDirective=next;
    if(next){this.strategy=null;this.memory.activePlan=null;this.lastStrategySessionChoice=-9999;this.markDirty();console.log('AGENT_EXTERNAL_DIRECTIVE',JSON.stringify({directive:next}));}
  }

  async init(){
    await this.load();
    await this.loadRepoKnowledge();
    await this.refreshAvailability();
  }

  private async loadRepoKnowledge(){
    const root=join(process.cwd(),'..','..');
    const files:{path:string;source:string}[]=[];
    try{
      const dir=join(root,'learnings');
      for(const name of await readdir(dir)){if(name.endsWith('.md'))files.push({path:join(dir,name),source:`learnings/${name}`});}
    }catch(err){console.warn('RS_KNOWLEDGE_LEARNINGS_FAILED',String(err));}
    for(const [rel,path] of [['README.md',join(root,'README.md')],['sdk/API.md',join(root,'sdk','API.md')]] as const)files.push({path,source:rel});
    const segments:{source:string;text:string}[]=[];
    for(const file of files){
      try{
        const raw=await readFile(file.path,'utf8');
        const parts=raw.split(/\n(?=#{1,4}\s)/g);
        for(const part of parts){
          const clean=part.replace(/```[\s\S]*?```/g,m=>m.slice(0,900)).replace(/\s+/g,' ').trim();
          if(clean.length<40)continue;
          for(let i=0;i<clean.length;i+=1200){const chunk=clean.slice(i,i+1400);if(chunk.length>=40)segments.push({source:file.source,text:chunk});}
        }
      }catch(err){console.warn('RS_KNOWLEDGE_FILE_FAILED',file.source,String(err));}
    }
    this.repoKnowledge=segments.slice(0,700);
    const lessonNames=[...new Set(this.repoKnowledge.filter(x=>x.source.startsWith('learnings/')).map(x=>basename(x.source,'.md')))];
    this.gameplayCurriculum=[
      'You are inside a persistent RuneScape-style MMO, not a chat simulation. Play it through executable actions.',
      'Core loop: inspect live state, choose a durable objective, identify prerequisites, act, verify state/XP/inventory/dialog changes, and adapt.',
      'Progress through connected chains: obtain resources, process them, gain levels, earn or save coins, improve equipment, unlock stronger activities, and explore.',
      'Dispatch is not success. Observed movement, XP, inventory, combat, dialog, or world changes are evidence. Repeated failure means diagnose a prerequisite or change approach.',
      `Repository lessons available: ${lessonNames.join(', ')}.`
    ].join(' ');
    console.log('RS_REPO_KNOWLEDGE_READY',JSON.stringify({segments:this.repoKnowledge.length,sources:new Set(this.repoKnowledge.map(x=>x.source)).size}));
  }

  private retrieveRepoGuidance(state:BotWorldState,candidates:AgentCandidate[],limit=2,maxChars=380){
    if(!this.repoKnowledge.length)return [];
    const p=state.player;
    const query=[
      this.strategy?.focus||'',
      ...(state.skills||[]).filter(x=>x.level<15).map(x=>x.name),
      ...(state.inventory||[]).slice(0,12).map(x=>x.name),
      ...(state.nearbyNpcs||[]).slice(0,10).map(x=>x.name),
      ...(state.nearbyLocs||[]).slice(0,12).map(x=>x.name),
      ...candidates.slice(0,12).flatMap(c=>[c.category,c.label,...(c.tags||[])])
    ].join(' ');
    const q=toks(query);
    const categories=new Set(candidates.map(c=>c.category)),preferred=new Set<string>();
    const prefer=(...names:string[])=>names.forEach(n=>preferred.add(`learnings/${n}.md`));
    if(categories.has('combat'))prefer('combat');if(categories.has('bank'))prefer('banking');if(categories.has('shop'))prefer('shops');
    if(categories.has('social'))prefer('chat','dialogs');if(categories.has('explore'))prefer('walking','draynor-manor');
    for(const c of candidates){const hay=`${c.label} ${(c.tags||[]).join(' ')}`.toLowerCase();if(/tree|woodcut|axe/.test(hay))prefer('woodcutting');if(/fish|net|rod/.test(hay))prefer('fishing');if(/rock|ore|mining|pickaxe/.test(hay))prefer('mining');if(/cook|range|fire/.test(hay))prefer('cooking');if(/thiev|pickpocket/.test(hay))prefer('thieving');}
    return this.repoKnowledge.map((seg,i)=>{
      const st=toks(`${basename(seg.source,'.md')} ${seg.text}`);let overlap=0;for(const t of q)if(st.has(t))overlap++;
      const exact=[...q].some(t=>t.length>5&&seg.text.toLowerCase().includes(t))?1:0;
      const api=seg.source==='sdk/API.md'?.3:0;
      return{seg,score:overlap*2+exact+api+(preferred.has(seg.source)?8:0)+i/100000};
    }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>`${x.seg.source}: ${x.seg.text.slice(0,maxChars)}`);
  }

  private async refreshAvailability(){
    try{
      const r=await fetch(`${this.ollamaUrl}/api/tags`,{signal:AbortSignal.timeout(4000)});
      if(!r.ok){this.motorReady=false;this.strategistReady=false;return;}
      const j:any=await r.json();const names=(j.models||[]).map((m:any)=>String(m.name||''));
      this.motorReady=names.some((n:string)=>n===this.motorModel||n.startsWith(this.motorModel+'-'));
      this.strategistReady=names.some((n:string)=>n===this.strategistModel||n.startsWith(this.strategistModel+'-'));
    }catch{this.motorReady=false;this.strategistReady=false;}
  }

  private async load(){
    if(!this.opts.githubToken||!this.opts.githubRepo){this.loadOutcome='unconfigured';console.warn('AGENT_MEMORY_LOAD_SKIPPED unconfigured');return;}
    try{
      const r=await fetch(`https://api.github.com/repos/${this.opts.githubRepo}/contents/sol-agent/state.json?ref=sol-memory&t=${Date.now()}`,{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.opts.githubToken}`,'X-GitHub-Api-Version':'2022-11-28'}});
      if(r.status===404){this.loadOutcome='absent';console.warn('AGENT_MEMORY_LOAD_ABSENT no archive on sol-memory yet');return;}
      if(!r.ok)throw new Error(`memory load ${r.status}`);
      const body:any=await r.json();this.githubSha=body.sha||null;
      // The Contents API refuses to inline files over 1MB: it returns
      // encoding:'none' with an empty content field. state.json crossed that
      // line, so every load silently decoded to '' and threw "Unexpected EOF",
      // discarding all accumulated learning on every restart. The Git Blobs
      // API serves the same object up to 100MB, so fall back to it.
      let contentB64=String(body.content||'');
      if(!contentB64.trim()&&this.githubSha){
        console.warn('AGENT_MEMORY_LOAD_OVERSIZE',JSON.stringify({size:body.size,encoding:body.encoding,via:'git/blobs'}));
        const rb=await fetch(`https://api.github.com/repos/${this.opts.githubRepo}/git/blobs/${this.githubSha}`,{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.opts.githubToken}`,'X-GitHub-Api-Version':'2022-11-28'}});
        if(!rb.ok)throw new Error(`memory blob load ${rb.status}`);
        const blob:any=await rb.json();contentB64=String(blob.content||'');
        if(!contentB64.trim())throw new Error('blob returned empty content');
      }
      const parsed=JSON.parse(Buffer.from(contentB64.replace(/\n/g,''),'base64').toString('utf8'));
      if(parsed?.version===1&&parsed?.identity&&parsed?.lifetime){
        this.memory=parsed;this.memory.identity.directive=this.opts.directive;
        this.memory.lifetime.shadowPredictions??=0;this.memory.lifetime.shadowMatches??=0;
        this.memory.lifetime.strategistRefreshes??=0;this.memory.lifetime.strategistFailures??=0;
        this.memory.memories||=[];this.memory.policy||={};this.memory.relationships||={};this.memory.places||={};this.memory.sequences||={};this.memory.discoveries||=[];this.strategy=this.memory.activePlan||null;
        for(const [key,r] of Object.entries(this.memory.relationships)){const x:any=r;x.trust??=0;x.stance??='unknown';x.conversations??=0;x.cooperation??=0;x.suspicion??=0;x.facts??=[];x.questions??=[];x.lastMessages??=[];this.memory.relationships[key]=x;}
        this.persistenceLoaded=true;this.persistenceLoadedAt=now();this.loadOutcome='loaded';this.lastSaveError=null;
        console.log('AGENT_MEMORY_LOADED',JSON.stringify({experiences:this.memory.lifetime?.completedExperiences,memories:this.memory.memories?.length,policies:Object.keys(this.memory.policy||{}).length}));
      }else{
        this.loadOutcome='malformed';this.loadError=`unexpected shape: version=${String(parsed?.version)} identity=${!!parsed?.identity} lifetime=${!!parsed?.lifetime}`;
        console.warn('AGENT_MEMORY_LOAD_MALFORMED',this.loadError);
      }
    }catch(err){this.loadOutcome='error';this.loadError=String(err).slice(0,240);this.lastSaveError=`load: ${String(err).slice(0,240)}`;console.warn('AGENT_MEMORY_LOAD_FAILED',String(err));}
  }

  async save(force=false){
    if(!this.opts.githubToken||!this.opts.githubRepo||!this.dirty)return false;
    // An archive exists but we could not read it. Writing now would replace accumulated
    // cross-run learning with this run's cold-start numbers. Refuse until a human resolves it.
    if(!this.persistenceLoaded&&this.loadOutcome!=='absent'){
      if(!this.saveBlockedLogged){this.saveBlockedLogged=true;console.error('AGENT_MEMORY_SAVE_BLOCKED',JSON.stringify({loadOutcome:this.loadOutcome,loadError:this.loadError,reason:'refusing to overwrite an archive that failed to load'}));}
      this.lastSaveError=`save blocked: archive present but load ${this.loadOutcome}`;
      return false;
    }
    if(!force&&Date.now()-this.lastSaveAt<5*60_000&&this.memory.lifetime.completedExperiences%10!==0)return false;
    if(this.saveInFlight)return force?await this.saveInFlight:false;
    this.saveInFlight=this.persistWithRetry();
    try{return await this.saveInFlight}finally{this.saveInFlight=null;}
  }

  private async persistWithRetry(){
    const savingRevision=this.dirtyRevision;
    const priorSaves=this.memory.lifetime.saves;
    this.memory.lifetime.saves=priorSaves+1;
    for(let attempt=1;attempt<=3;attempt++){
      try{
        const savedAt=now();this.memory.updatedAt=savedAt;
        const payload:any={message:`Persist Sol AI demonstrations (${this.memory.lifetime.completedExperiences} experiences)`,content:Buffer.from(JSON.stringify(this.memory,null,2)+'\n').toString('base64'),branch:'sol-memory'};
        if(this.githubSha)payload.sha=this.githubSha;
        const r=await fetch(`https://api.github.com/repos/${this.opts.githubRepo}/contents/sol-agent/state.json`,{method:'PUT',headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.opts.githubToken}`,'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},body:JSON.stringify(payload)});
        if(r.status===409||r.status===422){await this.refreshPersistenceSha();await Bun.sleep(350*attempt);continue;}
        if(!r.ok)throw new Error(`memory save ${r.status}: ${(await r.text()).slice(0,300)}`);
        const body:any=await r.json();this.githubSha=body?.content?.sha||this.githubSha;this.lastSaveAt=Date.now();this.lastSaveSucceededAt=savedAt;this.lastSaveError=null;this.saveFailures=0;this.dirty=this.dirtyRevision!==savingRevision;return true;
      }catch(err){this.saveFailures++;this.lastSaveError=`save attempt ${attempt}: ${String(err).slice(0,240)}`;console.warn('AGENT_MEMORY_SAVE_FAILED',this.lastSaveError);if(attempt<3)await Bun.sleep(500*attempt);}
    }
    this.memory.lifetime.saves=priorSaves;
    return false;
  }

  private async refreshPersistenceSha(){
    const r=await fetch(`https://api.github.com/repos/${this.opts.githubRepo}/contents/sol-agent/state.json?ref=sol-memory&t=${Date.now()}`,{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.opts.githubToken}`,'X-GitHub-Api-Version':'2022-11-28'}});
    if(!r.ok)throw new Error(`memory conflict refresh ${r.status}`);
    const body:any=await r.json();this.githubSha=body.sha||null;
  }

  private markDirty(){this.dirty=true;this.dirtyRevision++;}

  noteReflex(){this.memory.lifetime.reflexActions++;this.markDirty();}

  private observe(state:BotWorldState){
    const t=now();
    for(const p of state.nearbyPlayers||[]){
      const k=norm(p.name);if(!k)continue;const old=this.memory.relationships[k];
      this.memory.relationships[k]=old?{...old,lastSeenAt:t,encounters:old.encounters+1,combatLevel:p.combatLevel}:{name:p.name,firstSeenAt:t,lastSeenAt:t,encounters:1,combatLevel:p.combatLevel,trust:0,stance:'unknown',conversations:0,cooperation:0,suspicion:0,facts:[],questions:[],lastMessages:[]};
    }
    for(const m of (state.gameMessages||[]) as any[]){
      const text=String(m.text||'').trim(),sender=String(m.sender||'').trim();if(!text)continue;
      const id=`${m.observationId??''}:${m.tick??''}:${sender}:${text}`;if(this.seenMessages.has(id))continue;this.seenMessages.add(id);if(this.seenMessages.size>500)this.seenMessages=new Set([...this.seenMessages].slice(-300));
      for(const b of this.prereqs.observe(text,Number(m.tick)||0,this.lastChoice?.fingerprint))console.log('AGENT_PREREQ_LEARNED',JSON.stringify({requirement:b.requirement,level:b.level,evidence:b.evidence,subgoal:b.subgoal}));
      const incoming=!m.fromSelf&&!!sender,person=norm(incoming?sender:this.opts.name);if(incoming&&person){
        const old=this.memory.relationships[person]||{name:sender,firstSeenAt:t,lastSeenAt:t,encounters:1,combatLevel:undefined,trust:0,stance:'unknown',conversations:0,cooperation:0,suspicion:0,facts:[],questions:[],lastMessages:[]};
        const helpful=/\b(help|guide|give|spare|need|try|use|find|at|near|buy|sell)\b/i.test(text),risky=/\b(scam|kill|attack|steal|lure|trust me|drop all)\b/i.test(text);
        const trust=clamp(old.trust+(helpful ? .12 : 0)-(risky ? .28 : 0),-1,1),stance=trust>.45?'cooperative':trust>.12?'friendly':trust<-.35?'distrusted':trust<-.08?'cautious':'unknown';
        this.memory.relationships[person]={...old,name:sender,lastSeenAt:t,conversations:old.conversations+1,cooperation:old.cooperation+(helpful?1:0),suspicion:old.suspicion+(risky?1:0),trust:Number(trust.toFixed(2)),stance,facts:uniq([...old.facts,text]).slice(-20),questions:text.includes('?')?uniq([...old.questions,text]).slice(-12):old.questions,lastMessages:[...old.lastMessages,{at:t,direction:'incoming' as const,text}].slice(-20)};
        this.addMemory({kind:'relationship',text:`${sender} said: "${text}". Current stance ${stance}, trust ${trust.toFixed(2)}.`,importance:helpful||risky?1.4:.8,tags:['social',sender,stance,...(helpful?['potential-help']:[]),...(risky?['risk']:[])],tick:Number(m.tick)||0,state});
      }else if(m.fromSelf){
        for(const p of state.nearbyPlayers||[]){const k=norm(p.name),old=this.memory.relationships[k];if(old)old.lastMessages=[...old.lastMessages,{at:t,direction:'outgoing' as const,text}].slice(-20);}
      }
    }
    if(state.player){
      const{worldX:x,worldZ:z,level}=state.player;const k=`${Math.floor(x/16)}:${Math.floor(z/16)}:${level}`;
      const npcs=uniq((state.nearbyNpcs||[]).map(n=>n.name).filter(Boolean)).slice(0,20);
      const locs=uniq((state.nearbyLocs||[]).map(l=>l.name).filter(Boolean)).slice(0,30);const old=this.memory.places[k];
      this.memory.places[k]=old?{...old,x,z,lastSeenAt:t,visits:old.visits+1,npcs:uniq([...old.npcs,...npcs]).slice(-30),locs:uniq([...old.locs,...locs]).slice(-40)}:{key:k,x,z,level,firstSeenAt:t,lastSeenAt:t,visits:1,npcs,locs};
      for(const name of [...npcs,...locs]){const kind=/tree|rock|ore|fish|range|bank|shop/i.test(name)?'resource':/dragon|demon|skeleton|guard/i.test(name)?'danger':npcs.includes(name)?'npc':'place';const id=`${kind}:${norm(name)}:${k}`;if(!this.memory.discoveries.some(d=>d.id===id))this.memory.discoveries.push({id,at:t,kind:kind as any,text:`${name} observed near ${x}, ${z}, level ${level}.`,location:{x,z,level},confidence:.7});}
      if(this.memory.discoveries.length>300)this.memory.discoveries.splice(0,this.memory.discoveries.length-300);
    }
    this.markDirty();
  }

  private contextKey(state:BotWorldState,candidates:AgentCandidate[]){
    const p=state.player!;const ratio=p.maxHp?p.hp/p.maxHp:1;const hp=ratio<.35?'critical':ratio<.65?'hurt':'healthy';
    const food=(state.inventory||[]).some(i=>i.optionsWithIndex?.some(o=>/^eat$|^drink$/i.test(o.text)))?1:0;
    const cats=uniq(candidates.map(c=>c.category)).sort().slice(0,12).join(',');
    const area=`${Math.floor(p.worldX/8)}:${Math.floor(p.worldZ/8)}:${p.level}`;
    return`area=${area}|hp=${hp}|combat=${p.combat?.inCombat?1:0}|agents=${(state.nearbyPlayers?.length||0)>0?1:0}|food=${food}|dialog=${state.dialog?.isOpen?1:0}|bank=${state.bank?.isOpen?1:0}|shop=${state.shop?.isOpen?1:0}|cats=${cats}`;
  }

  private antiLoopCandidates(candidates:AgentCandidate[]){
    const recentOutcomes=this.recentOutcomes.slice(-10);
    const blocked=new Set<string>();
    for(const c of candidates){
      const attempts=recentOutcomes.filter(o=>o.choice.fingerprint===c.fingerprint).slice(-4);
      if(attempts.length<2)continue;
      const avg=attempts.reduce((n,o)=>n+o.reward,0)/attempts.length;
      const failures=attempts.filter(o=>o.reward<0||o.rejected).length;
      if(failures>=2&&avg<0)blocked.add(c.fingerprint);
      const configurationOnly=attempts.some(o=>(o.equipmentChanged||o.styleChanged)&&!o.moved&&o.xpGain===0&&o.kills===0&&o.damageDealt===0);
      if(configurationOnly)blocked.add(c.fingerprint);
    }
    const last=recentOutcomes.at(-1);
    if(last&&last.reward<0)blocked.add(last.choice.fingerprint);
    // Engine-stated prerequisites. Clear any that are now satisfied, then bar the rest.
    // Bar candidates the engine has already refused. Resolution of blockers
    // happens in maybeFinishExperience, which has the world state; this path
    // only reads the already-resolved blocker set.
    for(const c of candidates){if(this.prereqs.isBlocked(c.fingerprint))blocked.add(c.fingerprint);}

    // Sequence-level anti-loop gating. Individual actions such as fishing,
    // clicking a dialog, and withdrawing coins may each look legal, while their
    // repeated combination produces no durable progress. Use persisted sequence
    // statistics plus a short live streak to force a different category.
    const recentFingerprints=this.recentSequence.slice(-3).map(x=>x.fingerprint);
    for(const c of candidates){
      const key=[...recentFingerprints.slice(-2),c.fingerprint].join(' > ');
      const learned=this.memory.sequences[key];
      if(learned&&learned.n>=4&&learned.avgReward<-.4)blocked.add(c.fingerprint);
      const sameStreak=recentFingerprints.length>=2&&recentFingerprints.slice(-2).every(fp=>fp===c.fingerprint);
      if(sameStreak)blocked.add(c.fingerprint);
      const fishingStreak=recentFingerprints.filter(fp=>/fishing|bait|net|dialog/.test(fp)).length;
      if(fishingStreak>=2&&/fishing|bait|net|dialog/.test(c.fingerprint))blocked.add(c.fingerprint);
      const bankStreak=recentFingerprints.filter(fp=>fp.startsWith('bank:')).length;
      if(bankStreak>=2&&c.fingerprint.startsWith('bank:'))blocked.add(c.fingerprint);
    }
    const filtered=candidates.filter(c=>!blocked.has(c.fingerprint));
    const escape=filtered.filter(c=>/^(navigation-skill|explore|combat|recovery)$/.test(c.category));
    this.blockedFingerprints=[...blocked];
    return escape.length?escape:(filtered.length?filtered:candidates);
  }

  private shadowPrediction(candidates:AgentCandidate[],contextKey:string):AgentChoice|null{
    const stats=this.memory.policy[contextKey];if(!stats)return null;let best:{c:AgentCandidate;s:PolicyStat;confidence:number}|null=null;
    for(const c of candidates){
      if(c.category==='say'||c.category==='wait')continue;const s=stats[c.fingerprint];if(!s||s.n<2)continue;
      const success=s.positive/Math.max(1,s.n);const confidence=clamp((s.n/8)*.35+success*.4+clamp((s.avgReward+1)/3,0,1)*.25,0,1);
      if(s.avgReward<.05||confidence<.52)continue;
      if(!best||confidence>best.confidence||(confidence===best.confidence&&s.avgReward>best.s.avgReward))best={c,s,confidence};
    }
    if(!best)return null;
    return{source:'student',goal:best.s.exampleGoal||'Predict AI motor',reason:`Shadow learner predicts this from ${best.s.n} AI demonstrations, avg reward ${best.s.avgReward.toFixed(2)}.`,expectedOutcome:'Prediction only; AI motor still decides.',actionId:best.c.id,confidence:best.confidence,contextKey,fingerprint:best.c.fingerprint};
  }

  private relevantMemories(state:BotWorldState,candidates:AgentCandidate[]){
    const query=[...(state.nearbyNpcs||[]).map(n=>n.name),...(state.nearbyPlayers||[]).map(p=>p.name),...candidates.slice(0,10).map(c=>c.label)].join(' ');const q=toks(query);
    return this.memory.memories.map((m,i)=>{const mt=toks(`${m.text} ${m.tags.join(' ')}`);let overlap=0;for(const x of q)if(mt.has(x))overlap++;return{m,score:m.importance*2+overlap+i/Math.max(1,this.memory.memories.length)};}).sort((a,b)=>b.score-a.score).slice(0,3).map(x=>x.m.text.slice(0,180));
  }

  private balancedCandidates(candidates:AgentCandidate[]){
    const productive=candidates.some(c=>c.category!=='wait')?candidates.filter(c=>c.category!=='wait'):candidates;
    const order=['dialog','modal','recovery','navigation-skill','combat','economy','pickup','social','world','inventory','combat-style','explore','wait'];
    const out:AgentCandidate[]=[];const seen=new Set<string>();
    const add=(candidate:AgentCandidate)=>{if(out.length>=12||seen.has(candidate.fingerprint))return;seen.add(candidate.fingerprint);out.push(candidate);};
    for(const category of order)for(const c of productive.filter(x=>x.category===category).slice(0,2))add(c);
    for(const c of productive)add(c);
    if(!out.length&&candidates.length)add(candidates[0]);
    return out;
  }

  async decide(state:BotWorldState,candidates:AgentCandidate[]):Promise<AgentChoice>{
    const decisionStarted=Date.now();
    this.observe(state);this.emitTelemetry(state,state.tick||0);
    const gated=this.antiLoopCandidates(candidates);let legal=this.balancedCandidates(gated);
    const p=state.player!;const hpRatio=p.maxHp?p.hp/p.maxHp:1;
    const emergency=hpRatio<.45||!!p.combat?.inCombat;
    const goalText=`${this.externalDirective||''} ${this.strategy?.focus||''} ${this.strategy?.objective||''} ${(this.strategy?.plan||[]).find(x=>x.status==='active')?.label||''}`.toLowerCase();
    const leaveFishing=/\b(leave|abandon|avoid|outside|stop|break)\b/.test(goalText)&&/\b(fish|fishing|bait|bank)\b/.test(goalText);
    if(leaveFishing){legal=legal.filter(c=>!/(fishing|bait|net|bank:)/.test(c.fingerprint));if(!legal.length)legal=this.balancedCandidates(gated.filter(c=>c.category!=='wait'&&!/(fishing|bait|net|bank:)/.test(c.fingerprint)));}
    const escape=legal.filter(c=>c.fingerprint==='skill:escape-draynor-manor');
    const travel=legal.filter(c=>c.category==='navigation-skill'&&c.fingerprint.startsWith('skill:'));
    const travelGoal=/travel|escape|bank|fishing|route|landmark|progress/.test(goalText);
    // If a verified route exists for the active objective, do not let the motor
    // spend the turn on a combat-style toggle or wait. Emergency recovery/combat
    // remains eligible so survival always wins over the route.
    if(!emergency&&escape.length)legal=escape;
    else if(!emergency&&travelGoal&&travel.length)legal=travel;
    const contextKey=this.contextKey(state,legal);this.lastShadowPrediction=this.shadowPrediction(legal,contextKey);
    console.log('AGENT_CANDIDATE_GATE',JSON.stringify({raw:candidates.length,afterAntiLoop:gated.length,allowed:legal.length,categories:uniq(legal.map(c=>c.category))}));
    this.maybeRefreshStrategy(state,legal);
    if(this.plannerEnabled)this.maybeReevaluateGoal(state,500);
    if(!this.motorReady){await this.refreshAvailability();if(!this.motorReady)throw new Error(`AI motor unavailable: ${this.motorModel}`);}
    // ---------------------------------------------------------------
    // PLANNER LAYER (opt-in, default OFF).
    //
    // Everything below was added speculatively and measured WORSE than the
    // motor alone: run 70 managed 11 actions/1000 ticks against run 48's 145.
    // Two structural faults caused it:
    //   1. this else-branch ran on EVERY decide() with no active step, so it
    //      built and adopted a fresh Goal object every tick.
    //   2. once a goal had a targetAction the filter hard-gated candidates,
    //      and since no step ever carried a successCondition the goal never
    //      completed, so the motor stayed straitjacketed for the whole run.
    // Default off until a measured run shows it beats the motor. Enable with
    // SOL_PLANNER=1.
    // ---------------------------------------------------------------
    let filteredCandidates=legal;
    if(this.plannerEnabled){
      const activeGoalStep=this.goals.currentStep();
      if(activeGoalStep?.targetAction){
        // Advisory, not a hard gate: a goal may only narrow the candidate set
        // while it still has budget, and never down to nothing.
        if(this.goalTicksRemaining>0){
          const goalFiltered=legal.filter(c=>c.fingerprint===activeGoalStep.targetAction||c.fingerprint.startsWith(activeGoalStep.targetAction+':'));
          if(goalFiltered.length>0)filteredCandidates=goalFiltered;
          this.goalTicksRemaining--;
        }else{
          console.log('AGENT_GOAL_EXPIRED',JSON.stringify({step:activeGoalStep.description}));
          this.goals.failGoal('goal budget exhausted without completion');
        }
      }else if(this.sessionMotorChoices-this.lastGoalFormedAt>=this.goalFormCooldown){
        // Form at most one goal per cooldown window, not one per tick.
        this.lastGoalFormedAt=this.sessionMotorChoices;
        this.goalTicksRemaining=this.goalTickBudget;
        const skillLevels:Record<string,number>={};
        for(const sk of (state.skills||[]) as any[])skillLevels[String(sk.name||'').toLowerCase()]=Number(sk.level)||0;
        const bestActivity=this.economy.getBestActivityFor('money');
        if(bestActivity&&this.canPursueActivity(skillLevels,bestActivity.name)){
          this.goals.adoptGoal(this.goals.createGoal(`Focus on ${bestActivity.name}`,`Pursue ${bestActivity.name}`,
            [{id:'activity',description:`Execute ${bestActivity.name}`,targetAction:bestActivity.name.split(' ')[0]?.toLowerCase()}],'medium'));
          console.log('AGENT_GOAL_FORMED',JSON.stringify({goal:bestActivity.name,budget:this.goalTickBudget}));
        }
      }
    }
    // STUDENT SAMPLING: try the cheap learned policy before invoking the teacher.
    // This only activates after agreement is proven and falls back to the teacher
    // on uncertainty, making promotion a real latency optimization.
    if(this.studentPromoted() && Math.random()<0.3){
      try{
        const studentChoice=await this.askStudent(state,filteredCandidates,contextKey);
        if(studentChoice){
          this.sessionMotorChoices++;
          this.memory.lifetime.totalChoices++;
          this.memory.lifetime.studentChoices++;
          this.memory.lifetime.studentDecisions=(this.memory.lifetime.studentDecisions||0)+1;
          this.lastChoice=studentChoice;
          this.markDirty();
          this.replay.push({tick:(state as any).tick||0,perception:`HP ${state.player?.hp}/${state.player?.maxHp}; ${state.nearbyPlayers?.length||0} agents; ${state.nearbyNpcs?.length||0} NPCs; ${state.nearbyLocs?.length||0} objects`,retrieved:this.currentGuidance,prediction:this.lastShadowPrediction?.fingerprint||null,decision:studentChoice.reason,action:studentChoice.fingerprint,outcome:null,lesson:null});
          if(this.replay.length>80)this.replay.shift();
          console.log('AGENT_DECISION_TIMING',JSON.stringify({ms:Date.now()-decisionStarted,controller:'student',allowed:filteredCandidates.length}));
          return studentChoice;
        }
      }catch(e){
        console.log('AGENT_STUDENT_DECISION_FAILED',String(e).slice(0,200));
        // Fallback to teacher model.
      }
    }
    const choice=await this.askMotor(state,filteredCandidates,contextKey);
    console.log('AGENT_DECISION_TIMING',JSON.stringify({ms:Date.now()-decisionStarted,controller:'teacher',allowed:filteredCandidates.length}));
    this.sessionMotorChoices++;this.memory.lifetime.totalChoices++;this.memory.lifetime.teacherChoices++;
    if(this.lastShadowPrediction){this.memory.lifetime.shadowPredictions=(this.memory.lifetime.shadowPredictions||0)+1;if(this.lastShadowPrediction.fingerprint===choice.fingerprint)this.memory.lifetime.shadowMatches=(this.memory.lifetime.shadowMatches||0)+1;}
    this.maybePromoteStudent();
    this.lastChoice=choice;this.markDirty();
    this.replay.push({tick:(state as any).tick||0,perception:`HP ${state.player?.hp}/${state.player?.maxHp}; ${state.nearbyPlayers?.length||0} agents; ${state.nearbyNpcs?.length||0} NPCs; ${state.nearbyLocs?.length||0} objects`,retrieved:this.currentGuidance,prediction:this.lastShadowPrediction?.fingerprint||null,decision:choice.reason,action:choice.fingerprint,outcome:null,lesson:null});
    if(this.replay.length>80)this.replay.shift();
    return choice;
  }

  private maybeRefreshStrategy(state:BotWorldState,candidates:AgentCandidate[]){
    // The strategist runs beside the motor, never on the motor's critical path.
    const due=this.strategy===null||this.sessionMotorChoices-this.lastStrategySessionChoice>=18;
    if(!due||this.strategistInFlight)return;
    if(!this.strategistReady){void this.refreshAvailability();return;}
    this.strategistInFlight=true;
    const directiveAtStart=this.externalDirective;
    void this.askStrategist(state,candidates).then(strategy=>{
      if(directiveAtStart!==this.externalDirective)return;
      this.lastStrategistError=null;this.lastStrategySessionChoice=this.sessionMotorChoices;this.strategy=strategy;this.memory.activePlan=strategy;this.memory.lifetime.strategistRefreshes=(this.memory.lifetime.strategistRefreshes||0)+1;this.markDirty();
      this.addMemory({kind:'strategy',text:`AI strategist: ${strategy.focus}. ${strategy.reason}`,importance:1.1,tags:['ai-strategy',...strategy.priorities.slice(0,3)],tick:0,state});
    }).catch(err=>{this.lastStrategistError=String(err).slice(0,240);this.lastStrategySessionChoice=Math.max(-9999,this.sessionMotorChoices-15);this.memory.lifetime.strategistFailures=(this.memory.lifetime.strategistFailures||0)+1;console.warn('AI_STRATEGIST_ERROR',String(err));}).finally(()=>{this.strategistInFlight=false;});
  }

  private async askStrategist(state:BotWorldState,candidates:AgentCandidate[]):Promise<Strategy>{
    const p=state.player!;
    const executable=candidates.filter(c=>c.category!=='wait').slice(0,20).map(c=>c.label.slice(0,96));
    const negatives=this.recentOutcomes.filter(o=>o.reward<0).slice(-3).map(o=>o.candidateLabel.slice(0,90));
    const guidance=this.retrieveRepoGuidance(state,candidates,1,420);
    const skillLevels=Object.fromEntries((state.skills||[]).filter((skill:any)=>!/^Stat/.test(String(skill.name||''))).map((skill:any)=>[skill.name,skill.level]));
    const coins=(state.inventory||[]).filter((item:any)=>/coins?/i.test(String(item.name||''))).reduce((sum:number,item:any)=>sum+Number(item.count||0),0);
    const observation={directive:this.externalDirective,position:[p.worldX,p.worldZ,p.level],hp:[p.hp,p.maxHp],combatLevel:p.combatLevel,skills:skillLevels,coins,inventory:(state.inventory||[]).slice(0,16).map(i=>[i.name,i.count]),equipment:(state.equipment||[]).map(i=>i.name),failed:negatives,actions:executable,nearby:(state.nearbyLocs||[]).slice(0,8).map((loc:any)=>loc.name),guide:guidance[0]||''};
    const schema={type:'object',additionalProperties:false,properties:{objective:{type:'string'},step_1:{type:'string'},step_2:{type:'string'},step_3:{type:'string'},reason:{type:'string'},success:{type:'string'}},required:['objective','step_1','step_2','step_3','reason','success']};
    const ask=async(payload:unknown,timeout:number)=>{const r=await fetch(`${this.ollamaUrl}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:this.strategistModel,stream:false,think:false,format:schema,keep_alive:'6h',options:{temperature:.1,num_ctx:1536,num_predict:120},messages:[{role:'system',content:'You plan gameplay for Sol in the rs-sdk RuneScape MMO. Return one concise objective and exactly three executable steps. An operator directive is authoritative: when present, make the objective and all steps serve it, and never reintroduce an explicitly abandoned loop. Prefer a named repository-tested escape or travel skill when available. Build a prerequisite chain from the current skills, coins, inventory, nearby world, and failed attempts. Every step needs observable evidence and a measurable terminal condition. Do not repeat a failed step unless the missing prerequisite has changed. Use only listed actions.'},{role:'user',content:JSON.stringify(payload)}]}),signal:AbortSignal.timeout(timeout)});if(!r.ok)throw new Error(`strategist ${r.status}`);const raw:any=await r.json();return parseModelJson(raw?.message?.content);};
    let j:any;try{j=await ask(observation,32000)}catch(first){j=await ask({position:observation.position,actions:executable.slice(0,12),instruction:'Choose a concise objective and three steps.'},24000)}
    const labels=[j.step_1,j.step_2,j.step_3].map(String).filter(Boolean);if(labels.length<2)throw new Error('strategist returned fewer than two plan steps');
    const steps=labels.slice(0,5).map((label:string,i:number)=>({id:`step-${i+1}`,label:label.slice(0,140),status:(i===0?'active':'pending') as 'active'|'pending'}));
    const focus=steps[0]?.label||'Make measurable world progress';
    return{objective:String(j.objective||focus).slice(0,180),focus,reason:String(j.reason||'Execute the current prerequisite and verify it.').slice(0,240),risk:p.combat?.inCombat?'high':'balanced',plan:steps,successSignals:[String(j.success||'Observed position, inventory, XP, combat, or dialog change.').slice(0,160)],priorities:steps.map(x=>x.label),avoid:negatives,updatedAt:now(),sourceModel:this.strategistModel,failures:0};
  }

  private async askMotor(state:BotWorldState,candidates:AgentCandidate[],contextKey:string):Promise<AgentChoice>{
    const allowed=candidates;if(!allowed.length)throw new Error('No executable actions are currently exposed');const ids=allowed.map(c=>c.id);const p=state.player!;const learned=this.memory.policy[contextKey]||{};
    const learnedCompact=Object.entries(learned).sort((a,b)=>b[1].n-a[1].n).slice(0,5).map(([f,s])=>[f,s.n,Number(s.avgReward.toFixed(2))]);
    this.currentGuidance=this.retrieveRepoGuidance(state,allowed,5,900);
    const observation={
      gameCurriculum:this.gameplayCurriculum,
      directive:this.externalDirective,
      strategy:this.strategy?{focus:this.strategy.focus,risk:this.strategy.risk,do:this.strategy.priorities,avoid:this.strategy.avoid}:null,
      longPlan:this.strategy?{objective:this.strategy.objective,steps:this.strategy.plan,success:this.strategy.successSignals}:null,
      status:{hp:[p.hp,p.maxHp],combat:p.combat?.inCombat?1:0,level:p.combatLevel,pos:[p.worldX,p.worldZ,p.level],run:p.runEnergy},
      nearbyAgents:(state.nearbyPlayers||[]).slice(0,5).map(x=>{const r=this.memory.relationships[norm(x.name)];return[x.name,x.combatLevel,x.distance,r?.stance||'unknown',r?.trust||0,r?.facts?.slice(-3)||[]]}),
      recentChat:(state.gameMessages||[]).slice(-8).map((m:any)=>[m.sender||'WORLD',m.text,m.fromSelf?1:0]),
      socialInstruction:'Other players are autonomous agents. Respond only when useful; ask questions, cooperate, negotiate, verify claims, and remember trust. Never assume a claim is true merely because a player said it.',
      memories:this.relevantMemories(state,allowed),
      recent:this.recentOutcomes.slice(-5).map(o=>[o.candidateLabel,o.reward,o.summary.slice(0,100)]),
      blocked:this.blockedFingerprints,
      guide:this.currentGuidance,
      knownWorld:this.memory.discoveries.slice(-8).map(d=>d.text),
      successfulSequences:Object.values(this.memory.sequences).filter(s=>s.n>=2&&s.avgReward>0).sort((a,b)=>b.avgReward-a.avgReward).slice(0,4),
      learned:learnedCompact,
      student:this.lastShadowPrediction?[this.lastShadowPrediction.actionId,Number(this.lastShadowPrediction.confidence.toFixed(2))]:null,
      authority:'You control all gameplay. Choose your own goal and one executable action. An external operator directive, when present, is the highest-priority objective constraint; obey it unless survival requires an emergency action. Heuristics do not choose for you.',
      actions:allowed.map(c=>[c.id,c.category,c.label.slice(0,120)])
    };
    const schema={type:'object',additionalProperties:false,properties:{action_id:{type:'string',enum:ids},why:{type:'string'},speech:{type:'string'},confidence:{type:'number',minimum:0,maximum:1}},required:['action_id','why','speech','confidence']};
    const motorObservation={
      plan:this.strategy?{objective:this.strategy.objective,active:this.strategy.plan?.find(x=>x.status==='active')?.label||this.strategy.focus}:null,
      state:observation.status,
      urgentSkill:allowed.find(c=>c.fingerprint==='skill:escape-draynor-manor')?.label||null,
      recent:observation.recent.slice(-3),
      chat:observation.recentChat.slice(-3),
      guide:this.currentGuidance.slice(0,2).map(x=>x.slice(0,360)),
      actions:allowed.map(c=>[c.id,c.category,c.label.slice(0,90)])
    };
    try{
      const ask=async(payload:unknown,timeout:number)=>{
        // Inject learned action values into the prompt so the motor can prefer high-reward actions
        const ctx=this.memory.policy[contextKey]||{};
        const learnedValues:any={};
        for(const [fp,stats] of Object.entries(ctx)) {
          const s=stats as any;
          if(s.n>=2) learnedValues[fp]={avgReward:Number(s.avgReward.toFixed(2)),count:s.n,successRate:Number((s.positive/s.n).toFixed(2))};
        }
        const enriched={...(payload&&typeof payload==='object'?payload:{}),learnedActionValues:learnedValues};
        // Measured: ~19.2s median per decision (run 72, 20 AGENT_THINK events
        // over 366s). That is the real throughput ceiling, not the planner.
        // Also num_ctx is 2048 while this payload carries 25-38 candidates
        // plus learnedActionValues, so it may be silently truncating and
        // costing the motor its action list. Measure both.
        const payloadChars=JSON.stringify(enriched).length;
        const t0=Date.now();
        const r=await fetch(`${this.ollamaUrl}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:this.motorModel,stream:false,think:false,format:schema,keep_alive:'6h',options:{temperature:.12,num_ctx:2048,num_predict:72},messages:[{role:'system',content:'You are Sol inside the rs-sdk RuneScape MMO. Select one action_id yourself. Advance the active plan and produce measurable game progress. If urgentSkill contains the repository-tested manor escape, choose that before unrelated skilling because the current floor is trapped. Avoid wait when another action can progress or test a prerequisite. speech is empty unless selecting a say action. learnedActionValues shows average rewards from past attempts (higher = better); prefer actions with high avgReward and successRate > 0.5.'},{role:'user',content:JSON.stringify(enriched)}]}),signal:AbortSignal.timeout(timeout)});if(!r.ok)throw new Error(`motor ${r.status}`);const raw:any=await r.json();
        const ms=Date.now()-t0;const approxTokens=Math.round(payloadChars/4);
        console.log('AGENT_MOTOR_TIMING',JSON.stringify({ms,payloadChars,approxTokens,numCtx:2048,likelyTruncated:approxTokens>2048,candidates:(payload as any)?.actions?.length??null,evalCount:raw?.eval_count??null,promptEvalCount:raw?.prompt_eval_count??null}));
        return parseModelJson(raw?.message?.content);
      };
      let j:any;try{j=await ask(motorObservation,12000)}catch(first){j=await ask({plan:motorObservation.plan,actions:motorObservation.actions,instruction:'Choose one action now. Do not wait if any productive action exists.'},10000)}
      const c=allowed.find(x=>x.id===j.action_id);if(!c)throw new Error(`invalid motor action ${j.action_id}`);this.motorFailures=0;
      const why=String(j.why||`Selected ${c.label}`).slice(0,180),goal=String(this.strategy?.focus||`Progress through ${c.category}`).slice(0,180),followUp:string[]=[],planNote='Immediate action chosen by the motor model.',speech=String(j.speech||'').slice(0,80);
      this.lastAutonomousProposal={goal,action:c.fingerprint,followUp,planNote,speech,at:now()};
      return{source:'teacher',goal,reason:why,expectedOutcome:`Observe whether ${c.label} changes game state.`,actionId:c.id,speech,confidence:clamp(Number(j.confidence)||.5,0,1),contextKey,fingerprint:c.fingerprint,followUp,planNote};
    }catch(err){this.motorFailures++;if(this.motorFailures>=3)this.motorReady=false;throw err;}
  }

  beginExperience(choice:AgentChoice,candidate:AgentCandidate,state:BotWorldState,tick:number){this.pending={choice,candidate,startTick:tick,settleTick:tick+Math.max(2,candidate.settleTicks||6),before:this.metrics(state)};}

  maybeFinishExperience(state:BotWorldState,tick:number):AgentOutcome|null{
    if(!this.pending||tick<this.pending.settleTick)return null;
    const exp=this.pending;this.pending=null;const after=this.metrics(state);const events=(state.combatEvents||[]).filter(e=>e.tick>exp.startTick);
    const kills=events.filter(e=>e.type==='kill').length;const damageDealt=events.filter(e=>e.type==='damage_dealt').reduce((n,e)=>n+(e.damage||0),0);const damageTaken=events.filter(e=>e.type==='damage_taken').reduce((n,e)=>n+(e.damage||0),0);
    const xpGain=Math.max(0,after.totalXp-exp.before.totalXp);const levelGain=Math.max(0,after.totalLevels-exp.before.totalLevels);const hpDelta=after.hp-exp.before.hp;const moved=after.x!==exp.before.x||after.z!==exp.before.z||after.level!==exp.before.level;const died=after.lifeId!==exp.before.lifeId||(exp.before.hp>0&&after.hp<=0);const executionFailed=exp.candidate.action?.executionResult?.success===false;const rejected=after.opRejectedCount>exp.before.opRejectedCount||executionFailed;
    const newNpc=[...after.npcNames].filter(x=>!exp.before.npcNames.has(x));const newPlayers=[...after.playerNames].filter(x=>!exp.before.playerNames.has(x));const newLocs=[...after.locNames].filter(x=>!exp.before.locNames.has(x));const coinGain=after.coins-exp.before.coins;const inventoryGain=after.inventoryCount-exp.before.inventoryCount;
    const inventoryChanged=after.inventorySig!==exp.before.inventorySig;const equipmentChanged=after.equipmentSig!==exp.before.equipmentSig;const styleChanged=after.combatStyleSig!==exp.before.combatStyleSig;const executionMessage=executionFailed?String(exp.candidate.action?.executionResult?.message||'').slice(0,420):'';const discovers=/^(explore|navigation-skill|world)$/.test(exp.candidate.category);const configures=/^(inventory|combat-style)$/.test(exp.candidate.category);
    let reward=Math.min(4,xpGain*.02)+levelGain*3+damageDealt*.15+kills*3-damageTaken*.25;if(hpDelta<0)reward+=hpDelta*.15;if(moved)reward+=discovers?.35:.08;if(discovers)reward+=Math.min(1.2,newNpc.length*.2+newLocs.length*.1);if(exp.candidate.category==='social'||exp.candidate.category==='say')reward+=Math.min(.3,newPlayers.length*.15);reward+=clamp(coinGain*.02,-.5,1.5)+clamp(inventoryGain*.08,-.4,.5);if(configures&&equipmentChanged)reward+=.12;if(configures&&styleChanged)reward+=.08;if(rejected)reward-=1.25;if(died)reward-=10;
    // ACTION COST MODELING: penalize time-wasting actions to prevent standing-still
    const actionCost=this.computeActionCost(exp.candidate,exp.startTick,tick);
    reward-=actionCost;
    // STAGNATION DETECTION: hard penalty for zero movement over 100 ticks
    if(!moved&&xpGain===0&&kills===0&&damageDealt===0&&coinGain===0&&inventoryGain===0){
      const stagnationTicks=this.stagnationCounter.get(exp.candidate.fingerprint)||0;
      if(stagnationTicks>=100){
        reward-=2.0;
        // STAGNATION RECOVERY: when stuck, force exploration goal
        console.log('AGENT_STAGNATION_ESCAPE',JSON.stringify({action:exp.candidate.label,ticks:stagnationTicks}));
        const escapeGoal=this.goals.createGoal('Escape stagnation','Explore new areas',[{id:'escape',description:'Move somewhere new',targetAction:'explore'}],'critical');
        this.goals.adoptGoal(escapeGoal);
      }
      this.stagnationCounter.set(exp.candidate.fingerprint,stagnationTicks+Math.max(1,exp.settleTick-exp.startTick));
    }else{
      this.stagnationCounter.clear();
    }
    // CAPABILITY INVESTMENT. Spending coins is penalised above and clearing a
    // prerequisite paid nothing, so buying a fishing net scored negative even
    // though it unlocks an entire skill. Pay for the capability, once per
    // blocker per session so it cannot be farmed by re-breaking it.
    const skillLevels:Record<string,number>={};
    for(const sk of (state.skills||[]) as any[])skillLevels[String(sk.name||'').toLowerCase()]=Number(sk.level)||0;
    skillLevels.__coins=after.coins;
    const clearedNow=this.prereqs.resolve(skillLevels,((state.inventory||[]) as any[]).map(i=>String(i.name||'')));
    let unlocked:string[]=[];
    for(const b of clearedNow){
      if(this.paidResolutions.has(b.id))continue;
      this.paidResolutions.add(b.id);
      const value=PrerequisiteTracker.resolutionValue(b);
      reward+=value;unlocked.push(`${b.requirement} (+${value.toFixed(2)})`);
      console.log('AGENT_PREREQ_CLEARED',JSON.stringify({requirement:b.requirement,refusals:b.hits,reward:value}));
    }
    const noProgress=!moved&&xpGain===0&&kills===0&&damageDealt===0&&coinGain===0&&inventoryGain===0&&!(configures&&(equipmentChanged||styleChanged))&&!unlocked.length;if(noProgress)reward-=exp.candidate.category==='wait'?.15:.6;reward=Number(clamp(reward,-10,10).toFixed(3));
    const newThings=[...newPlayers.map(x=>`agent:${x}`),...newNpc.slice(0,4).map(x=>`npc:${x}`),...newLocs.slice(0,4).map(x=>`loc:${x}`)];
    const parts=[xpGain?`+${xpGain} XP`:'',levelGain?`+${levelGain} level(s)`:'',damageDealt?`${damageDealt} damage dealt`:'',damageTaken?`${damageTaken} damage taken`:'',kills?`${kills} kill(s)`:'',moved?`moved ${exp.before.x},${exp.before.z} → ${after.x},${after.z}`:'',inventoryChanged?'inventory changed':'',equipmentChanged?'equipment changed':'',styleChanged?'combat style changed':'',coinGain?`${coinGain>0?'+':''}${coinGain} coins`:'',rejected?'execution rejected or failed':'',executionMessage?`detail: ${executionMessage}`:'',died?'died/respawned':'',unlocked.length?`unlocked: ${unlocked.join(', ')}`:'',discovers&&newThings.length?`new: ${newThings.slice(0,6).join(', ')}`:''].filter(Boolean);
    const outcome:AgentOutcome={tick,reward,summary:parts.length?parts.join('; '):'No measurable change.',choice:exp.choice,candidateLabel:exp.candidate.label,xpGain,hpDelta,moved,kills,damageDealt,damageTaken,newThings,rejected,inventoryChanged,equipmentChanged,styleChanged,executionFailed};
    // FAILURE ANALYSIS: if action failed, analyze why and form subgoal if recoverable
    if(rejected&&!outcome.executionFailed){
      const failureReason=this.extractFailureReason(state,exp,outcome);
      if(failureReason){
        // Don't re-form a subgoal we are already pursuing. INVENTORY_FULL fired
        // repeatedly in run 67 and re-adopted "Visit bank to store items" 26
        // times, resetting progress each time.
        const active=this.goals.getActiveGoal?.();
        const alreadyPursuing=!!active&&/bank|net|bait/i.test(String(active.name||''))&&failureReason!=='EXECUTION_FAILED';
        if(!alreadyPursuing){
          const subgoal=this.goals.formSubgoalFromFailure(exp.candidate.label,failureReason);
          if(subgoal)console.log('AGENT_SUBGOAL_FORMED',JSON.stringify({parent:exp.candidate.label,failure:failureReason,subgoal:subgoal.name}));
        }
      }
    }
    this.learn(exp,outcome,state);this.lastOutcome=outcome;this.recentOutcomes.push(outcome);if(this.recentOutcomes.length>20)this.recentOutcomes.shift();
    // GOAL COMPLETION CHECK: if active goal step has success condition, check if met
    const activeGoal=this.goals.currentStep();
    if(activeGoal?.successCondition){
      if(activeGoal.successCondition(state.inventory||[],state.equipment||[])){
        console.log('AGENT_GOAL_STEP_COMPLETE',JSON.stringify({step:activeGoal.description,action:exp.candidate.label}));
        this.goals.completeStep(state.inventory||[],state.equipment||[]);
      }
    }
    return outcome;
  }

  private learn(exp:Experience,outcome:AgentOutcome,state:BotWorldState){
    const ctx=this.memory.policy[exp.choice.contextKey]||={};const old=ctx[exp.candidate.fingerprint]||{n:0,avgReward:0,positive:0,negative:0,lastReward:0,lastAt:now(),exampleGoal:exp.choice.goal,exampleReason:exp.choice.reason};
    const n=old.n+1;const avg=old.avgReward+(outcome.reward-old.avgReward)/n;
    ctx[exp.candidate.fingerprint]={n,avgReward:Number(avg.toFixed(4)),positive:old.positive+(outcome.reward>.15?1:0),negative:old.negative+(outcome.reward<-.15?1:0),lastReward:outcome.reward,lastAt:now(),exampleGoal:exp.choice.goal,exampleReason:exp.choice.reason};
    this.memory.lifetime.completedExperiences++;this.memory.lifetime.totalReward=Number((this.memory.lifetime.totalReward+outcome.reward).toFixed(3));
    if(Math.abs(outcome.reward)>=.8||outcome.kills>0||outcome.newThings.some(x=>x.startsWith('agent:'))||outcome.rejected)this.addMemory({kind:'episode',text:`AI motor: ${exp.candidate.label}. Result: ${outcome.summary}. Reward ${outcome.reward}.`,importance:clamp(.7+Math.abs(outcome.reward)/2,.7,5),tags:uniq([exp.candidate.category,...(exp.candidate.tags||[]),...outcome.newThings]).slice(0,14),tick:outcome.tick,state});
    if(n>=3&&avg>.35&&ctx[exp.candidate.fingerprint].positive>=2)this.addMemory({kind:'strategy',text:`From AI demonstrations, ${exp.candidate.label} worked across ${n} similar samples with average reward ${avg.toFixed(2)}.`,importance:clamp(1+avg,1,4),tags:[exp.candidate.category,exp.candidate.fingerprint],tick:outcome.tick,state});
    this.recentSequence.push({fingerprint:exp.candidate.fingerprint,label:exp.candidate.label,reward:outcome.reward});if(this.recentSequence.length>12)this.recentSequence.shift();
    if(this.recentSequence.length>=3){const seq=this.recentSequence.slice(-3),key=seq.map(x=>x.fingerprint).join(' > '),total=seq.reduce((v,x)=>v+x.reward,0),oldSeq=this.memory.sequences[key]||{sequence:seq.map(x=>x.fingerprint),n:0,avgReward:0,positive:0,lastAt:now(),example:seq.map(x=>x.label).join(' → ')};const sn=oldSeq.n+1,savg=oldSeq.avgReward+(total-oldSeq.avgReward)/sn;this.memory.sequences[key]={...oldSeq,n:sn,avgReward:Number(savg.toFixed(3)),positive:oldSeq.positive+(total>.4?1:0),lastAt:now()};}
    if(outcome.moved&&state.player){const id=`route:${exp.before.x}:${exp.before.z}:${state.player.worldX}:${state.player.worldZ}:${state.player.level}`;if(!this.memory.discoveries.some(d=>d.id===id))this.memory.discoveries.push({id,at:now(),kind:'route',text:`Route learned: ${exp.before.x},${exp.before.z} → ${state.player.worldX},${state.player.worldZ}; ${outcome.summary}`,location:{x:state.player.worldX,z:state.player.worldZ,level:state.player.level},confidence:outcome.rejected?.35:.75});}
    const active=this.strategy?.plan?.find(x=>x.status==='active');
    if(active){const overlap=[...toks(active.label)].some(t=>toks(`${exp.candidate.label} ${outcome.summary}`).has(t));
      const verifiedSuccess=outcome.reward>.45&&overlap&&!outcome.rejected&&!outcome.executionFailed&&!outcome.summary.includes('died/respawned');
      if(verifiedSuccess){active.status='done';active.evidence=outcome.summary;const next=this.strategy!.plan!.find(x=>x.status==='pending');if(next)next.status='active';else this.strategy!.focus='Plan complete; form the next objective.';this.memory.activePlan=this.strategy;}
      else if(outcome.reward<-.7||outcome.rejected){this.strategy!.failures=(this.strategy!.failures||0)+1;if((this.strategy!.failures||0)>=3){active.status='blocked';active.evidence='Repeated negative or rejected outcomes; strategist must replan.';this.memory.activePlan=this.strategy;this.strategy=null;}}
    }
    const replay=this.replay.at(-1);if(replay&&!replay.outcome){replay.outcome=outcome.summary;replay.lesson=outcome.reward>0?`Reinforce ${exp.candidate.fingerprint} (reward ${outcome.reward})`:`Avoid or revise ${exp.candidate.fingerprint} (reward ${outcome.reward})`;}
    this.markDirty();void this.save(false);
  }

  private addMemory(args:{kind:MemoryEntry['kind'];text:string;importance:number;tags:string[];tick:number;state:BotWorldState}){
    const p=args.state.player;const m:MemoryEntry={id:`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,createdAt:now(),tick:args.tick,runNumber:this.opts.runNumber??null,kind:args.kind,text:args.text.slice(0,700),importance:Number(args.importance.toFixed(2)),tags:uniq(args.tags.map(norm).filter(Boolean)).slice(0,16),location:p?{x:p.worldX,z:p.worldZ,level:p.level}:undefined};
    if(!this.memory.memories.some(x=>x.kind===m.kind&&x.text===m.text))this.memory.memories.push(m);if(this.memory.memories.length>400)this.memory.memories.splice(0,this.memory.memories.length-400);
  }

  private canPursueActivity(skillLevels:Record<string,number>,activity:string):boolean{
    // Check if we have the skills to do this activity
    const activityRequirements:Record<string,number>={
      'fish':20,'catch-lobster':40,'cook':15,'craft':10,
      'chop':10,'mine':15,'smelt':30,'smith':40,'thieve':25
    };
    const requiredLevel=activityRequirements[activity.toLowerCase()]||0;
    const skillName=activity.split(':')[0]?.split('-')[0]||'combat';
    const currentLevel=skillLevels[skillName]||0;
    return currentLevel>=requiredLevel;
  }

  private emitTelemetry(state:BotWorldState,tick:number){
    // Metric note: action COUNT is a bad progress measure here. A single
    // action can span hundreds of ticks (combat, woodcutting, travel), so a
    // low actions/1000 reads as "stuck" when the agent is working fine. XP
    // delta per tick is the honest measure. Measured on run 72: +4,658 XP
    // over 403 ticks while "actions/1000" looked alarming at 6.9.
    if(tick-this.lastTelemetryAt<500)return;
    const span=tick-this.lastTelemetryAt;
    this.lastTelemetryAt=tick;
    const p=state.player;
    if(p){
      this.posHistory.push(`${p.worldX},${p.worldZ}`);
      if(this.posHistory.length>40)this.posHistory.shift();
    }
    const xp=(state.skills||[]).reduce((n:number,s:any)=>n+(s.experience||0),0);
    const xpDelta=this.lastTelemetryXp>0?xp-this.lastTelemetryXp:0;
    this.lastTelemetryXp=xp;
    console.log('AGENT_TELEMETRY',JSON.stringify({
      tick,
      xpPer1000Ticks:span>0?Number((xpDelta*1000/span).toFixed(1)):0,
      xpDelta,
      actions:this.memory.lifetime.completedExperiences||0,
      distinctPositions:new Set(this.posHistory).size,
      planner:this.plannerEnabled,
      goalActive:!!this.goals.getActiveGoal()
    }));
  }

  private computeActionCost(candidate:AgentCandidate,startTick:number,endTick:number):number{
    const duration=Math.max(1,endTick-startTick);
    const fp=candidate.fingerprint;
    let cost=0;
    // Base costs: walking and style changes are time-wasting, but not harmful.
    if(fp.startsWith('walk:'))cost=0.02;
    else if(fp.startsWith('style:'))cost=0.01;
    else if(candidate.category==='wait')cost=0.08;
    // Charge for elapsed decision time after the normal observation window. This
    // makes the policy prefer actions that produce evidence sooner without
    // punishing legitimate multi-tick movement or combat actions.
    cost+=Math.max(0,duration-6)*0.004;
    // Repetition penalty: nth repeat = base_cost * n^2.
    const repeatCount=this.recentActions.filter(a=>a===fp).length;
    if(repeatCount>0)cost*=Math.pow(repeatCount+1,1.5);
    this.recentActions.push(fp);if(this.recentActions.length>20)this.recentActions.shift();
    return Math.min(cost,.75);
  }

  private maybePromoteStudent(){
    // When student accuracy >= 65% over 10+ samples, promote to make decisions
    const totalAgree=this.memory.lifetime.shadowMatches||0;
    const totalPredictions=this.memory.lifetime.shadowPredictions||0;
    if(totalPredictions>=10&&totalAgree/totalPredictions>=.65){
      console.log('AGENT_STUDENT_PROMOTED',JSON.stringify({agreement:totalAgree/totalPredictions,decisions:this.sessionMotorChoices}));
      // Student ready: next time we call motor, could sample student instead
      // For now, log promotion; next commit will integrate
      this.memory.lifetime.studentPromotions=(this.memory.lifetime.studentPromotions||0)+1;
    }
  }

  private maybeReevaluateGoal(state:BotWorldState,intervalTicks:number){
    // Every N ticks, check if current goal is still best
    const now=Date.now();
    if(now-this.lastGoalReeval<intervalTicks*50)return; // ~50ms per tick
    this.lastGoalReeval=now;
    
    const activeGoal=this.goals.currentStep();
    if(!activeGoal)return; // No goal to re-evaluate
    
    // Only abandon the active goal for an arbitrage we have not already acted
    // on. Without this the same opportunity re-fires every interval and the
    // goal never survives long enough to make progress (166 kills in run 67).
    const bestTrade=this.trades.getMostProfitableRoute();
    if(bestTrade&&bestTrade.profit>=100){
      const oppKey=`${bestTrade.item}:${bestTrade.sellNpc}:${bestTrade.buyNpc}`;
      if(oppKey!==this.lastArbitrageKey){
        this.lastArbitrageKey=oppKey;
        console.log('AGENT_GOAL_REEVAL_SWITCH',JSON.stringify({to:'arbitrage',opp:oppKey,profit:bestTrade.profit}));
        this.goals.failGoal('Better opportunity found: arbitrage');
      }
    }
    
    // Check if economy has shifted significantly
    const bestActivity=this.economy.getBestActivityFor('money');
    if(bestActivity&&this.lastRecommendedActivity!==bestActivity.name){
      if(bestActivity.profitPerHour>this.lastRecommendedProfit*1.5){
        console.log('AGENT_GOAL_REEVAL_ECONOMY',JSON.stringify({from:this.lastRecommendedActivity,to:bestActivity.name,profitDelta:bestActivity.profitPerHour-this.lastRecommendedProfit}));
        this.goals.failGoal('Better economy opportunity found');
      }
    }
  }

  private studentPromoted():boolean{
    const totalAgree=this.memory.lifetime.shadowMatches||0;
    const totalPredictions=this.memory.lifetime.shadowPredictions||0;
    return totalPredictions>=10&&totalAgree/totalPredictions>=.65;
  }

  private async askStudent(state:BotWorldState,candidates:AgentCandidate[],contextKey:string):Promise<AgentChoice|null>{
    // Student makes decisions using learned policy + simple heuristics
    // Prefer actions with positive expected value
    const ctx=this.memory.policy[contextKey]||{};
    let bestChoice:AgentChoice|null=null;
    let bestValue=-999;
    
    for(const candidate of candidates){
      const stats=ctx[candidate.fingerprint];
      // Value = learned reward + category bonus
      let value=stats?.avgReward||0;
      if(candidate.category==='combat')value+=0.1; // combat bonus
      if(candidate.category==='explore')value+=0.05; // explore bonus
      
      if(value>bestValue){
        bestValue=value;
        bestChoice={source:'student',goal:'Act on learned policy',reason:stats?`learned avg reward ${stats.avgReward}`:'exploring unseen action',expectedOutcome:`expected value ${bestValue.toFixed(2)}`,actionId:candidate.id,confidence:Math.max(0.4,Math.min(0.9,bestValue)),contextKey,fingerprint:candidate.fingerprint};
      }
    }
    
    if(bestChoice)console.log('AGENT_STUDENT_DECISION',JSON.stringify({action:bestChoice.actionId,confidence:bestChoice.confidence}));
    return bestChoice;
  }

  private extractFailureReason(state:BotWorldState,exp:Experience,outcome:AgentOutcome):string|null{
    const msg=(outcome.summary||'').toLowerCase();
    const inv=new Set((state.inventory||[]).map(i=>String(i.name||'').toLowerCase()));
    // NPC DIALOGUE: use recentDialogs (real NPC dialogue), NOT gameMessages.
    // gameMessages with fromSelf===false is ALL public player chat. Feeding it
    // here made a Watcher bot's "Thieves: 5311 picks, 14415 gp banked" into a
    // price record attributed to whatever NPC happened to be nearest, which
    // manufactured a phantom 173gp arbitrage that killed the active goal 166
    // times in run 67. Chat is not trade data.
    const npcDialogue=(state.recentDialogs||[]).map((x:any)=>String(x?.text||x?.message||'')).join(' ');
    if(npcDialogue.length>0){
      const nearbyNpc=(state.nearbyNpcs||[])[0];
      if(nearbyNpc){
        const quest=this.quests.parseQuestHints(nearbyNpc.name,npcDialogue);
        if(quest)console.log('AGENT_QUEST_DISCOVERED',JSON.stringify({quest:quest.title,giver:quest.giver,objective:quest.objective}));
        // Only accept an explicit currency amount tied to a named item.
        const priceMatches=npcDialogue.matchAll(/([A-Za-z][A-Za-z ]{2,24}?)\s*(?:for|costs?|:)\s*(\d{1,6})\s*(?:gp|coins)\b/gi);
        for(const match of priceMatches){
          const item=match[1].trim().toLowerCase();
          const price=parseInt(match[2]);
          if(price>0&&price<100000)this.trades.recordTrade(nearbyNpc.name,item,price,'sell');
        }
      }
    }
    if(msg.includes('no fishing spot')||msg.includes('net')&&!inv.has('fishing net'))return 'MISSING_NET';
    if(msg.includes('no bait')||msg.includes('bait'))return 'MISSING_BAIT';
    if(msg.includes('skill')||msg.includes('level')){
      // Observe skill requirement for skill-tree
      const skillMatch=msg.match(/(\w+)\s+(\d+)/);
      if(skillMatch){
        this.skillTree.observeSkillRequirement(msg,skillMatch[1],exp.candidate.label);
      }
      return 'SKILL_TOO_LOW';
    }
    if(msg.includes('locked')||msg.includes('blocked'))return 'LOCATION_BLOCKED';
    if(msg.includes('died')||msg.includes('respawn'))return 'DIED_IN_COMBAT';
    if(msg.includes('full')||msg.includes('inventory'))return 'INVENTORY_FULL';
    if(msg.includes('coin')||msg.includes('money'))return 'NOT_ENOUGH_COINS';
    return 'EXECUTION_FAILED';
  }

  private metrics(state:BotWorldState):Metrics{
    const p=state.player!;const sig=(xs:any[])=>xs.map(i=>`${i.slot}:${i.id}:${i.count||1}`).sort().join('|');return{hp:p.hp,maxHp:p.maxHp,lifeId:p.lifeId||0,x:p.worldX,z:p.worldZ,level:p.level,totalXp:(state.skills||[]).reduce((n,s)=>n+(s.experience||0),0),totalLevels:(state.skills||[]).reduce((n,s)=>n+(s.level||0),0),inventoryCount:(state.inventory||[]).reduce((n,i)=>n+(i.count||1),0),coins:(state.inventory||[]).filter(i=>/coins?/i.test(i.name)).reduce((n,i)=>n+(i.count||0),0),inventorySig:sig(state.inventory||[]),equipmentSig:sig(state.equipment||[]),combatStyleSig:`${state.combatStyle?.weaponName||''}:${state.combatStyle?.currentStyle??-1}`,npcNames:new Set((state.nearbyNpcs||[]).map(n=>n.name)),playerNames:new Set((state.nearbyPlayers||[]).map(x=>x.name)),locNames:new Set((state.nearbyLocs||[]).map(x=>x.name)),opRejectedCount:state.opFeedback?.opRejectedCount||0};
  }

  publicState(){
    const contexts=Object.keys(this.memory.policy).length;const learnedActions=Object.values(this.memory.policy).reduce((n,ctx)=>n+Object.values(ctx).filter(s=>s.n>=2&&s.avgReward>.05).length,0);const predictions=this.memory.lifetime.shadowPredictions||0;const matches=this.memory.lifetime.shadowMatches||0;
    const relationships=Object.values(this.memory.relationships).sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0,20);
    const sequences=Object.values(this.memory.sequences).sort((a,b)=>b.avgReward-a.avgReward).slice(0,12);
    const persistence={configured:!!(this.opts.githubToken&&this.opts.githubRepo),branch:'sol-memory',loaded:this.persistenceLoaded,loadedAt:this.persistenceLoadedAt,loadOutcome:this.loadOutcome,loadError:this.loadError,dirty:this.dirty,saveInFlight:!!this.saveInFlight,lastSavedAt:this.lastSaveSucceededAt,lastError:this.lastSaveError,consecutiveFailures:this.saveFailures};
    return{architecture:'model-sovereign-gameplay-with-execution-validation',externalDirective:this.externalDirective,teacherModel:this.motorModel,motorModel:this.motorModel,strategistModel:this.strategistModel,teacherOnline:this.motorReady,motorOnline:this.motorReady,strategistOnline:this.strategistReady,motorFailures:this.motorFailures,currentController:this.motorReady?'autonomous-model':'model-offline',autonomy:{modelControlsGameplay:true,heuristicActionRanking:false,executionValidation:true,emergencyOverride:false,lastProposal:this.lastAutonomousProposal},strategy:this.strategy||this.memory.activePlan,planTree:(this.strategy||this.memory.activePlan)?.plan||[],strategistInFlight:this.strategistInFlight,lastStrategistError:this.lastStrategistError,sessionMotorChoices:this.sessionMotorChoices,lastChoice:this.lastChoice,lastOutcome:this.lastOutcome,blockedFingerprints:this.blockedFingerprints,shadowStudentPrediction:this.lastShadowPrediction,retrievedRepoKnowledge:this.currentGuidance,shadowAgreementRate:predictions?Number((matches/predictions).toFixed(3)):null,learnedContexts:contexts,learnedActions,memoryCount:this.memory.memories.length,relationshipCount:Object.keys(this.memory.relationships).length,placeCount:Object.keys(this.memory.places).length,repoKnowledgeSegments:this.repoKnowledge.length,persistence,relationships,worldDiscoveries:this.memory.discoveries.slice(-30).reverse(),learnedSequences:sequences,mindReplay:this.replay.slice(-30).reverse(),lifetime:this.memory.lifetime,recentMemories:this.memory.memories.slice(-12),recentOutcomes:this.recentOutcomes.slice(-12)};
  }
}
