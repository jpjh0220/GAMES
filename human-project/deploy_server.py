import asyncio, json, os, random
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

STATE=Path(os.getenv('HUMAN_WORLD_STATE','shared_world.json'))
CLIENT=Path(__file__).with_name('shared.html')
clients=set(); rng=random.Random(12)

def fresh():
 return {'tick':0,'world':{'width':24,'height':16,'objects':[{'id':'well','kind':'water','x':3,'y':3},{'id':'orchard','kind':'food','x':18,'y':3},{'id':'market','kind':'market','x':11,'y':8},{'id':'farm','kind':'job','x':4,'y':13},{'id':'workshop','kind':'job','x':19,'y':12}]},'agents':[{'id':'root','name':'Root','x':1,'y':1,'role':'explorer','energy':.8,'hydration':.8,'credits':4,'last_action':'initialized'},{'id':'mara','name':'Mara','x':9,'y':7,'role':'farmer','energy':.75,'hydration':.85,'credits':6,'last_action':'initialized'},{'id':'sol','name':'Sol','x':17,'y':11,'role':'builder','energy':.7,'hydration':.9,'credits':8,'last_action':'initialized'}]}

def load():
 try:return json.loads(STATE.read_text())
 except:return fresh()
state=load()

def persist():
 tmp=STATE.with_suffix('.tmp');tmp.write_text(json.dumps(state,indent=2));tmp.replace(STATE)

def move(a,target):
 if a['x']!=target['x']:a['x']+=1 if target['x']>a['x'] else -1
 elif a['y']!=target['y']:a['y']+=1 if target['y']>a['y'] else -1

def step():
 state['tick']+=1;turns=[]
 for a in state['agents']:
  a['energy']=max(0,a['energy']-.008);a['hydration']=max(0,a['hydration']-.011)
  objects=state['world']['objects']
  if a['hydration']<.4:target=next(o for o in objects if o['kind']=='water');move(a,target);result='traveled toward water'
  elif a['energy']<.35:target=next(o for o in objects if o['kind']=='food');move(a,target);result='traveled toward food'
  elif a['credits']<3:target=next(o for o in objects if o['kind']=='job');move(a,target);result='traveled toward work'
  else:
   a['x']=max(0,min(23,a['x']+rng.choice([-1,0,1])));a['y']=max(0,min(15,a['y']+rng.choice([-1,0,1])));result='explored nearby'
  a['last_action']=result;turns.append({'agent_id':a['id'],'result':result})
 state['turns']=turns;persist();return state

async def broadcast():
 dead=[]
 for ws in tuple(clients):
  try:await ws.send_json(state)
  except:dead.append(ws)
 for ws in dead:clients.discard(ws)

async def loop():
 while True:
  await asyncio.sleep(float(os.getenv('HUMAN_TICK_SECONDS','1')));step();await broadcast()

@asynccontextmanager
async def lifespan(app):
 task=asyncio.create_task(loop());yield;task.cancel();persist()
app=FastAPI(lifespan=lifespan)
@app.get('/')
def index():return FileResponse(CLIENT)
@app.get('/api/state')
def get_state():return state
@app.get('/api/health')
def health():return {'ok':True,'tick':state['tick'],'clients':len(clients)}
@app.post('/api/step')
async def manual_step():step();await broadcast();return state
@app.websocket('/ws')
async def ws(socket:WebSocket):
 await socket.accept();clients.add(socket);await socket.send_json(state)
 try:
  while True:await socket.receive_text()
 except WebSocketDisconnect:pass
 finally:clients.discard(socket)
