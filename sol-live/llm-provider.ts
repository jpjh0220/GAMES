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
  const t0=Date.now();
  if(req.provider==='gemini'){
    if(!req.geminiApiKey)throw new Error('Gemini provider selected but GEMINI_API_KEY is unavailable');
    const system=req.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n');
    const user=req.messages.filter(m=>m.role!=='system').map(m=>m.content).join('\n\n');
    const body={contents:[{role:'user',parts:[{text:`${system}\n\n${user}`}]}],generationConfig:{temperature:req.temperature,responseMimeType:'application/json',responseSchema:geminiSchema(req.schema),maxOutputTokens:Math.max(128,req.outputTokens),thinkingConfig:{thinkingBudget:0}}};
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${encodeURIComponent(req.geminiApiKey)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(req.timeoutMs)});
    const text=await r.text();if(!r.ok)throw new Error(`gemini ${r.status}: ${text.slice(0,500)}`);const raw=JSON.parse(text);const content=raw?.candidates?.[0]?.content?.parts?.map((p:any)=>p.text||'').join('')||'';if(!content)throw new Error(`gemini returned no content (${raw?.candidates?.[0]?.finishReason||'unknown'})`);return{content,raw};
  }
  // Guard against silent truncation. candidateLimit is 96 while motor num_ctx
  // is 2048; at ~4 chars/token a 96-candidate payload plus learnedActionValues
  // can exceed the window, and Ollama drops the overflow WITHOUT error, so the
  // model may pick from a clipped action list. Raise num_ctx to fit the prompt
  // (capped) instead of letting it be cut. Reported so the cost is visible.
  const approxPromptTokens=Math.ceil(req.messages.reduce((n,m)=>n+m.content.length,0)/4)+64;
  const fittedCtx=Math.min(8192,Math.max(req.contextTokens,approxPromptTokens+req.outputTokens));
  if(fittedCtx>req.contextTokens)console.warn('AGENT_LLM_CTX_RAISED',JSON.stringify({model:req.model,from:req.contextTokens,to:fittedCtx,approxPromptTokens}));
  const r=await fetch(`${req.ollamaUrl}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:req.model,stream:false,think:false,format:req.schema,keep_alive:'6h',options:{temperature:req.temperature,num_ctx:fittedCtx,num_predict:req.outputTokens},messages:req.messages}),signal:AbortSignal.timeout(req.timeoutMs)});
  if(!r.ok)throw new Error(`ollama ${r.status}`);const raw=await r.json();
  // Instrumented at the provider choke point so it covers motor AND strategist
  // and survives refactors of either call site. An earlier version of this
  // lived in agent-brain and was lost in the Gemini adapter change, which left
  // the single biggest known constraint (decision latency, measured at ~19.2s
  // median) unmeasured.
  //
  // prompt_eval_count is Ollama's own count of prompt tokens actually
  // consumed. If it reaches num_ctx the prompt was TRUNCATED silently - no
  // error is raised - and the model may have chosen from a clipped action
  // list. That is why truncated is reported rather than inferred.
  const promptTokens=Number(raw?.prompt_eval_count)||0;
  const truncated=promptTokens>0&&promptTokens>=fittedCtx;
  console.log('AGENT_LLM_TIMING',JSON.stringify({
    model:req.model,
    ms:Date.now()-t0,
    payloadChars:req.messages.reduce((n,m)=>n+m.content.length,0),
    promptTokens,
    numCtx:fittedCtx,
    truncated,
    outputTokens:Number(raw?.eval_count)||0,
    promptEvalMs:Math.round((Number(raw?.prompt_eval_duration)||0)/1e6),
    evalMs:Math.round((Number(raw?.eval_duration)||0)/1e6)
  }));
  if(truncated)console.warn('AGENT_LLM_TRUNCATED',JSON.stringify({model:req.model,promptTokens,numCtx:fittedCtx}));
  return{content:raw?.message?.content||'',raw};
}
