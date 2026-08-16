import type { BotWorldState } from './src/bot/types.js';
import type { AgentCandidate, AgentChoice } from './agent-brain.js';

export type PersistentSolEnvelope = {
  schemaVersion:1;
  identity:{name:string;bornAt:string};
  activeTask:string;
  stateGeneration:number;
  lastCommittedTick:number;
  controllerVersion:string;
};

export type ControllerContext = {
  tick:number;
  currentTask:string;
  externalDirective:string|null;
};

export type SolController = {
  id:string;
  version:string;
  decide(state:BotWorldState,candidates:AgentCandidate[],context:ControllerContext):Promise<AgentChoice>;
};

export type ControllerStatus = {
  activeId:string;
  activeVersion:string;
  fallbackId:string;
  pendingId:string|null;
  pendingVersion:string|null;
  stateGeneration:number;
  lastSwitchTick:number;
  lastError:string|null;
};

const valid=(x:any):x is SolController=>!!x&&typeof x.id==='string'&&typeof x.version==='string'&&typeof x.decide==='function';

export class ControllerRegistry {
  private readonly controllers=new Map<string,SolController>();
  private active:SolController;
  private pending:SolController|null=null;
  private lastSwitchTick=-1;
  private lastError:string|null=null;
  private readonly fallbackId:string;

  constructor(fallback:SolController){
    if(!valid(fallback))throw new Error('invalid fallback controller');
    this.fallbackId=fallback.id;this.controllers.set(`${fallback.id}@${fallback.version}`,fallback);this.active=fallback;
  }

  register(controller:SolController){
    if(!valid(controller)||!controller.id.trim()||!controller.version.trim())throw new Error('invalid controller module');
    const key=`${controller.id}@${controller.version}`;this.controllers.set(key,controller);return key;
  }

  stage(id:string,version:string){
    const next=this.controllers.get(`${id}@${version}`);if(!next)throw new Error(`controller ${id}@${version} is not registered`);this.pending=next;
  }

  activateAtTick(tick:number){
    if(!this.pending)return false;
    this.active=this.pending;this.pending=null;this.lastSwitchTick=tick;this.lastError=null;return true;
  }

  async decide(state:BotWorldState,candidates:AgentCandidate[],context:ControllerContext){
    try{return await this.active.decide(state,candidates,context);}
    catch(err){
      this.lastError=String(err).slice(0,240);
      const fallback=[...this.controllers.values()].find(x=>x.id===this.fallbackId);
      if(!fallback)throw err;
      this.active=fallback;
      return fallback.decide(state,candidates,context);
    }
  }

  get activeController(){return this.active;}
  get status():ControllerStatus{return{activeId:this.active.id,activeVersion:this.active.version,fallbackId:this.fallbackId,pendingId:this.pending?.id||null,pendingVersion:this.pending?.version||null,stateGeneration:0,lastSwitchTick:this.lastSwitchTick,lastError:this.lastError};}
}

export class PersistentBodyState {
  readonly envelope:PersistentSolEnvelope;
  constructor(name:string,controllerVersion:string){this.envelope={schemaVersion:1,identity:{name,bornAt:new Date().toISOString()},activeTask:'Initialize persistent agent',stateGeneration:0,lastCommittedTick:-1,controllerVersion};}
  commitTick(tick:number,task:string,controllerVersion:string){this.envelope.lastCommittedTick=tick;this.envelope.activeTask=task;this.envelope.controllerVersion=controllerVersion;this.envelope.stateGeneration++;}
}

export const createFallbackController=(id='deterministic-fallback',version='1.0.0'):SolController=>({
  id,version,
  async decide(_state,candidates,context){
    const rank=(c:AgentCandidate)=>{
      if(['bank','shop','pickup','dialog','modal'].includes(c.category))return 100;
      if(c.category==='economy')return 90;
      if(c.category==='navigation-skill'&&/bank/i.test(c.label))return 85;
      if(c.category==='survival')return 80;
      if(c.category==='explore')return 20;
      if(c.category==='wait')return 0;
      return 10;
    };
    const candidate=[...candidates].sort((a,b)=>rank(b)-rank(a))[0];
    if(!candidate)throw new Error('fallback has no candidate');
    return{source:'student',goal:context.currentTask||'Maintain safe progression',reason:`Deterministic fallback selected ${candidate.label} while the primary controller was unavailable.`,expectedOutcome:'Observe measurable action outcome.',actionId:candidate.id,speech:'',confidence:.99,contextKey:'fallback',fingerprint:candidate.fingerprint};
  }
});
