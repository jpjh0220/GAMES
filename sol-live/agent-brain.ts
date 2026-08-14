import type { BotWorldState } from './src/bot/types.js';

export type AgentCandidate = {
  id: string;
  label: string;
  category: string;
  fingerprint: string;
  action: any;
  tags?: string[];
  settleTicks?: number;
};

export type AgentChoice = {
  source: 'teacher' | 'student';
  goal: string;
  reason: string;
  expectedOutcome: string;
  actionId: string;
  speech?: string;
  confidence: number;
  contextKey: string;
  fingerprint: string;
};

type PolicyStat = {
  n: number;
  avgReward: number;
  positive: number;
  negative: number;
  lastReward: number;
  lastAt: string;
  exampleGoal: string;
  exampleReason: string;
};

type MemoryEntry = {
  id: string;
  createdAt: string;
  tick: number;
  runNumber: number | null;
  kind: 'episode' | 'strategy' | 'relationship' | 'place';
  text: string;
  importance: number;
  tags: string[];
  location?: { x: number; z: number; level: number };
};

type PersistentState = {
  version: number;
  identity: { name: string; bornAt: string; directive: string };
  lifetime: {
    totalChoices: number;
    teacherChoices: number;
    studentChoices: number; // legacy: executable student actions; should remain unchanged from now on
    reflexActions: number;
    completedExperiences: number;
    totalReward: number;
    saves: number;
    shadowPredictions?: number;
    shadowMatches?: number;
  };
  memories: MemoryEntry[];
  policy: Record<string, Record<string, PolicyStat>>;
  relationships: Record<string, { name:string; firstSeenAt:string; lastSeenAt:string; encounters:number; combatLevel?:number }>;
  places: Record<string, { key:string; x:number; z:number; level:number; firstSeenAt:string; lastSeenAt:string; visits:number; npcs:string[]; locs:string[] }>;
  updatedAt: string;
};

type Metrics = {
  hp:number; maxHp:number; lifeId:number; x:number; z:number; level:number;
  totalXp:number; totalLevels:number; inventoryCount:number; coins:number;
  npcNames:Set<string>; playerNames:Set<string>; locNames:Set<string>;
  opRejectedCount:number;
};

type Experience = {
  choice: AgentChoice;
  candidate: AgentCandidate;
  startTick: number;
  settleTick: number;
  before: Metrics;
};

export type AgentOutcome = {
  tick:number;
  reward:number;
  summary:string;
  choice:AgentChoice;
  candidateLabel:string;
  xpGain:number;
  hpDelta:number;
  moved:boolean;
  kills:number;
  damageDealt:number;
  damageTaken:number;
  newThings:string[];
  rejected:boolean;
};

