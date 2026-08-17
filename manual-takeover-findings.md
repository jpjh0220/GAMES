# Manual takeover diagnostic — initial findings

The current canonical runner is `https://cached-dropped-initiated-ryan.trycloudflare.com`, run 188. Direct `/health` reported `ok:true`, `online:true`, `inGame:true`, tick 1238, actionCount 58, teacherOnline true, and paused false.

The live spectator page at the same origin loaded its cockpit UI but remained visually stuck on `OFFLINE` / `Connecting to Sol` with blank position, HP, action, and world panels. Browser console inspection produced no console output. This indicates a spectator transport or frontend polling/stream mismatch rather than proof that the game runner is offline.

The runner exposes bounded operator controls (`pause`, `resume`, `abandon_objective`, `clear_directive`, `force_bank`, `force_fishing`, and `set_config`) but no arbitrary raw gameplay action route. A safe manual takeover therefore requires either a supported controller route not yet exposed, or a controlled change to the runner/viewer integration—not guessing at undocumented commands.
