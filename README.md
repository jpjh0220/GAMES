# Sol: Autonomous `rs-sdk` Agent Overlay

Sol is a **TypeScript overlay for [Max Bittker’s `rs-sdk`](https://github.com/MaxBittker/rs-sdk)**. It runs an autonomous player in the SDK’s shared RuneScape-style world, using local Ollama models for normal decisions, explicit outcome measurement for learning, and a read-only live spectator interface.

> This repository is **not** a standalone Vite game. The authoritative game client, game state model, and executable action primitives live in `rs-sdk`; this repository supplies the Sol agent, its policies, viewer, and operational workflow.

## Architecture

```text
GAMES / Sol overlay
├── sol-live/                 Agent, policy modules, and spectator viewer
├── scripts/                  Deterministic validation and SDK staging
└── .github/workflows/        CI and the bounded live-runner workflow
                │
                ▼
Pinned rs-sdk revision
├── startSession()            Connects Sol to the game session
├── StateCollector            Publishes world state and legal interaction data
└── ActionExecutor            Dispatches validated game primitives
```

Sol constructs candidates from the live SDK state and executes only supported `BotAction` primitives such as movement, NPC/location interactions, inventory operations, banking, shop actions, dialog choices, combat-style changes, and public speech. Its `worldSkill` procedures are higher-level, verified sequences composed of SDK `walkTo` and `interactLoc` primitives.

| Component | Responsibility |
|---|---|
| `sol-live/sol-live.ts` | Session lifecycle, state collection, candidate generation, execution validation, emergency reflexes, and spectator server. |
| `sol-live/agent-brain.ts` | Model prompts, persistent learning state, rewards, anti-loop logic, prerequisite tracking, and strategic context. |
| `sol-live/*.ts` | Focused support modules for goals, economy, skills, quests, trade inference, prerequisites, and decomposition. |
| `scripts/stage-and-build.mjs` | Pins and stages every Sol module into the upstream SDK before compiling. |
| `scripts/verify-repository.mjs` | Enforces the overlay boundary and guards against incomplete staging or obsolete workflows. |

## Local validation

The root package has no runtime JavaScript dependencies. Node is used for repository checks; Bun is required only to compile the staged agent against `rs-sdk`.

```bash
npm ci --ignore-scripts
npm test
npm run build:agent
```

`npm run build:agent` clones the SDK and checks out the pinned revision declared in `scripts/stage-and-build.mjs`. For offline or iterative SDK development, point the script at an existing checkout:

```bash
RS_SDK_DIR=/path/to/rs-sdk npm run build:agent
```

The successful build is written to `dist/sol-live-agent.js`. Do not commit the `dist/` directory or runtime memory state.

## Continuous live runner

The retained `Sol Live Continuous Runner` workflow is the only production runner. It stages all Sol TypeScript modules into the pinned SDK checkout, compiles the exact entrypoint, starts a local Ollama motor and strategist, starts Sol, performs a health check, and publishes the current public spectator endpoint to `sol-watch/live.json`.

Before manually dispatching the workflow, configure these repository secrets:

| Secret | Required | Purpose |
|---|---:|---|
| `SOL_USER` | Yes | Game account or agent name passed to `rs-sdk`. |
| `SOL_PASS` | Yes | Corresponding game credential. Never place this value in source or workflow YAML. |
| `SOL_VIEWER_TOKEN` | Recommended | Enables full-detail spectator access through a URL token. |

The runner uses a **bounded handoff chain**. A healthy session may start at most three follow-on sessions; any failed run stops rather than looping indefinitely. Start a new chain manually after diagnosis.

## Spectator privacy model

The live server intentionally exposes two views:

| Access mode | URL | Data exposed |
|---|---|---|
| Public summary | `https://<live-tunnel>/` | Health, current objective, action count, and controller status. |
| Full spectator view | `https://<live-tunnel>/?token=<SOL_VIEWER_TOKEN>` | Detailed world state, exact movement, inventory, nearby entities, chat, decision history, and learning telemetry. |

Use the tokenized URL only with trusted viewers. The token is not written to `sol-watch/live.json`; retain it in the configured repository secret.

## Development principles

Sol is deliberately designed around execution evidence rather than language-model assertions. An action is not treated as progress merely because it was dispatched. The agent compares before-and-after SDK state—such as movement, XP, inventory, damage, kills, dialog, rejection feedback, and death—to derive an outcome and update its policy.

Operational changes should preserve this separation: the model proposes a legal candidate; the SDK performs the primitive action; observed world state determines success. Avoid reintroducing autonomous workflows that edit source code or push commits from within a runner. All code changes must pass the canonical CI workflow first.

## License

Released under the [MIT License](LICENSE).
