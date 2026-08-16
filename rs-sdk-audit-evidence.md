# rs-sdk audit evidence

Source repository: https://github.com/MaxBittker/rs-sdk
Pinned workflow revision: `2ae032c99813a72d8d749d6d105fc7378255b03` (visible as commit `2ae032c` on the repository main page).

The pinned `sdk/API.md` states that high-level `bot.*` methods attempt to observe method-specific game effects, while low-level `sdk.send*` methods only confirm browser-client dispatch and do not prove the server applied the effect. It also documents `bot.walkTo`, `bot.interactLoc`, `bot.chopTree`, `bot.pickupItem`, `bot.openBank`, `bot.depositItem`, and `bot.closeBank` as the intended high-level operations.

The current Sol runner starts `startSession()` from `server/webclient/src/lite/session.ts`, which returns a `LiteClient`. Before the fix, Sol manually constructed browser `BotStateCollector` and `ActionExecutor` around the LiteClient using `as unknown as Client`, bypassing LiteClient's owned bridge and interface activation.

Pinned `server/webclient/src/lite/LiteClient.ts` exposes `collectBotState(serverTick)` and `executeBotAction(action)`. These methods call a privately owned collector/executor bridge and activate the correct static interface table on every call. The pinned lite README explicitly instructs callers not to construct `BotStateCollector` or `ActionExecutor` manually; callers must use those LiteClient methods.

Pinned `server/webclient/src/lite/actions.ts` requires WALK BEFORE OP for 274: interaction methods route before sending OPLOC/OPNPC/OPOBJ packets. It implements bank deposits against component `2006` and the correct inventory-item wire mapping. Sol now routes state collection and action execution through LiteClient's owned bridge.

Pinned `sdk/actions.ts` `openBank()` waits up to 10 seconds, dismisses blocking UI, walks into range, re-finds the bank booth after walking, prefers `Bank`, `Use-quickly`, then `Use`, waits for `interface.isOpen` or dialog, and advances dialogue options. Sol's custom bank procedure previously waited only three ticks; it now uses a bounded ten-second wait/dialog loop.

Pinned `sdk/test/banking-porcelain.ts` verifies the expected bank sequence: open bank, deposit item with -1 for all, withdraw, close bank, and validate observable state deltas.

The standing-still symptom was also traced to an unbounded body-level `decisionInFlight` lease. Sol now has a 30-second watchdog that releases a hung decision, records recovery telemetry, and resumes the deterministic safety path.
