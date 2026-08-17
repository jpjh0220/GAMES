
## Viewer verification after run-190 deployment

After reopening the run-190 root viewer from the canonical origin, the cockpit still displayed `OFFLINE`, `Connecting to Sol`, blank telemetry, and no rendered world, even though the absolute `/state` endpoint returned a live 2.08 MB snapshot with `online:true`, `inGame:true`, tick 811 and later tick 1022. The backend transport fix materially reduced payload size, but the frontend polling/render path still does not present the live state in this browser session. The direct state endpoint remains usable for firsthand diagnosis.

## Successful live-cockpit rendering

After allowing the compact 2 MB snapshot enough time to parse, the run-190 viewer rendered successfully. The cockpit showed `LIVE SUMMARY`, Sol at roughly tick 1115, action count 25, HP 99/99, combat level 117, run energy 100, five nearby agents, one visible ground item, and one free inventory slot. The isometric world view visibly rendered Sol, numerous dead trees and bushes, tree stumps, nettles, ducks, a cow, a giant spider, nearby players, a circular minimap, movement context, and the current decision panel.

The viewer displayed a degraded controller state with two timeouts but teacher online, the phase `CAPACITY / ECONOMY`, and a decision of `AGENT_TEACHER — Explore north about 5 tiles`. This confirms that the backend and frontend are now both usable for firsthand observation. The issue was not permanent offline state; the large snapshot simply required enough time for tunnel transfer and parsing.
