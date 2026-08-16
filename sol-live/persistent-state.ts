import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

export const PERSISTENT_STATE_SCHEMA = 1;

export type ObligationKind =
  | 'survival'
  | 'stale-recovery'
  | 'loot-resolution'
  | 'capacity-resolution'
  | 'transaction'
  | 'prerequisite'
  | 'objective'
  | 'exploration'
  | 'idle';

export type PersistentState = {
  schemaVersion: number;
  stateGeneration: number;
  committedTick: number;
  identity: { name: string; accountId?: string };
  position: { x: number; z: number; level: number } | null;
  currentObligation: {
    kind: ObligationKind;
    id: string;
    startedTick: number;
    attempt: number;
    deadlineTick?: number;
    reason: string;
  };
  objective: { id: string; label: string; successSignals: string[]; status: 'active' | 'completed' | 'abandoned' };
  inventoryLedger: { signature: string; freeSlots: number; coins: number; updatedTick: number };
  milestones: Array<{ id: string; label: string; tick: number; evidence: string }>;
  failures: Array<{ fingerprint: string; count: number; lastTick: number; lastReason: string }>;
  controller: { activeId: string; activeVersion: string; pendingId?: string; pendingVersion?: string; lastSwitchTick: number };
  lastObservationHash: string;
  updatedAt: string;
};

const initialState = (name: string): PersistentState => ({
  schemaVersion: PERSISTENT_STATE_SCHEMA,
  stateGeneration: 0,
  committedTick: 0,
  identity: { name },
  position: null,
  currentObligation: { kind: 'idle', id: 'boot', startedTick: 0, attempt: 0, reason: 'Initializing persistent body.' },
  objective: { id: 'boot', label: 'Initialize persistent agent', successSignals: ['first verified observation'], status: 'active' },
  inventoryLedger: { signature: '', freeSlots: 28, coins: 0, updatedTick: 0 },
  milestones: [],
  failures: [],
  controller: { activeId: 'deterministic-fallback', activeVersion: '1.0.0', lastSwitchTick: 0 },
  lastObservationHash: '',
  updatedAt: new Date(0).toISOString(),
});

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function normalize(raw: unknown, name: string): PersistentState {
  if (!isRecord(raw)) throw new Error('persistent state must be an object');
  const base = initialState(name);
  if (finite(raw.schemaVersion, -1) !== PERSISTENT_STATE_SCHEMA) throw new Error(`unsupported persistent state schema: ${String(raw.schemaVersion)}`);
  const state = { ...base, ...raw } as PersistentState;
  state.schemaVersion = PERSISTENT_STATE_SCHEMA;
  state.stateGeneration = Math.max(0, Math.floor(finite(state.stateGeneration, 0)));
  state.committedTick = Math.max(0, Math.floor(finite(state.committedTick, 0)));
  state.identity = isRecord(raw.identity) ? { name: String(raw.identity.name || name).slice(0, 80), accountId: raw.identity.accountId ? String(raw.identity.accountId).slice(0, 120) : undefined } : { name };
  state.milestones = Array.isArray(raw.milestones) ? raw.milestones.slice(-200) as PersistentState['milestones'] : [];
  state.failures = Array.isArray(raw.failures) ? raw.failures.slice(-200) as PersistentState['failures'] : [];
  return state;
}

export class PersistentStateStore {
  private state: PersistentState;
  private readonly path: string;
  private writeInFlight: Promise<void> = Promise.resolve();

  private constructor(path: string, state: PersistentState) {
    this.path = path;
    this.state = state;
  }

  static async open(path: string, name: string): Promise<PersistentStateStore> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      return new PersistentStateStore(path, normalize(parsed, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') console.warn('PERSISTENT_STATE_RECOVERY', String(error));
      return new PersistentStateStore(path, initialState(name));
    }
  }

  snapshot(): PersistentState { return structuredClone(this.state); }

  async commit(patch: Partial<PersistentState>, tick: number): Promise<PersistentState> {
    this.state = normalize({ ...this.state, ...patch, schemaVersion: PERSISTENT_STATE_SCHEMA, committedTick: Math.max(this.state.committedTick, tick), stateGeneration: this.state.stateGeneration + 1, updatedAt: new Date().toISOString() }, this.state.identity.name);
    const next = JSON.stringify(this.state, null, 2) + '\n';
    const tmp = `${this.path}.tmp`;
    this.writeInFlight = this.writeInFlight.then(async () => { await mkdir(this.path.slice(0, this.path.lastIndexOf('/')) || '.', { recursive: true }); await writeFile(tmp, next, 'utf8'); await rename(tmp, this.path); });
    await this.writeInFlight;
    return this.snapshot();
  }

  async recordMilestone(milestone: PersistentState['milestones'][number], tick: number) {
    return this.commit({ milestones: [...this.state.milestones, milestone].slice(-200) }, tick);
  }

  async recordFailure(failure: PersistentState['failures'][number], tick: number) {
    const prior = this.state.failures.filter(x => x.fingerprint !== failure.fingerprint);
    return this.commit({ failures: [...prior, failure].slice(-200) }, tick);
  }
}
