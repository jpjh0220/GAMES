# Human System: Embodied Open-World Agent

A runnable research scaffold for placing a persistent, body-constrained agent with an optional local LLM brain inside a world that advances over time.

This is an **agent architecture**, not proof of consciousness and not a medically faithful human simulation. Its purpose is to make behavior inspectable: observations, internal drives, decisions, physical validity, consequences, memory, and adaptation are separate layers.

## What is implemented

- A persistent 2D open world with food, water, another agent, tools, hazards, resource regeneration, and independent world time.
- Multiple embodied agents with position, health, energy, hydration, social need, inventory, beliefs, professions, credits, relationships, and active goals.
- An Ollama-compatible local LLM adapter using strict JSON decisions and an allowed-action boundary.
- A deterministic fallback brain, so the simulation works without an installed model.
- Physical action validation: the LLM proposes one action; the runtime decides whether it is possible.
- Persistent episodic and social memory.
- Work, resource ownership, trade, gifts, trust, debt, homes, and shelters.
- JSON snapshots and a Godot 4 bridge.

## Quick start

```bash
python -m pip install -e .
human-sim society --steps 100 --no-llm
```

With Ollama:

```bash
ollama pull qwen2.5:7b
ollama serve
human-sim society --steps 100 --model qwen2.5:7b
```

## Runtime loop

```text
world advances
    ↓
agent bodies and needs update
    ↓
observations + private memories + relationships
    ↓
local LLM or fallback policy proposes an allowed action
    ↓
runtime validates and executes it
    ↓
world, economy, body, and social state change
    ↓
episodes and snapshots persist
    ↺
```

## Current limits

- The world is currently a grid simulation, not a finished rendered 3D game.
- The LLM selects semantic actions rather than controlling muscles directly.
- Learning changes memories, relationships, strategies, and state—not model weights.
- Functional self-preservation does not establish subjective consciousness.

The full source package was generated as `human_project.zip` and is being migrated into this branch.