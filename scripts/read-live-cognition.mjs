import fs from 'node:fs';
const locatorUrl = `https://raw.githubusercontent.com/jpjh0220/GAMES/main/sol-watch/live.json?t=${Date.now()}`;
const locator = await fetch(locatorUrl, {cache:'no-store'}).then(r=>r.json());
const base = locator.url.replace(/\/$/, '');
const health = await fetch(`${base}/health`).then(r=>r.json()).catch(e=>({error:String(e)}));
const log = await fetch(`${base}/log?limit=180`).then(r=>r.json()).catch(e=>({error:String(e)}));
const events = Array.isArray(log) ? log : (log.events || log.entries || log.items || []);
const pick = events.map(e => ({
  at:e.at || e.timestamp || e.time || e.createdAt,
  kind:e.kind || e.type || e.event,
  objective:e.objective || e.goal || e.focus,
  action:e.action || e.actionId || e.candidateLabel,
  reason:e.reason || e.interpretation,
  outcome:e.outcome || e.result || e.summary,
  verified:e.verifiedChange ?? e.verified ?? e.noProgress === false,
  tick:e.tick || e.world?.tick,
  position:e.position || e.world?.position,
  phase:e.phase
}));
console.log(JSON.stringify({locator,health,count:pick.length,recent:pick.slice(-80)}, null, 2));
fs.writeFileSync('/home/ubuntu/GAMES/live-cognition-latest.json', JSON.stringify({locator,health,count:pick.length,recent:pick.slice(-180)}, null, 2));
