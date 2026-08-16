export type LlmMessage={role:'system'|'user'|'assistant';content:string};
export type LlmRequest={provider:'ollama'|'gemini';model:string;messages:LlmMessage[];schema:any;temperature:number;contextTokens:number;outputTokens:number;ollamaUrl:string;geminiApiKey?:string;timeoutMs:number};

const geminiSchema=(schema:any):any=>{
  if(!schema||typeof schema!=='object')return schema;
  const out:any={};
  for(const [key,value] of Object.entries(schema)){
    if(key==='type'&&typeof value==='string')out[key]=value.toUpperCase();
    else if(key==='properties'&&value&&typeof value==='object')out[key]=Object.fromEntries(Object.entries(value as any).map(([k,v])=>[k,geminiSchema(v)]));
    else if(key==='items')out[key]=geminiSchema(value);
    else if(key!=='additionalProperties')out[key]=value;
  }
  return out;
};

export async function chatJson(req:LlmRequest):Promise<{content:string;raw:any}> {
  if(req.provider==='gemini'){
    if(!req.geminiApiKey)throw new Error('Gemini provider selected but GEMINI_API_KEY is unavailable');
    const system=req.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n');
    const user=req.messages.filter(m=>m.role!=='system').map(m=>m.content).join('\n\n');
    const body={contents:[{role:'user',parts:[{text:`${system}\n\n${user}`}]}],generationConfig:{temperature:req.temperature,responseMimeType:'application/json',responseSchema:geminiSchema(req.schema),maxOutputTokens:Math.max(128,req.outputTokens),thinkingConfig:{thinkingBudget:0}}};
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${encodeURIComponent(req.geminiApiKey)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(req.timeoutMs)});
    const text=await r.text();if(!r.ok)throw new Error(`gemini ${r.status}: ${text.slice(0,500)}`);const raw=JSON.parse(text);const content=raw?.candidates?.[0]?.content?.parts?.map((p:any)=>p.text||'').join('')||'';if(!content)throw new Error(`gemini returned no content (${raw?.candidates?.[0]?.finishReason||'unknown'})`);return{content,raw};
  }
  const r=await fetch(`${req.ollamaUrl}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:req.model,stream:false,think:false,format:req.schema,keep_alive:'6h',options:{temperature:req.temperature,num_ctx:req.contextTokens,num_predict:req.outputTokens},messages:req.messages}),signal:AbortSignal.timeout(req.timeoutMs)});
  if(!r.ok)throw new Error(`ollama ${r.status}`);const raw=await r.json();return{content:raw?.message?.content||'',raw};
}
