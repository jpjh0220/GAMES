#!/usr/bin/env node

const [command='abandon_objective', ...rest] = process.argv.slice(2);
const allowed = new Set(['pause','resume','abandon_objective','clear_directive','force_bank','force_fishing','set_config']);
if (!allowed.has(command)) throw new Error(`Unknown command: ${command}`);
const token = process.env.GH_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) throw new Error('GH_TOKEN and GITHUB_REPOSITORY are required');
const api = `https://api.github.com/repos/${repo}`;
const headers = {Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'};
const get = async (path) => { const r=await fetch(`${api}${path}`,{headers}); if(r.status===404)return null; if(!r.ok)throw new Error(`GET ${r.status}: ${await r.text()}`); return r.json(); };
const branch = await get('/git/ref/heads/sol-control');
if(!branch){
  const main = await get('/git/ref/heads/main');
  if(!main)throw new Error('main branch not found');
  const created=await fetch(`${api}/git/refs`,{method:'POST',headers,body:JSON.stringify({ref:'refs/heads/sol-control',sha:main.object.sha})});
  if(!created.ok&&created.status!==422)throw new Error(`create branch ${created.status}: ${await created.text()}`);
}
const current=await get('/contents/sol-agent/control.json?ref=sol-control');
const revision=(current?.sha?JSON.parse(Buffer.from(current.content.replace(/\n/g,''),'base64').toString('utf8')).revision:0)+1;
const raw=rest.join(' ').trim();
let directive=raw||null;
let config;
if(command==='set_config'){
  try{config=JSON.parse(raw);directive=null;}catch(err){throw new Error(`set_config requires a JSON object: ${err}`);}
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('set_config requires a JSON object');
}
const document={revision,command,directive,config,expiresAt:new Date(Date.now()+30*60*1000).toISOString(),updatedAt:new Date().toISOString()};
const payload={message:`control: ${command} (revision ${revision})`,content:Buffer.from(JSON.stringify(document,null,2)+'\n').toString('base64'),branch:'sol-control'};
if(current?.sha)payload.sha=current.sha;
const response=await fetch(`${api}/contents/sol-agent/control.json`,{method:'PUT',headers,body:JSON.stringify(payload)});
if(!response.ok)throw new Error(`PUT ${response.status}: ${await response.text()}`);
console.log(JSON.stringify(document));
