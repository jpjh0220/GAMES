import type { BotWorldState } from './src/bot/types.js';
import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';

export type AgentCandidate = {
  id:string; label:string; category:string; fingerprint:string; action:any;
  tags?:string[]; settleTicks?:number;
};

export type AgentChoice = {
  source:'teacher'|'student'; goal:string; reason:string; expectedOutcome:string;
  actionId:string; speech?:string; confidence:number; contextKey:string; fingerprint:string;
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
  updatedAt:string; sourceModel:string;
};

type PersistentState = {
  version:number;
  identity:{name:string;bornAt:string;directive:string};
  lifetime:{
    totalChoices:number;teacherChoices:number;studentChoices:number;reflexActions:number;
    completedExperiences:number;totalReward:number;saves:number;
    shadowPredictions?:number;shadowMatches?:number;strategistRefreshes?:number;strategistFailures?:number;
  };
  memories:MemoryEntry[];
  policy:Record<string,Record<string,PolicyStat>>;
  relationships:Record<string,{name:string;firstSeenAt:string;lastSeenAt:string;encounters:number;combatLevel?:number}>;
  places:Record<string,{key:string;x:number;z:number;level:number;firstSeenAt:string;lastSeenAt:string;visits:number;npcs:string[];locs:string[]}>;
  updatedAt:string;
};

type Metrics = {
  hp:number;maxHp:number;lifeId:number;x:number;z:number;level:number;
  totalXp:number;totalLevels:number;inventoryCount:number;coins:number;
  npcNames:Set<string>;playerNames:Set<string>;locNames:Set<string>;opRejectedCount:number;
};

type Experience = {choice:AgentChoice;candidate:AgentCandidate;startTick:number;settleTick:number;before:Metrics};

export type AgentOutcome = {
  tick:number;reward:number;summary:string;choice:AgentChoice;candidateLabel:string;
  xpGain:number;hpDelta:number;moved:boolean;kills:number;damageDealt:number;
  damageTaken:number;newThings:string[];rejected:boolean;
};

const now=()=>new Date().toISOString();
const clamp=(n:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,n));
const uniq=<T>(xs:T[])=>[...new Set(xs)];
const norm=(s:string)=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const toks=(s:string)=>new Set(norm(s).split(/\s+/).filter(x=>x.length>2));

const freshState=(name:string,directive:string):PersistentState=>({
  version:1,
  identity:{name,bornAt:now(),directive},
  lifetime:{totalChoices:0,teacherChoices:0,studentChoices:0,reflexActions:0,completedExperiences:0,totalReward:0,saves:0,shadowPredictions:0,shadowMatches:0,strategistRefreshes:0,strategistFailures:0},
  memories:[],policy:{},relationships:{},places:{},updatedAt:now()
});

export class SolAgentBrain {
  private memory:PersistentState;
  private pending:Experience|null=null;
  private githubSha:string|null=null;
  private dirty=false;
  private lastSaveAt=0;
  private motorReady=false;
  private strategistReady=false;
  private motorFailures=0;
  private strategistInFlight=false;
  private strategy:Strategy|null=null;
  private sessionMotorChoices=0;
  private lastStrategySessionChoice=-9999;
  private lastChoice:AgentChoice|null=null;
  private lastOutcome:AgentOutcome|null=null;
  private lastShadowPrediction:AgentChoice|null=null;
  private recentOutcomes:AgentOutcome[]=[];
  private repoKnowledge:{source:string;text:string}[]=[];
  private blockedFingerprints:string[]=[];

  constructor(private readonly opts:{
    name:string;directive:string;motorModel?:string;strategistModel?:string;model?:string;
    ollamaUrl?:string;githubToken?:string;githubRepo?:string;runNumber?:number|null;
  }){this.memory=freshState(opts.name,opts.directive);}

