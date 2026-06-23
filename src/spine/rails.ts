// Budget rails and action gates: the deterministic guardrails that bound the
// escalation ladder. They make no judgment — they cap blast radius and refuse
// forbidden actions, in code (determinism caps blast radius without making the
// decisions; Rule 5). Caps guarantee a failing leaf STOPS; gates refuse actions
// the loop must never take autonomously.

// Cumulative budget a leaf has consumed across its escalation attempts.
// Monotonic — each attempt only adds.
export interface RailUsage {
  // Dispatch attempts spent so far (one per rung action taken).
  attempts: number;
  // Provider tokens billed so far across all attempts.
  tokens: number;
  // Wall-clock elapsed since the first dispatch, in milliseconds.
  elapsedMs: number;
}

// The three budget caps. A leaf's ladder halts the moment any one is reached
// (the budget rails guarantee it stops).
export interface RailCaps {
  maxAttempts: number;
  maxTokens: number;
  maxWallClockMs: number;
}

export type CapKind = 'attempt' | 'token' | 'wall-clock';

// Which cap (if any) the usage has reached, checked `>=` so a cap of N permits
// exactly N units of budget and stops the request that would exceed it. Total
// and deterministic — code answers, never the model (Rule 5). Attempt is checked
// first so an attempt-bounded ladder reports `attempt` rather than a coincident
// token/clock cap.
export function capReached(caps: RailCaps, usage: RailUsage): CapKind | null {
  if (usage.attempts >= caps.maxAttempts) {
    return 'attempt';
  }
  if (usage.tokens >= caps.maxTokens) {
    return 'token';
  }
  if (usage.elapsedMs >= caps.maxWallClockMs) {
    return 'wall-clock';
  }
  return null;
}

// A consequential action the loop is about to take, gated before execution.
// Current kinds: a git write that could land on a protected branch, and a macOS
// host system action (the tier-A runner's logged-in session). The union is
// extensible as later steps add gated action kinds.
export type GatedAction =
  | { kind: 'git-write'; branch: string }
  | { kind: 'macos-system'; action: string };

// Gate policy. Conservative defaults belong at the call site via
// `defaultGateConfig`; this is the data the check reads.
export interface GateConfig {
  // Branch names the loop must never write to autonomously (e.g. `main`).
  protectedBranches: string[];
  // macOS host system actions are refused unless explicitly permitted; tier-A
  // currently runs non-destructive on the logged-in session.
  allowMacosSystemActions: boolean;
}

// Conservative default: protect the usual integration branches and refuse host
// system actions. Callers widen this deliberately, never by omission.
export function defaultGateConfig(): GateConfig {
  return {
    protectedBranches: ['main', 'master'],
    allowMacosSystemActions: false,
  };
}

// Thrown when a gate refuses an action. Loud by default (Rule 11): a refused
// action halts the caller rather than silently proceeding.
export class GateRefusal extends Error {
  constructor(
    readonly action: GatedAction,
    reason: string,
  ) {
    super(reason);
    this.name = 'GateRefusal';
  }
}

// Refuse a forbidden action by throwing `GateRefusal`; return for permitted
// actions. The orchestrator calls this immediately before any gated action.
export function checkGate(config: GateConfig, action: GatedAction): void {
  switch (action.kind) {
    case 'git-write':
      if (config.protectedBranches.includes(action.branch)) {
        throw new GateRefusal(action, `refused git write to protected branch \`${action.branch}\``);
      }
      return;
    case 'macos-system':
      if (!config.allowMacosSystemActions) {
        throw new GateRefusal(action, `refused macOS system action \`${action.action}\``);
      }
      return;
  }
}
