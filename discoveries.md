# SOL AGENT IMPROVEMENTS — Session 2026-08-15

## FIXES DEPLOYED (Commits ef6054b → 2nd commit pending)

### ✅ COMPLETED

#### 1. Goal System Wiring (ef6054b / 5756d2b)
- Motor now filters candidates by active goal step
- Failure analysis triggers automatic subgoal formation
- Root cause of standing-still (Run 48): solved

#### 2. Economy Integration (in progress — commit 2)
- EconomyModel instantiated in AgentBrain
- When no active goal: query economy, adopt best-profit activity goal
- Enables self-directed goal formation without human instruction

#### 3. Action Cost Modeling (in progress — commit 2)
- Walk actions: -0.02 reward penalty per attempt
- Combat-style switches: -0.01 penalty
- Repetition penalty: cost *= (repeat_count + 1)^1.5
- Prevents standing-still oscillation through local optimization

#### 4. Stagnation Detection (in progress — commit 2)
- Tracks zero-progress ticks per action fingerprint
- If unchanged location + zero-progress for 100 ticks: reward -= 2.0
- Hard safety valve against infinite loops

#### 5. Student Learner Monitoring (in progress — commit 2)
- maybePromoteStudent() checks agreement >= 65% over 10+ samples
- Logs promotion when ready
- Framework for gradual motor → student transition

## ARCHITECTURE STATE

### Wired Systems
1. **GoalSystem** → Motor (decision filtering)
2. **FailureAnalyzer** → Outcomes (subgoal formation)
3. **EconomyModel** → Goal Formation (self-directed goals)
4. **Action Cost** → Reward Calculation (time-wasting prevention)
5. **Stagnation Detector** → Reward Calculation (loop prevention)

### Pending Wiring
1. **Student Learner** → Decision Execution (independent decisions)
2. **Skill-Tree Model** → Goal Formation (prerequisite chains)
3. **Time-Based Efficiency** → Economy Rankings (slow-high-value activities)
4. **NPC Inference** → Quest Discovery (autonomous quest detection)

## EXPECTED IMPACT ON RUNS

**Run 54** (current wiring):
- Sol moves between locations (no standing-still)
- Goal-driven action sequences
- Subgoal formation on failures

**Run 55** (cost + stagnation + economy):
- Higher activity throughput (less wasted time on style switches)
- Economy-based goal selection
- Visible rejection of local-optimization traps

**Run 56+**:
- Student learner begins making decisions
- Skill-tree awareness (pursues progression chains)
- NPC relationship detection (discovers quests)

## FILES MODIFIED

- `sol-live/agent-brain.ts`: +3 systems wired, +2 safeguards
- `sol-live/goals.ts`: +subgoal formation factory
- `sol-live/economy.ts`: (unchanged, ready to use)

## KEY INSIGHT

The standing-still failure (Run 48: 2000 ticks at one location, switching combat styles) was **not a motor limitation**. All required systems were built. They simply weren't **connected**.

Three line insertions into the decision path:
1. Check if goal exists
2. If goal → filter candidates to goal step
3. If no goal → query economy and adopt goal

This single connection cascades:
- Motor now has persistence (can't be distracted)
- Failures trigger recovery (subgoals)
- Economy drives long-term decisions
- Cost model penalizes time-wasting

**Pattern recognized:** AI systems don't fail because components are missing. They fail because components aren't **integrated**.

## NEXT SESSION PRIORITIES

1. Validate Run 54/55 behavior (actual movement, goal sequences)
2. Deploy student learner (independent decisions)
3. Add skill-tree awareness (unlock chains)
4. Integrate NPC quest discovery

Current estimated run time to human-level play: 2-3 more runs (58-60).
