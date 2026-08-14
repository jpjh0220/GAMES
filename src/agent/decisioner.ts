import { telemetry, EventType } from '@shared/telemetry';
import type { BotWorldState, AgentCandidate } from './types';

/**
 * CRITICAL FIX #13: Async decision queuing prevents motor blocking
 */

export interface DecisionRequest {
  id: string;
  state: BotWorldState;
  candidates: AgentCandidate[];
  createdAt: number;
  priority: 'critical' | 'normal' | 'background';
}

export interface DecisionOutcome {
  requestId: string;
  decision: AgentCandidate;
  confidence: number;
  reasoning: string;
  reasoning: string;
  completedAt: number;
  durationMs: number;
  source: 'motor' | 'shadow' | 'reflex';
}

export class AdaptiveDecisioner {
  private queue: DecisionRequest[] = [];
  private inFlight: Map<string, Promise<DecisionOutcome>> = new Map();
  private baseTimeoutMs: number = 8000; // start conservative
  private recentDecisions: { durationMs: number; success: boolean }[] = [];
  private motorReady: boolean = false;
  private shadowPredictor: ShadowLearner;
  private reflexResponder: ReflexResponder;
  private decisionLatencies: number[] = [];
  private avgDecisionTime: number = 0;

  constructor(
    private ollamaUrl: string,
    private motorModel: string
  ) {
    this.shadowPredictor = new ShadowLearner();
    this.reflexResponder = new ReflexResponder();
  }