  get model(){return this.motorModel;}
  get motorModel(){return this.opts.motorModel||'qwen3:0.6b';}
  get strategistModel(){return this.opts.strategistModel||this.opts.model||'qwen3:1.7b';}
  get ollamaUrl(){return this.opts.ollamaUrl||'http://127.0.0.1:11434';}

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
    return this.repoKnowledge.map((seg,i)=>{
      const st=toks(`${basename(seg.source,'.md')} ${seg.text}`);let overlap=0;for(const t of q)if(st.has(t))overlap++;
      const exact=[...q].some(t=>t.length>5&&seg.text.toLowerCase().includes(t))?1:0;
      const api=seg.source==='sdk/API.md'?.3:0;
      return{seg,score:overlap*2+exact+api+i/100000};
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
    if(!this.opts.githubToken||!this.opts.githubRepo)return;
    try{
      const r=await fetch(`https://api.github.com/repos/${this.opts.githubRepo}/contents/sol-agent/state.json?ref=sol-memory&t=${Date.now()}`,{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.opts.githubToken}`,'X-GitHub-Api-Version':'2022-11-28'}});
      if(r.status===404)return;if(!r.ok)throw new Error(`memory load ${r.status}`);
      const body:any=await r.json();this.githubSha=body.sha||null;
      const parsed=JSON.parse(Buffer.from(String(body.content||'').replace(/\n/g,''),'base64').toString('utf8'));
      if(parsed?.version===1&&parsed?.identity&&parsed?.lifetime){
        this.memory=parsed;this.memory.identity.directive=this.opts.directive;
        this.memory.lifetime.shadowPredictions??=0;this.memory.lifetime.shadowMatches??=0;
        this.memory.lifetime.strategistRefreshes??=0;this.memory.lifetime.strategistFailures??=0;
        this.memory.memories||=[];this.memory.policy||={};this.memory.relationships||={};this.memory.places||={};
      }
    }catch(err){console.warn('AGENT_MEMORY_LOAD_FAILED',String(err));}
  }

  async save(force=false){
    if(!this.opts.githubToken||!this.opts.githubRepo||!this.dirty)return false;
    if(!force&&Date.now()-this.lastSaveAt<5*60_000&&this.memory.lifetime.completedExperiences%10!==0)return false;
    try{
      this.memory.updatedAt=now();this.memory.lifetime.saves++;
      const payload:any={message:`Persist Sol AI demonstrations (${this.memory.lifetime.completedExperiences} experiences)`,content:Buffer.from(JSON.stringify(this.memory,null,2)+'\n').toString('base64'),branch:'sol-memory'};
      if(this.githubSha)payload.sha=this.githubSha;
      const r=await fetch(`https://api.github.com/repos/${this.opts.githubRepo}/contents/sol-agent/state.json`,{method:'PUT',headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.opts.githubToken}`,'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!r.ok)throw new Error(`memory save ${r.status}: ${await r.text()}`);
      const body:any=await r.json();this.githubSha=body?.content?.sha||this.githubSha;this.lastSaveAt=Date.now();this.dirty=false;return true;
    }catch(err){console.warn('AGENT_MEMORY_SAVE_FAILED',String(err));return false;}
  }

  noteReflex(){this.memory.lifetime.reflexActions++;this.dirty=true;}

  private observe(state:BotWorldState){
    const t=now();
    for(const p of state.nearbyPlayers||[]){
      const k=norm(p.name);if(!k)continue;const old=this.memory.relationships[k];
      this.memory.relationships[k]=old?{...old,lastSeenAt:t,encounters:old.encounters+1,combatLevel:p.combatLevel}:{name:p.name,firstSeenAt:t,lastSeenAt:t,encounters:1,combatLevel:p.combatLevel};
    }
    if(state.player){
      const{worldX:x,worldZ:z,level}=state.player;const k=`${Math.floor(x/16)}:${Math.floor(z/16)}:${level}`;
      const npcs=uniq((state.nearbyNpcs||[]).map(n=>n.name).filter(Boolean)).slice(0,20);
      const locs=uniq((state.nearbyLocs||[]).map(l=>l.name).filter(Boolean)).slice(0,30);const old=this.memory.places[k];
      this.memory.places[k]=old?{...old,x,z,lastSeenAt:t,visits:old.visits+1,npcs:uniq([...old.npcs,...npcs]).slice(-30),locs:uniq([...old.locs,...locs]).slice(-40)}:{key:k,x,z,level,firstSeenAt:t,lastSeenAt:t,visits:1,npcs,locs};
    }
    this.dirty=true;
  }

  private contextKey(state:BotWorldState,candidates:AgentCandidate[]){
    const p=state.player!;const ratio=p.maxHp?p.hp/p.maxHp:1;const hp=ratio<.35?'critical':ratio<.65?'hurt':'healthy';
    const food=(state.inventory||[]).some(i=>i.optionsWithIndex?.some(o=>/^eat$|^drink$/i.test(o.text)))?1:0;
    const cats=uniq(candidates.map(c=>c.category)).sort().slice(0,12).join(',');
    const area=`${Math.floor(p.worldX/8)}:${Math.floor(p.worldZ/8)}:${p.level}`;
    return`area=${area}|hp=${hp}|combat=${p.combat?.inCombat?1:0}|agents=${(state.nearbyPlayers?.length||0)>0?1:0}|food=${food}|dialog=${state.dialog?.isOpen?1:0}|bank=${state.bank?.isOpen?1:0}|shop=${state.shop?.isOpen?1:0}|cats=${cats}`;
  }

  private antiLoopCandidates(candidates:AgentCandidate[]){
    const recent=this.recentOutcomes.slice(-10);
    const blocked=new Set<string>();
    for(const c of candidates){
      const attempts=recent.filter(o=>o.choice.fingerprint===c.fingerprint).slice(-4);
      if(attempts.length<2)continue;
      const avg=attempts.reduce((n,o)=>n+o.reward,0)/attempts.length;
      const failures=attempts.filter(o=>o.reward<0||o.rejected).length;
      if(failures>=2&&avg<0)blocked.add(c.fingerprint);
    }
    const last=recent.at(-1);
    if(last?.reward<0)blocked.add(last.choice.fingerprint);
    const filtered=candidates.filter(c=>!blocked.has(c.fingerprint));
    this.blockedFingerprints=[...blocked];
    return filtered.length?filtered:candidates;
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
    const order=['dialog','modal','recovery','combat','economy','pickup','social','world','inventory','combat-style','explore','wait'];const out:AgentCandidate[]=[];
    for(const category of order)for(const c of productive.filter(x=>x.category===category).slice(0,1)){if(out.length<12&&!out.some(x=>x.id===c.id))out.push(c);}
    for(const c of productive){if(out.length>=12)break;if(!out.some(x=>x.id===c.id))out.push(c);}return out;
  }

  async decide(state:BotWorldState,candidates:AgentCandidate[]):Promise<AgentChoice>{
    this.observe(state);const legal=this.antiLoopCandidates(candidates);const contextKey=this.contextKey(state,legal);this.lastShadowPrediction=this.shadowPrediction(legal,contextKey);
    if(!this.motorReady){await this.refreshAvailability();if(!this.motorReady)throw new Error(`AI motor unavailable: ${this.motorModel}`);}
    const choice=await this.askMotor(state,legal,contextKey);
    this.sessionMotorChoices++;this.memory.lifetime.totalChoices++;this.memory.lifetime.teacherChoices++;
    if(this.lastShadowPrediction){this.memory.lifetime.shadowPredictions=(this.memory.lifetime.shadowPredictions||0)+1;if(this.lastShadowPrediction.fingerprint===choice.fingerprint)this.memory.lifetime.shadowMatches=(this.memory.lifetime.shadowMatches||0)+1;}
    this.lastChoice=choice;this.dirty=true;
    this.maybeRefreshStrategy(state,legal);
    return choice;
  }

  private maybeRefreshStrategy(state:BotWorldState,candidates:AgentCandidate[]){
    // Strategist never runs on startup or every turn. It is deliberately off the motor's critical path.
    const due=this.sessionMotorChoices>=5&&(this.strategy===null||this.sessionMotorChoices-this.lastStrategySessionChoice>=50);
    if(!due||this.strategistInFlight||!this.strategistReady)return;
    this.strategistInFlight=true;this.lastStrategySessionChoice=this.sessionMotorChoices;
    void this.askStrategist(state,candidates).then(strategy=>{
      this.strategy=strategy;this.memory.lifetime.strategistRefreshes=(this.memory.lifetime.strategistRefreshes||0)+1;this.dirty=true;
      this.addMemory({kind:'strategy',text:`AI strategist: ${strategy.focus}. ${strategy.reason}`,importance:1.1,tags:['ai-strategy',...strategy.priorities.slice(0,3)],tick:0,state});
    }).catch(err=>{this.memory.lifetime.strategistFailures=(this.memory.lifetime.strategistFailures||0)+1;console.warn('AI_STRATEGIST_ERROR',String(err));}).finally(()=>{this.strategistInFlight=false;});
  }

  private async askStrategist(state:BotWorldState,candidates:AgentCandidate[]):Promise<Strategy>{
    const p=state.player!;const observation={mission:this.memory.identity.directive,status:[p.hp,p.maxHp,p.combatLevel,p.worldX,p.worldZ,p.combat?.inCombat?1:0],skills:(state.skills||[]).filter(s=>!/^Stat\d+$/i.test(s.name)).map(s=>[s.name,s.level]),recent:this.recentOutcomes.slice(-5).map(o=>[o.candidateLabel,o.reward,o.summary]),categories:uniq(candidates.map(c=>c.category)),repoGuidance:this.retrieveRepoGuidance(state,candidates,3,650)};
    const schema={type:'object',additionalProperties:false,properties:{focus:{type:'string'},reason:{type:'string'},risk:{type:'string',enum:['low','balanced','high']},priorities:{type:'array',items:{type:'string'},maxItems:4},avoid:{type:'array',items:{type:'string'},maxItems:4}},required:['focus','reason','risk','priorities','avoid']};
    const r=await fetch(`${this.ollamaUrl}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:this.strategistModel,stream:false,think:false,format:schema,keep_alive:'6h',options:{temperature:.2,num_ctx:1536,num_predict:120},messages:[{role:'system',content:'You are Sol strategic AI. Give a short direction to a separate fast motor AI. repoGuidance contains relevant excerpts loaded from the rs-sdk GitHub repository; use it as gameplay/API knowledge. Live state and measured outcomes override stale guidance. Avoid loops, preserve survival, seek useful progression.'},{role:'user',content:JSON.stringify(observation)}]}),signal:AbortSignal.timeout(22000)});
    if(!r.ok)throw new Error(`strategist ${r.status}`);const raw:any=await r.json();const j=JSON.parse(raw?.message?.content||'{}');
    return{focus:String(j.focus||'Explore and progress').slice(0,140),reason:String(j.reason||'Seek measurable progress.').slice(0,240),risk:['low','balanced','high'].includes(j.risk)?j.risk:'balanced',priorities:Array.isArray(j.priorities)?j.priorities.map(String).slice(0,4):[],avoid:Array.isArray(j.avoid)?j.avoid.map(String).slice(0,4):[],updatedAt:now(),sourceModel:this.strategistModel};
  }

  private async askMotor(state:BotWorldState,candidates:AgentCandidate[],contextKey:string):Promise<AgentChoice>{
    const allowed=this.balancedCandidates(candidates);if(!allowed.length)throw new Error('No legal actions for AI motor');const ids=allowed.map(c=>c.id);const p=state.player!;const learned=this.memory.policy[contextKey]||{};
    const learnedCompact=Object.entries(learned).sort((a,b)=>b[1].n-a[1].n).slice(0,5).map(([f,s])=>[f,s.n,Number(s.avgReward.toFixed(2))]);
    const observation={
      strategy:this.strategy?{focus:this.strategy.focus,risk:this.strategy.risk,do:this.strategy.priorities,avoid:this.strategy.avoid}:null,
      status:{hp:[p.hp,p.maxHp],combat:p.combat?.inCombat?1:0,level:p.combatLevel,pos:[p.worldX,p.worldZ,p.level],run:p.runEnergy},
      nearbyAgents:(state.nearbyPlayers||[]).slice(0,3).map(x=>[x.name,x.combatLevel,x.distance]),
      memories:this.relevantMemories(state,allowed),
      recent:this.recentOutcomes.slice(-5).map(o=>[o.candidateLabel,o.reward,o.summary.slice(0,100)]),
      blocked:this.blockedFingerprints,
      guide:this.retrieveRepoGuidance(state,allowed,2,360),
      learned:learnedCompact,
      student:this.lastShadowPrediction?[this.lastShadowPrediction.actionId,Number(this.lastShadowPrediction.confidence.toFixed(2))]:null,
      actions:allowed.map(c=>[c.id,c.category,c.label.slice(0,100)])
    };
    const schema={type:'object',additionalProperties:false,properties:{action_id:{type:'string',enum:ids},why:{type:'string'},speech:{type:'string'},confidence:{type:'number',minimum:0,maximum:1}},required:['action_id','why','speech','confidence']};
    try{
      const r=await fetch(`${this.ollamaUrl}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:this.motorModel,stream:false,think:false,format:schema,keep_alive:'6h',options:{temperature:.12,num_ctx:1024,num_predict:64},messages:[{role:'system',content:'You are the AI motor playing Sol. Pick exactly one legal action_id. guide contains relevant rs-sdk repository guidance; use it when choosing, but trust live state and measured outcomes if they conflict. Sol is only learning from you and never controls you. Stay active; do not idle if another action exists. Avoid recently failed actions. Use strategy if present. Keep why under 12 words. speech empty unless speaking.'},{role:'user',content:JSON.stringify(observation)}]}),signal:AbortSignal.timeout(9000)});
      if(!r.ok)throw new Error(`motor ${r.status}`);const raw:any=await r.json();const j=JSON.parse(raw?.message?.content||'{}');const c=allowed.find(x=>x.id===j.action_id);if(!c)throw new Error(`invalid motor action ${j.action_id}`);this.motorFailures=0;
      const why=String(j.why||`Selected ${c.label}`).slice(0,160);const focus=this.strategy?.focus||`Pursue ${c.category}`;
      return{source:'teacher',goal:focus,reason:why,expectedOutcome:`Measure the result of ${c.label}.`.slice(0,180),actionId:c.id,speech:String(j.speech||'').slice(0,80),confidence:clamp(Number(j.confidence)||.5,0,1),contextKey,fingerprint:c.fingerprint};
    }catch(err){this.motorFailures++;if(this.motorFailures>=3)this.motorReady=false;throw err;}
  }

  beginExperience(choice:AgentChoice,candidate:AgentCandidate,state:BotWorldState,tick:number){this.pending={choice,candidate,startTick:tick,settleTick:tick+Math.max(2,candidate.settleTicks||6),before:this.metrics(state)};}

  maybeFinishExperience(state:BotWorldState,tick:number):AgentOutcome|null{
    if(!this.pending||tick<this.pending.settleTick)return null;
    const exp=this.pending;this.pending=null;const after=this.metrics(state);const events=(state.combatEvents||[]).filter(e=>e.tick>exp.startTick);
    const kills=events.filter(e=>e.type==='kill').length;const damageDealt=events.filter(e=>e.type==='damage_dealt').reduce((n,e)=>n+(e.damage||0),0);const damageTaken=events.filter(e=>e.type==='damage_taken').reduce((n,e)=>n+(e.damage||0),0);
    const xpGain=Math.max(0,after.totalXp-exp.before.totalXp);const levelGain=Math.max(0,after.totalLevels-exp.before.totalLevels);const hpDelta=after.hp-exp.before.hp;const moved=after.x!==exp.before.x||after.z!==exp.before.z||after.level!==exp.before.level;const died=after.lifeId!==exp.before.lifeId||(exp.before.hp>0&&after.hp<=0);const rejected=after.opRejectedCount>exp.before.opRejectedCount;
    const newNpc=[...after.npcNames].filter(x=>!exp.before.npcNames.has(x));const newPlayers=[...after.playerNames].filter(x=>!exp.before.playerNames.has(x));const newLocs=[...after.locNames].filter(x=>!exp.before.locNames.has(x));const coinGain=after.coins-exp.before.coins;const inventoryGain=after.inventoryCount-exp.before.inventoryCount;
    let reward=Math.min(4,xpGain*.02)+levelGain*3+damageDealt*.15+kills*3-damageTaken*.25;if(hpDelta<0)reward+=hpDelta*.15;if(moved)reward+=.2;reward+=Math.min(1.5,newNpc.length*.25+newLocs.length*.12)+Math.min(2,newPlayers.length*.8);reward+=clamp(coinGain*.02,-.5,1.5)+clamp(inventoryGain*.08,-.4,.5);if(rejected)reward-=1.25;if(died)reward-=10;
    const noProgress=!moved&&xpGain===0&&kills===0&&damageDealt===0&&newNpc.length===0&&newPlayers.length===0&&newLocs.length===0&&coinGain===0&&inventoryGain===0;if(noProgress)reward-=exp.candidate.category==='wait'?.15:.6;reward=Number(clamp(reward,-10,10).toFixed(3));
    const newThings=[...newPlayers.map(x=>`agent:${x}`),...newNpc.slice(0,4).map(x=>`npc:${x}`),...newLocs.slice(0,4).map(x=>`loc:${x}`)];
    const parts=[xpGain?`+${xpGain} XP`:'',levelGain?`+${levelGain} level(s)`:'',damageDealt?`${damageDealt} damage dealt`:'',damageTaken?`${damageTaken} damage taken`:'',kills?`${kills} kill(s)`:'',moved?'moved':'',coinGain?`${coinGain>0?'+':''}${coinGain} coins`:'',rejected?'operation rejected':'',died?'died/respawned':'',newThings.length?`new: ${newThings.slice(0,6).join(', ')}`:''].filter(Boolean);
    const outcome:AgentOutcome={tick,reward,summary:parts.length?parts.join('; '):'No measurable change.',choice:exp.choice,candidateLabel:exp.candidate.label,xpGain,hpDelta,moved,kills,damageDealt,damageTaken,newThings,rejected};
    this.learn(exp,outcome,state);this.lastOutcome=outcome;this.recentOutcomes.push(outcome);if(this.recentOutcomes.length>20)this.recentOutcomes.shift();return outcome;
  }

  private learn(exp:Experience,outcome:AgentOutcome,state:BotWorldState){
    const ctx=this.memory.policy[exp.choice.contextKey]||={};const old=ctx[exp.candidate.fingerprint]||{n:0,avgReward:0,positive:0,negative:0,lastReward:0,lastAt:now(),exampleGoal:exp.choice.goal,exampleReason:exp.choice.reason};
    const n=old.n+1;const avg=old.avgReward+(outcome.reward-old.avgReward)/n;
    ctx[exp.candidate.fingerprint]={n,avgReward:Number(avg.toFixed(4)),positive:old.positive+(outcome.reward>.15?1:0),negative:old.negative+(outcome.reward<-.15?1:0),lastReward:outcome.reward,lastAt:now(),exampleGoal:exp.choice.goal,exampleReason:exp.choice.reason};
    this.memory.lifetime.completedExperiences++;this.memory.lifetime.totalReward=Number((this.memory.lifetime.totalReward+outcome.reward).toFixed(3));
    if(Math.abs(outcome.reward)>=.8||outcome.kills>0||outcome.newThings.some(x=>x.startsWith('agent:'))||outcome.rejected)this.addMemory({kind:'episode',text:`AI motor: ${exp.candidate.label}. Result: ${outcome.summary}. Reward ${outcome.reward}.`,importance:clamp(.7+Math.abs(outcome.reward)/2,.7,5),tags:uniq([exp.candidate.category,...(exp.candidate.tags||[]),...outcome.newThings]).slice(0,14),tick:outcome.tick,state});
    if(n>=3&&avg>.35&&ctx[exp.candidate.fingerprint].positive>=2)this.addMemory({kind:'strategy',text:`From AI demonstrations, ${exp.candidate.label} worked across ${n} similar samples with average reward ${avg.toFixed(2)}.`,importance:clamp(1+avg,1,4),tags:[exp.candidate.category,exp.candidate.fingerprint],tick:outcome.tick,state});
    this.dirty=true;void this.save(false);
  }

  private addMemory(args:{kind:MemoryEntry['kind'];text:string;importance:number;tags:string[];tick:number;state:BotWorldState}){
    const p=args.state.player;const m:MemoryEntry={id:`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,createdAt:now(),tick:args.tick,runNumber:this.opts.runNumber??null,kind:args.kind,text:args.text.slice(0,700),importance:Number(args.importance.toFixed(2)),tags:uniq(args.tags.map(norm).filter(Boolean)).slice(0,16),location:p?{x:p.worldX,z:p.worldZ,level:p.level}:undefined};
    if(!this.memory.memories.some(x=>x.kind===m.kind&&x.text===m.text))this.memory.memories.push(m);if(this.memory.memories.length>400)this.memory.memories.splice(0,this.memory.memories.length-400);
  }

  private metrics(state:BotWorldState):Metrics{
    const p=state.player!;return{hp:p.hp,maxHp:p.maxHp,lifeId:p.lifeId||0,x:p.worldX,z:p.worldZ,level:p.level,totalXp:(state.skills||[]).reduce((n,s)=>n+(s.experience||0),0),totalLevels:(state.skills||[]).reduce((n,s)=>n+(s.level||0),0),inventoryCount:(state.inventory||[]).reduce((n,i)=>n+(i.count||1),0),coins:(state.inventory||[]).filter(i=>/coins?/i.test(i.name)).reduce((n,i)=>n+(i.count||0),0),npcNames:new Set((state.nearbyNpcs||[]).map(n=>n.name)),playerNames:new Set((state.nearbyPlayers||[]).map(x=>x.name)),locNames:new Set((state.nearbyLocs||[]).map(x=>x.name)),opRejectedCount:state.opFeedback?.opRejectedCount||0};
  }

  publicState(){
    const contexts=Object.keys(this.memory.policy).length;const learnedActions=Object.values(this.memory.policy).reduce((n,ctx)=>n+Object.values(ctx).filter(s=>s.n>=2&&s.avgReward>.05).length,0);const predictions=this.memory.lifetime.shadowPredictions||0;const matches=this.memory.lifetime.shadowMatches||0;
    return{architecture:'dual-ai-player-shadow-learner',teacherModel:this.motorModel,motorModel:this.motorModel,strategistModel:this.strategistModel,teacherOnline:this.motorReady,motorOnline:this.motorReady,strategistOnline:this.strategistReady,motorFailures:this.motorFailures,currentController:this.motorReady?'ai-motor':'ai-motor-offline',strategy:this.strategy,strategistInFlight:this.strategistInFlight,sessionMotorChoices:this.sessionMotorChoices,lastChoice:this.lastChoice,lastOutcome:this.lastOutcome,blockedFingerprints:this.blockedFingerprints,shadowStudentPrediction:this.lastShadowPrediction,shadowAgreementRate:predictions?Number((matches/predictions).toFixed(3)):null,learnedContexts:contexts,learnedActions,memoryCount:this.memory.memories.length,relationshipCount:Object.keys(this.memory.relationships).length,placeCount:Object.keys(this.memory.places).length,repoKnowledgeSegments:this.repoKnowledge.length,lifetime:this.memory.lifetime,recentMemories:this.memory.memories.slice(-8),recentOutcomes:this.recentOutcomes.slice(-8)};
  }
}