const now = () => new Date().toISOString();
const clamp = (n:number, lo:number, hi:number) => Math.max(lo, Math.min(hi, n));
const uniq = <T>(xs:T[]) => [...new Set(xs)];
const norm = (s:string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const toks = (s:string) => new Set(norm(s).split(/\s+/).filter(x => x.length > 2));

const freshState = (name:string, directive:string):PersistentState => ({
  version:1,
  identity:{name,bornAt:now(),directive},
  lifetime:{totalChoices:0,teacherChoices:0,studentChoices:0,reflexActions:0,completedExperiences:0,totalReward:0,saves:0,shadowPredictions:0,shadowMatches:0},
  memories:[], policy:{}, relationships:{}, places:{}, updatedAt:now()
});

export class SolAgentBrain {
  private memory:PersistentState;
  private pending:Experience|null = null;
  private githubSha:string|null = null;
  private dirty = false;
  private lastSaveAt = 0;
  private modelReady = false;
  private modelFailures = 0;
  private lastChoice:AgentChoice|null = null;
  private lastOutcome:AgentOutcome|null = null;
  private lastShadowPrediction:AgentChoice|null = null;
  private recentOutcomes:AgentOutcome[] = [];

  constructor(private readonly opts:{
    name:string; directive:string; model?:string; ollamaUrl?:string;
    githubToken?:string; githubRepo?:string; runNumber?:number|null;
  }) {
    this.memory = freshState(opts.name, opts.directive);
  }

  get model(){ return this.opts.model || 'qwen3:1.7b'; }
  get ollamaUrl(){ return this.opts.ollamaUrl || 'http://127.0.0.1:11434'; }

  async init(){
    await this.load();
    this.modelReady = await this.checkModel();
  }

  private async checkModel(){
    try {
      const r = await fetch(`${this.ollamaUrl}/api/tags`, {signal:AbortSignal.timeout(4000)});
      if(!r.ok) return false;
      const j:any = await r.json();
      return (j.models || []).some((m:any) => String(m.name || '').startsWith(this.model.split(':')[0]));
    } catch { return false; }
  }

  private async load(){
    if(!this.opts.githubToken || !this.opts.githubRepo) return;
    try {
      const r = await fetch(`https://api.github.com/repos/${this.opts.githubRepo}/contents/sol-agent/state.json?ref=sol-memory&t=${Date.now()}`, {
        headers:{
          Accept:'application/vnd.github+json',
          Authorization:`Bearer ${this.opts.githubToken}`,
          'X-GitHub-Api-Version':'2022-11-28'
        }
      });
      if(r.status === 404) return;
      if(!r.ok) throw new Error(`memory load ${r.status}`);
      const body:any = await r.json();
      this.githubSha = body.sha || null;
      const parsed = JSON.parse(Buffer.from(String(body.content || '').replace(/\n/g,''),'base64').toString('utf8'));
      if(parsed?.version === 1 && parsed?.identity && parsed?.lifetime){
        this.memory = parsed;
        this.memory.identity.directive = this.opts.directive;
        this.memory.lifetime.shadowPredictions ??= 0;
        this.memory.lifetime.shadowMatches ??= 0;
        this.memory.memories ||= [];
        this.memory.policy ||= {};
        this.memory.relationships ||= {};
        this.memory.places ||= {};
      }
    } catch(err){ console.warn('AGENT_MEMORY_LOAD_FAILED', String(err)); }
  }

  async save(force=false){
    if(!this.opts.githubToken || !this.opts.githubRepo || !this.dirty) return false;
    if(!force && Date.now()-this.lastSaveAt < 5*60_000 && this.memory.lifetime.completedExperiences % 10 !== 0) return false;
    try {
      this.memory.updatedAt = now();
      this.memory.lifetime.saves++;
      const payload:any = {
        message:`Persist Sol AI demonstrations (${this.memory.lifetime.completedExperiences} experiences)`,
        content:Buffer.from(JSON.stringify(this.memory,null,2)+'\n').toString('base64'),
        branch:'sol-memory'
      };
      if(this.githubSha) payload.sha = this.githubSha;
      const r = await fetch(`https://api.github.com/repos/${this.opts.githubRepo}/contents/sol-agent/state.json`, {
        method:'PUT',
        headers:{
          Accept:'application/vnd.github+json',
          Authorization:`Bearer ${this.opts.githubToken}`,
          'X-GitHub-Api-Version':'2022-11-28',
          'Content-Type':'application/json'
        },
        body:JSON.stringify(payload)
      });
      if(!r.ok) throw new Error(`memory save ${r.status}: ${await r.text()}`);
      const body:any = await r.json();
      this.githubSha = body?.content?.sha || this.githubSha;
      this.lastSaveAt = Date.now();
      this.dirty = false;
      return true;
    } catch(err){
      console.warn('AGENT_MEMORY_SAVE_FAILED', String(err));
      return false;
    }
  }

  noteReflex(){ this.memory.lifetime.reflexActions++; this.dirty = true; }

  private observe(state:BotWorldState){
    const t=now();
    for(const p of state.nearbyPlayers || []){
      const k=norm(p.name); if(!k) continue;
      const old=this.memory.relationships[k];
      this.memory.relationships[k]=old
        ? {...old,lastSeenAt:t,encounters:old.encounters+1,combatLevel:p.combatLevel}
        : {name:p.name,firstSeenAt:t,lastSeenAt:t,encounters:1,combatLevel:p.combatLevel};
    }
    if(state.player){
      const {worldX:x,worldZ:z,level}=state.player;
      const k=`${Math.floor(x/16)}:${Math.floor(z/16)}:${level}`;
      const npcs=uniq((state.nearbyNpcs||[]).map(n=>n.name).filter(Boolean)).slice(0,20);
      const locs=uniq((state.nearbyLocs||[]).map(l=>l.name).filter(Boolean)).slice(0,30);
      const old=this.memory.places[k];
      this.memory.places[k]=old
        ? {...old,x,z,lastSeenAt:t,visits:old.visits+1,npcs:uniq([...old.npcs,...npcs]).slice(-30),locs:uniq([...old.locs,...locs]).slice(-40)}
        : {key:k,x,z,level,firstSeenAt:t,lastSeenAt:t,visits:1,npcs,locs};
    }
    this.dirty=true;
  }

  private contextKey(state:BotWorldState,candidates:AgentCandidate[]){
    const p=state.player!;
    const ratio=p.maxHp ? p.hp/p.maxHp : 1;
    const hp=ratio<.35?'critical':ratio<.65?'hurt':'healthy';
    const food=(state.inventory||[]).some(i=>i.optionsWithIndex?.some(o=>/^eat$|^drink$/i.test(o.text)))?1:0;
    const cats=uniq(candidates.map(c=>c.category)).sort().slice(0,12).join(',');
    return `hp=${hp}|combat=${p.combat?.inCombat?1:0}|agents=${(state.nearbyPlayers?.length||0)>0?1:0}|food=${food}|dialog=${state.dialog?.isOpen?1:0}|bank=${state.bank?.isOpen?1:0}|shop=${state.shop?.isOpen?1:0}|cats=${cats}`;
  }

  private shadowPrediction(candidates:AgentCandidate[],contextKey:string):AgentChoice|null{
    const stats=this.memory.policy[contextKey];
    if(!stats) return null;
    let best:{c:AgentCandidate;s:PolicyStat;confidence:number}|null=null;
    for(const c of candidates){
      if(c.category==='say' || c.category==='wait') continue;
      const s=stats[c.fingerprint]; if(!s || s.n<2) continue;
      const success=s.positive/Math.max(1,s.n);
      const confidence=clamp((s.n/8)*.35 + success*.4 + clamp((s.avgReward+1)/3,0,1)*.25,0,1);
      if(s.avgReward<.05 || confidence<.52) continue;
      if(!best || confidence>best.confidence || (confidence===best.confidence && s.avgReward>best.s.avgReward)) best={c,s,confidence};
    }
    if(!best) return null;
    return {
      source:'student',
      goal:best.s.exampleGoal || 'Predict the AI player',
      reason:`Shadow learner predicts this from ${best.s.n} prior AI demonstrations with average reward ${best.s.avgReward.toFixed(2)}.`,
      expectedOutcome:'Prediction only; the AI player still decides.',
      actionId:best.c.id,
      confidence:best.confidence,
      contextKey,
      fingerprint:best.c.fingerprint
    };
  }

  private relevantMemories(state:BotWorldState,candidates:AgentCandidate[]){
    const query=[
      ...(state.nearbyNpcs||[]).map(n=>n.name),
      ...(state.nearbyPlayers||[]).map(p=>p.name),
      ...(state.nearbyLocs||[]).slice(0,10).map(l=>l.name),
      ...(state.inventory||[]).slice(0,12).map(i=>i.name),
      ...candidates.slice(0,16).map(c=>c.label)
    ].join(' ');
    const q=toks(query);
    return this.memory.memories.map((m,i)=>{
      const mt=toks(`${m.text} ${m.tags.join(' ')}`); let overlap=0;
      for(const x of q) if(mt.has(x)) overlap++;
      return {m,score:m.importance*2+overlap+(i/Math.max(1,this.memory.memories.length))};
    }).sort((a,b)=>b.score-a.score).slice(0,6).map(x=>({kind:x.m.kind,text:x.m.text,importance:x.m.importance}));
  }

  private balancedCandidates(candidates:AgentCandidate[]){
    // The AI is the player. Hide casual waiting whenever any productive action exists.
    const productive=candidates.some(c=>c.category!=='wait') ? candidates.filter(c=>c.category!=='wait') : candidates;
    const order=['dialog','modal','recovery','combat','economy','social','pickup','world','inventory','combat-style','explore','wait'];
    const out:AgentCandidate[]=[];
    for(const category of order){
      for(const c of productive.filter(x=>x.category===category).slice(0,2)){
        if(out.length<24 && !out.some(x=>x.id===c.id)) out.push(c);
      }
    }
    for(const c of productive){
      if(out.length>=24) break;
      if(!out.some(x=>x.id===c.id)) out.push(c);
    }
    return out;
  }

  async decide(state:BotWorldState,candidates:AgentCandidate[]):Promise<AgentChoice>{
    this.observe(state);
    const contextKey=this.contextKey(state,candidates);
    this.lastShadowPrediction=this.shadowPrediction(candidates,contextKey);

    if(!this.modelReady) this.modelReady=await this.checkModel();
    if(!this.modelReady) throw new Error('AI player unavailable: Qwen is offline');

    const teacher=await this.askAI(state,candidates,contextKey);
    this.memory.lifetime.totalChoices++;
    this.memory.lifetime.teacherChoices++;
    if(this.lastShadowPrediction){
      this.memory.lifetime.shadowPredictions=(this.memory.lifetime.shadowPredictions||0)+1;
      if(this.lastShadowPrediction.fingerprint===teacher.fingerprint) this.memory.lifetime.shadowMatches=(this.memory.lifetime.shadowMatches||0)+1;
    }
    this.lastChoice=teacher;
    this.dirty=true;
    return teacher;
  }

  private async askAI(state:BotWorldState,candidates:AgentCandidate[],contextKey:string):Promise<AgentChoice>{
    const allowed=this.balancedCandidates(candidates);
    if(!allowed.length) throw new Error('No legal actions available for AI player');
    const ids=allowed.map(c=>c.id);
    const p=state.player!;
    const learned=this.memory.policy[contextKey]||{};
    const learnedCompact=Object.entries(learned).sort((a,b)=>b[1].n-a[1].n).slice(0,8).map(([fingerprint,s])=>({fingerprint,n:s.n,avgReward:s.avgReward,positive:s.positive,negative:s.negative}));
    const observation={
      player:{hp:p.hp,maxHp:p.maxHp,combatLevel:p.combatLevel,pos:[p.worldX,p.worldZ,p.level],runEnergy:p.runEnergy,inCombat:p.combat?.inCombat,respawns:p.respawnCount},
      skills:(state.skills||[]).filter(s=>!/^Stat\d+$/i.test(s.name)).map(s=>[s.name,s.level]),
      inventory:(state.inventory||[]).slice(0,16).map(i=>[i.name,i.count]),
      equipment:(state.equipment||[]).slice(0,10).map(i=>i.name),
      npcs:(state.nearbyNpcs||[]).slice(0,10).map(n=>({name:n.name,lvl:n.combatLevel,d:n.distance,hp:n.hp,max:n.maxHp,combat:n.inCombat,options:n.options})),
      players:(state.nearbyPlayers||[]).slice(0,6).map(x=>({name:x.name,lvl:x.combatLevel,d:x.distance})),
      objects:(state.nearbyLocs||[]).slice(0,10).map(l=>({name:l.name,d:l.distance,options:l.options})),
      ground:(state.groundItems||[]).slice(0,8).map(g=>({name:g.name,count:g.count,d:g.distance})),
      messages:(state.gameMessages||[]).slice(-4).map(m=>({sender:m.sender,text:m.text,self:m.fromSelf})),
      memories:this.relevantMemories(state,allowed),
      outcomes:this.recentOutcomes.slice(-4).map(o=>({action:o.candidateLabel,reward:o.reward,summary:o.summary})),
      learned:learnedCompact,
      studentPrediction:this.lastShadowPrediction?{actionId:this.lastShadowPrediction.actionId,confidence:Number(this.lastShadowPrediction.confidence.toFixed(2))}:null,
      actions:allowed.map(c=>({id:c.id,label:c.label,category:c.category}))
    };
    const schema={
      type:'object',additionalProperties:false,
      properties:{
        goal:{type:'string'},reason:{type:'string'},expected_outcome:{type:'string'},
        action_id:{type:'string',enum:ids},speech:{type:'string'},confidence:{type:'number',minimum:0,maximum:1}
      },
      required:['goal','reason','expected_outcome','action_id','speech','confidence']
    };
    const body={
      model:this.model,stream:false,think:false,format:schema,keep_alive:'6h',
      options:{temperature:.18,num_ctx:3072,num_predict:180},
      messages:[
        {role:'system',content:[
          'You are the AI player controlling Sol in a persistent shared RuneScape-style research world.',
          'You choose EVERY normal gameplay action. Sol is your student: its learned policy only watches, predicts, and learns from your demonstrated actions and measured outcomes. It never controls gameplay.',
          'Choose exactly one supplied action_id and never invent an ID.',
          'Stay active. If a useful legal action exists, do not idle. Prefer movement, interaction, training, gathering, communication, equipment use, or discovery.',
          'Use recent measured outcomes to avoid loops and failed routes. Change strategy when an action repeatedly produces no progress or harm.',
          'Protect survival, but take reasonable exploratory risks. Build competence, resources, world knowledge, and social knowledge over time.',
          'The studentPrediction is only a diagnostic prediction. You are free to agree or teach it something different.',
          'Keep goal and reason short and concrete. speech must be empty unless the selected action is a say action.'
        ].join(' ')},
        {role:'user',content:JSON.stringify(observation)}
      ]
    };
    try{
      const r=await fetch(`${this.ollamaUrl}/api/chat`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)
      });
      if(!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
      const raw:any=await r.json();
      const parsed=JSON.parse(raw?.message?.content||'{}');
      const c=allowed.find(x=>x.id===parsed.action_id);
      if(!c) throw new Error(`AI returned invalid action ${parsed.action_id}`);
      this.modelFailures=0;
      return {
        source:'teacher',
        goal:String(parsed.goal||'Act and learn').slice(0,220),
        reason:String(parsed.reason||'Chosen from live perception.').slice(0,420),
        expectedOutcome:String(parsed.expected_outcome||'Observe the result.').slice(0,260),
        actionId:c.id,
        speech:String(parsed.speech||'').slice(0,80),
        confidence:clamp(Number(parsed.confidence)||.5,0,1),
        contextKey,
        fingerprint:c.fingerprint
      };
    }catch(err){
      this.modelFailures++;
      if(this.modelFailures>=3) this.modelReady=false;
      // No scripted normal-action fallback. If the AI cannot decide, only emergency reflexes may act.
      throw err;
    }
  }

  beginExperience(choice:AgentChoice,candidate:AgentCandidate,state:BotWorldState,tick:number){
    this.pending={choice,candidate,startTick:tick,settleTick:tick+Math.max(2,candidate.settleTicks||6),before:this.metrics(state)};
  }

  maybeFinishExperience(state:BotWorldState,tick:number):AgentOutcome|null{
    if(!this.pending || tick<this.pending.settleTick) return null;
    const exp=this.pending; this.pending=null;
    const after=this.metrics(state);
    const events=(state.combatEvents||[]).filter(e=>e.tick>exp.startTick);
    const kills=events.filter(e=>e.type==='kill').length;
    const damageDealt=events.filter(e=>e.type==='damage_dealt').reduce((n,e)=>n+(e.damage||0),0);
    const damageTaken=events.filter(e=>e.type==='damage_taken').reduce((n,e)=>n+(e.damage||0),0);
    const xpGain=Math.max(0,after.totalXp-exp.before.totalXp);
    const levelGain=Math.max(0,after.totalLevels-exp.before.totalLevels);
    const hpDelta=after.hp-exp.before.hp;
    const moved=after.x!==exp.before.x||after.z!==exp.before.z||after.level!==exp.before.level;
    const died=after.lifeId!==exp.before.lifeId||(exp.before.hp>0&&after.hp<=0);
    const rejected=after.opRejectedCount>exp.before.opRejectedCount;
    const newNpc=[...after.npcNames].filter(x=>!exp.before.npcNames.has(x));
    const newPlayers=[...after.playerNames].filter(x=>!exp.before.playerNames.has(x));
    const newLocs=[...after.locNames].filter(x=>!exp.before.locNames.has(x));
    const coinGain=after.coins-exp.before.coins;
    const inventoryGain=after.inventoryCount-exp.before.inventoryCount;

    let reward=0;
    reward+=Math.min(4,xpGain*.02)+levelGain*3+damageDealt*.15+kills*3-damageTaken*.25;
    if(hpDelta<0) reward+=hpDelta*.15;
    if(moved) reward+=.2;
    reward+=Math.min(1.5,newNpc.length*.25+newLocs.length*.12)+Math.min(2,newPlayers.length*.8);
    reward+=clamp(coinGain*.02,-.5,1.5)+clamp(inventoryGain*.08,-.4,.5);
    if(rejected) reward-=1.25;
    if(died) reward-=10;
    const noProgress=!moved&&xpGain===0&&kills===0&&damageDealt===0&&newNpc.length===0&&newPlayers.length===0&&newLocs.length===0&&coinGain===0&&inventoryGain===0;
    if(noProgress) reward-=exp.candidate.category==='wait'?.15:.6;
    reward=Number(clamp(reward,-10,10).toFixed(3));

    const newThings=[...newPlayers.map(x=>`agent:${x}`),...newNpc.slice(0,4).map(x=>`npc:${x}`),...newLocs.slice(0,4).map(x=>`loc:${x}`)];
    const parts=[xpGain?`+${xpGain} XP`:'',levelGain?`+${levelGain} level(s)`:'' ,damageDealt?`${damageDealt} damage dealt`:'',damageTaken?`${damageTaken} damage taken`:'',kills?`${kills} kill(s)`:'' ,moved?'moved':'',coinGain?`${coinGain>0?'+':''}${coinGain} coins`:'',rejected?'operation rejected':'',died?'died/respawned':'',newThings.length?`new: ${newThings.slice(0,6).join(', ')}`:''].filter(Boolean);
    const outcome:AgentOutcome={tick,reward,summary:parts.length?parts.join('; '):'No measurable change.',choice:exp.choice,candidateLabel:exp.candidate.label,xpGain,hpDelta,moved,kills,damageDealt,damageTaken,newThings,rejected};
    this.learn(exp,outcome,state);
    this.lastOutcome=outcome;
    this.recentOutcomes.push(outcome); if(this.recentOutcomes.length>20) this.recentOutcomes.shift();
    return outcome;
  }

  private learn(exp:Experience,outcome:AgentOutcome,state:BotWorldState){
    const ctx=this.memory.policy[exp.choice.contextKey]||={};
    const old=ctx[exp.candidate.fingerprint]||{n:0,avgReward:0,positive:0,negative:0,lastReward:0,lastAt:now(),exampleGoal:exp.choice.goal,exampleReason:exp.choice.reason};
    const n=old.n+1;
    const avg=old.avgReward+(outcome.reward-old.avgReward)/n;
    ctx[exp.candidate.fingerprint]={n,avgReward:Number(avg.toFixed(4)),positive:old.positive+(outcome.reward>.15?1:0),negative:old.negative+(outcome.reward<-.15?1:0),lastReward:outcome.reward,lastAt:now(),exampleGoal:exp.choice.goal,exampleReason:exp.choice.reason};
    this.memory.lifetime.completedExperiences++;
    this.memory.lifetime.totalReward=Number((this.memory.lifetime.totalReward+outcome.reward).toFixed(3));

    if(Math.abs(outcome.reward)>=.8||outcome.kills>0||outcome.newThings.some(x=>x.startsWith('agent:'))||outcome.rejected){
      this.addMemory({kind:'episode',text:`AI goal: ${exp.choice.goal}. AI action: ${exp.candidate.label}. Result: ${outcome.summary}. Reward ${outcome.reward}.`,importance:clamp(.7+Math.abs(outcome.reward)/2,.7,5),tags:uniq([exp.candidate.category,...(exp.candidate.tags||[]),...outcome.newThings]).slice(0,14),tick:outcome.tick,state});
    }
    if(n>=3&&avg>.35&&ctx[exp.candidate.fingerprint].positive>=2){
      this.addMemory({kind:'strategy',text:`From AI demonstrations, ${exp.candidate.label} has worked in this context across ${n} samples with average reward ${avg.toFixed(2)}.`,importance:clamp(1+avg,1,4),tags:[exp.candidate.category,exp.candidate.fingerprint],tick:outcome.tick,state});
    }
    this.dirty=true;
    void this.save(false);
  }

  private addMemory(args:{kind:MemoryEntry['kind'];text:string;importance:number;tags:string[];tick:number;state:BotWorldState}){
    const p=args.state.player;
    const m:MemoryEntry={id:`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,createdAt:now(),tick:args.tick,runNumber:this.opts.runNumber??null,kind:args.kind,text:args.text.slice(0,700),importance:Number(args.importance.toFixed(2)),tags:uniq(args.tags.map(norm).filter(Boolean)).slice(0,16),location:p?{x:p.worldX,z:p.worldZ,level:p.level}:undefined};
    if(!this.memory.memories.some(x=>x.kind===m.kind&&x.text===m.text)) this.memory.memories.push(m);
    if(this.memory.memories.length>400) this.memory.memories.splice(0,this.memory.memories.length-400);
  }

  private metrics(state:BotWorldState):Metrics{
    const p=state.player!;
    return {
      hp:p.hp,maxHp:p.maxHp,lifeId:p.lifeId||0,x:p.worldX,z:p.worldZ,level:p.level,
      totalXp:(state.skills||[]).reduce((n,s)=>n+(s.experience||0),0),
      totalLevels:(state.skills||[]).reduce((n,s)=>n+(s.level||0),0),
      inventoryCount:(state.inventory||[]).reduce((n,i)=>n+(i.count||1),0),
      coins:(state.inventory||[]).filter(i=>/coins?/i.test(i.name)).reduce((n,i)=>n+(i.count||0),0),
      npcNames:new Set((state.nearbyNpcs||[]).map(n=>n.name)),
      playerNames:new Set((state.nearbyPlayers||[]).map(x=>x.name)),
      locNames:new Set((state.nearbyLocs||[]).map(x=>x.name)),
      opRejectedCount:state.opFeedback?.opRejectedCount||0
    };
  }

  publicState(){
    const contexts=Object.keys(this.memory.policy).length;
    const learnedActions=Object.values(this.memory.policy).reduce((n,ctx)=>n+Object.values(ctx).filter(s=>s.n>=2&&s.avgReward>.05).length,0);
    const predictions=this.memory.lifetime.shadowPredictions||0;
    const matches=this.memory.lifetime.shadowMatches||0;
    return {
      architecture:'ai-player-shadow-learner',
      teacherModel:this.model,
      teacherOnline:this.modelReady,
      modelFailures:this.modelFailures,
      currentController:this.modelReady?'ai':'ai-offline',
      lastChoice:this.lastChoice,
      lastOutcome:this.lastOutcome,
      shadowStudentPrediction:this.lastShadowPrediction,
      shadowAgreementRate:predictions?Number((matches/predictions).toFixed(3)):null,
      learnedContexts:contexts,
      learnedActions,
      memoryCount:this.memory.memories.length,
      relationshipCount:Object.keys(this.memory.relationships).length,
      placeCount:Object.keys(this.memory.places).length,
      lifetime:this.memory.lifetime,
      recentMemories:this.memory.memories.slice(-8),
      recentOutcomes:this.recentOutcomes.slice(-8)
    };
  }
}