  /**
   * Queue a decision request; returns immediately
   * Actual decision resolves asynchronously
   */
  async queueDecision(
    state: BotWorldState,
    candidates: AgentCandidate[],
    priority: 'critical' | 'normal' = 'normal'
  ): Promise<DecisionOutcome> {
    const requestId = `decision-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const request: DecisionRequest = {
      id: requestId,
      state,
      candidates,
      createdAt: Date.now(),
      priority
    };

    // Try shadow predictor first (instant)
    const shadowDecision = this.shadowPredictor.predict(state, candidates);
    if (shadowDecision && shadowDecision.confidence > 0.7) {
      telemetry.record(EventType.AGENT_DECISION, {
        requestId,
        source: 'shadow',
        confidence: shadowDecision.confidence,
        durationMs: 0
      });
      return shadowDecision;
    }

    // Try reflex responder (instant)
    const reflexDecision = this.reflexResponder.decide(state, candidates);
    if (reflexDecision) {
      telemetry.record(EventType.AGENT_DECISION, {
        requestId,
        source: 'reflex',
        durationMs: 0
      });
      return reflexDecision;
    }

    // Queue motor decision (async)
    const decision = this.processMotorDecision(request);
    this.inFlight.set(requestId, decision);

    // Return shadow prediction as placeholder, resolve motor decision in background
    if (shadowDecision) {
      decision.then(() => {
        // Motor decision completed, update telemetry
      });
      return shadowDecision; // Don't block on motor
    }

    return decision;
  }

  private async processMotorDecision(
    request: DecisionRequest
  ): Promise<DecisionOutcome> {
    const startTime = Date.now();

    try {
      // Adaptive timeout: if recent decisions average 2s, timeout at 6s
      const timeoutMs = Math.min(
        12000,
        Math.max(3000, this.avgDecisionTime * 3)
      );

      const motorResponse = await this.askMotorWithAdaptiveTimeout(
        request.state,
        request.candidates,
        timeoutMs
      );

      const durationMs = Date.now() - startTime;
      this.recordDecisionLatency(durationMs, true);

      telemetry.record(EventType.AGENT_DECISION, {
        requestId: request.id,
        source: 'motor',
        durationMs,
        confidence: motorResponse.confidence
      });

      return {
        requestId: request.id,
        decision: motorResponse.candidate,
        confidence: motorResponse.confidence,
        reasoning: motorResponse.reasoning,
        completedAt: Date.now(),
        durationMs,
        source: 'motor'
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.recordDecisionLatency(durationMs, false);

      telemetry.record(EventType.NETWORK_TIMEOUT, {
        requestId: request.id,
        error: String(error),
        durationMs,
        model: this.motorModel
      });

      // Fallback to shadow or reflex
      const fallback =
        this.shadowPredictor.predict(
          request.state,
          request.candidates
        ) || this.reflexResponder.decide(request.state, request.candidates);

      if (fallback) {
        return {
          ...fallback,
          requestId: request.id,
          source: 'shadow' // fallback source
        };
      }

      throw error;
    } finally {
      this.inFlight.delete(request.id);
    }
  }

  private async askMotorWithAdaptiveTimeout(
    state: BotWorldState,
    candidates: AgentCandidate[],
    timeoutMs: number
  ): Promise<{
    candidate: AgentCandidate;
    confidence: number;
    reasoning: string;
  }> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // ... motor request to Ollama ...
      return {
        candidate: candidates[0],
        confidence: 0.8,
        reasoning: 'Motor decision'
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private recordDecisionLatency(durationMs: number, success: boolean): void {
    this.decisionLatencies.push(durationMs);
    if (this.decisionLatencies.length > 100) {
      this.decisionLatencies.shift();
    }
    this.avgDecisionTime =
      this.decisionLatencies.reduce((a, b) => a + b, 0) /
      this.decisionLatencies.length;
  }

  getPendingDecisions(): number {
    return this.inFlight.size;
  }

  getAdaptiveTimeout(): number {
    return Math.min(12000, Math.max(3000, this.avgDecisionTime * 3));
  }

  getMetrics() {
    return {
      avgDecisionTime: this.avgDecisionTime,
      adaptiveTimeout: this.getAdaptiveTimeout(),
      pendingDecisions: this.inFlight.size,
      recentLatencies: this.decisionLatencies.slice(-10)
    };
  }
}

/**
 * Shadow learner: provides high-confidence predictions from policy
 */
class ShadowLearner {
  private policy: Map<string, Map<string, number>> = new Map();

  predict(
    state: BotWorldState,
    candidates: AgentCandidate[]
  ): DecisionOutcome | null {
    const contextKey = this.makeContextKey(state);
    const policyMap = this.policy.get(contextKey);

    if (!policyMap) return null;

    let bestCandidate: AgentCandidate | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const score = policyMap.get(candidate.id) || 0;
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (!bestCandidate || bestScore < 0.6) return null;

    return {
      requestId: 'shadow',
      decision: bestCandidate,
      confidence: Math.min(0.95, bestScore),
      reasoning: `Learned from ${policyMap.size} past decisions`,
      completedAt: Date.now(),
      durationMs: 0,
      source: 'shadow'
    };
  }

  learn(
    state: BotWorldState,
    candidate: AgentCandidate,
    reward: number
  ): void {
    const contextKey = this.makeContextKey(state);
    if (!this.policy.has(contextKey)) {
      this.policy.set(contextKey, new Map());
    }
    const policyMap = this.policy.get(contextKey)!;
    policyMap.set(candidate.id, reward);
  }

  private makeContextKey(state: BotWorldState): string {
    const p = state.player;
    if (!p) return 'unknown';
    return `${Math.floor(p.worldX / 8)}:${Math.floor(p.worldZ / 8)}:${p.level}`;
  }
}

/**
 * Reflex responder: instant decisions for critical situations
 */
class ReflexResponder {
  decide(
    state: BotWorldState,
    candidates: AgentCandidate[]
  ): DecisionOutcome | null {
    const p = state.player;
    if (!p) return null;

    // Critical: low HP -> heal
    if (p.hp < p.maxHp * 0.25) {
      const heal = candidates.find((c) => c.category === 'recovery');
      if (heal) {
        return {
          requestId: 'reflex',
          decision: heal,
          confidence: 0.95,
          reasoning: 'Critical health: heal immediately',
          completedAt: Date.now(),
          durationMs: 0,
          source: 'reflex'
        };
      }
    }

    // In combat: attack
    if (p.combat?.inCombat) {
      const attack = candidates.find((c) => c.category === 'combat');
      if (attack) {
        return {
          requestId: 'reflex',
          decision: attack,
          confidence: 0.9,
          reasoning: 'In combat: prioritize combat action',
          completedAt: Date.now(),
          durationMs: 0,
          source: 'reflex'
        };
      }
    }

    return null;
  }
}
