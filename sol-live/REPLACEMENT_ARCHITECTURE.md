# Sol Replacement Architecture

## Objective

Sol will be rebuilt as a persistent game body with a replaceable decision controller. The character identity, world connection, durable state, execution state, and safety invariants will not belong to any individual language-model process.

## Runtime boundaries

| Boundary | Owns | Must survive controller replacement | Restart behavior |
|---|---|---:|---|
| Body supervisor | SDK connection, tick clock, perception, action dispatch, leases, health | Yes | Reconnect and restore state |
| Durable state store | Identity, inventory ledger, position, objectives, memories, milestones, failures, transaction state | Yes | Load last committed snapshot |
| Safety executor | Survival, loot, capacity, dialogs, banking, shops, stale-action rejection | Yes | Safe fallback immediately |
| Controller registry | Validated controller manifests, staging, health, activation | No | Rehydrate active controller |
| Strategic controller | Long-horizon goals and candidate preference | No | Optional; fallback continues |
| Motor controller | Selects among legal actions | No | Optional; fallback continues |
| Spectator/control plane | Read-only telemetry and authenticated commands | No | Reconnect to body |

## Stable tick contract

Every game tick follows the same sequence:

1. Read perception and normalize it into an immutable observation.
2. Commit the observation and update the durable state ledger.
3. Run deterministic safety and obligation gates.
4. If an obligation is active, expose only legal actions for that obligation.
5. Otherwise ask the active controller for a choice from the legal action set.
6. Re-perceive before execution and reject stale choices whose preconditions changed.
7. Execute at most one leased action.
8. Verify the outcome against explicit success predicates.
9. Commit the outcome, milestone, failure, and next obligation atomically.
10. Publish telemetry with exact action, phase, preconditions, postconditions, and state generation.

The controller can suggest; it cannot bypass the safety executor or execute arbitrary SDK operations.

## Deterministic obligation state machine

The body owns these priority-ordered obligations:

| Priority | Obligation | Exit condition |
|---:|---|---|
| 1 | Survival | HP safe, combat danger resolved, or respawn recovery complete |
| 2 | Stale-action recovery | Current action lease closed and perception refreshed |
| 3 | Loot resolution | Valuable drops collected, skipped with recorded reason, or unreachable |
| 4 | Capacity resolution | Free slots above threshold through deposit, sell, use, or discard policy |
| 5 | Interface transaction | Bank/shop/dialog action produces verified state delta or bounded abort |
| 6 | Active prerequisite | Required route, item, coin, skill, or interface milestone verified |
| 7 | Strategic objective | Objective success predicate verified or objective abandoned |
| 8 | Exploration/learning | New durable fact, XP, item, coin, route, or relationship evidence |

An obligation cannot be considered complete because a button was clicked. Completion requires a postcondition observed in the world state.

## Transaction protocol

Every bank/shop/dialog operation is a transaction with a snapshot, allowed operation set, attempt counter, deadline, and success predicate. Under capacity pressure, purchases and withdrawals are illegal. A transaction that produces no measurable change twice is aborted, the interface is closed, the failure is persisted, and the planner must choose a different route or merchant.

## Durable state

State is committed atomically by generation and tick. The envelope contains `schemaVersion`, `stateGeneration`, `committedTick`, identity, current obligation, objective, inventory ledger, position, milestone ledger, failure ledger, controller metadata, and the last verified observation hash. Writes use a temporary file plus rename; malformed or future versions are rejected and the previous valid snapshot is retained.

## Controller hot swap

A controller manifest must declare an ID, semantic version, capabilities, input/output schema version, health timeout, and deterministic test result. A staged controller is loaded and exercised against recorded observations before activation. Activation occurs only at a tick boundary after the new controller passes validation. In-flight action leases remain owned by the body and are never transferred mid-action. On timeout, exception, schema violation, or repeated low-quality decisions, the registry atomically returns to the deterministic fallback.

## Migration boundary

The current `sol-live.ts` brain loop will first be wrapped behind the stable controller interface. The new body supervisor and safety executor will become the only code allowed to call `ActionExecutor`. Existing prompts, economy policy, memory, and learned values will become controller inputs rather than direct execution authority. The old candidate gates will remain only as compatibility adapters until the replacement state machine is proven live.

## Success criteria for cutover

The replacement is ready for live cutover only when it passes all of the following:

- A full inventory cannot produce combat, fishing, buying, or withdrawing actions.
- A bank/shop/dialog operation cannot repeat indefinitely without a verified state delta.
- Every executed primitive has a precondition, lease, result, and postcondition record.
- Killing an NPC creates a loot-resolution obligation before another combat objective.
- Controller replacement preserves body identity, inventory, position, objective, and state generation.
- A controller crash leaves the body connected and the fallback active.
- The spectator shows the current obligation, transaction attempt, exact primitive, verification result, active controller, pending controller, and durable state generation.
- A 10-minute live observation shows no unbounded repeated action sequence and at least one verified milestone.
