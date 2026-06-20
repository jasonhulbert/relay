// The orchestrator brain (design §3.3, §3.4): the model JUDGMENT the code-owned
// state machine calls for when it decomposes a node one layer. Two judgments come
// out of one call:
//   - decompose (§3.3): the child outcomes, and — because "decomposing a layer is
//     not only choosing children" — each child's resource FOOTPRINT and the SEAMS
//     between them (§3.8);
//   - leaf-vs-branch (§3.4): each child classified `leaf` (hand to one executor) or
//     `branch` (still too big → a sub-orchestrator decomposes one more layer). This
//     is the recursion's base case; it is judgment, allowed to be wrong, and the
//     loop repairs a mis-size by promotion (§3.5).
//
// The brain is an AGENT (a `claude -p` / `codex exec` shell-out) that connects to
// the spine's granted MCP servers as a client and uses tools freely to inform the
// judgment — but it WRITES NOTHING durable. It returns structured data; the
// orchestrator parses it (Rule 5: the model judges, code reads the answer) and is
// the sole writer of `.relay/` (C2). Its `BrainContext` carries a worktree to
// inspect and the granted servers — never the `.relay/` dir — so it is structurally
// incapable of writing the durable state, exactly like the executor and critic.
import { spawn } from 'node:child_process';
import { DEFAULT_CLAUDE_MODEL, parseClaudeStream } from './adapters/claude';
import { DEFAULT_CODEX_MODEL, parseCodexStream } from './adapters/codex';
import { claudeMcpArgs, codexMcpArgs } from '../mcp/index';
import type { ExecutorUsage } from './executor';
import type {
  Footprint,
  McpServerConfig,
  NodeKind,
  OutcomeSpec,
  SeamKind,
  Verification,
} from '../relay-state/index';

export type BrainProvider = 'claude' | 'codex';

// One child of a decomposed layer: its outcome spec, its leaf-vs-branch class, and
// its resource footprint. The footprint and class are short-horizon predictions
// pinned at decomposition (§3.3/§3.4), allowed to be wrong and corrected by the
// loop.
export interface ChildPlan {
  spec: OutcomeSpec;
  kind: NodeKind;
  footprint: Footprint;
}

// A seam the brain proposes between two children, referencing them by INDEX into
// `children` (the brain does not know the final node-ids the orchestrator will
// assign). The orchestrator maps the indices to node-ids when it persists the
// durable `SeamContract` in the layer manifest.
export interface SeamPlan {
  id: string;
  kind: SeamKind;
  // Indices into `Decomposition.children`.
  producer: number;
  consumer: number;
  payload: Record<string, unknown>;
  intent: string;
}

// The full one-layer decomposition the brain returns: the children (each classified
// and footprinted) and the seams between them. The orchestrator commits it.
export interface Decomposition {
  children: ChildPlan[];
  seams: SeamPlan[];
}

// The non-evidentiary context a brain judgment is granted (mirrors `CriticContext`,
// §3.6): the worktree it may inspect, and the granted MCP servers it connects to as
// a client. Deliberately carries NO `.relay/` handle — the brain cannot write the
// durable state.
export interface BrainContext {
  worktree: string;
  mcpServers: readonly McpServerConfig[];
}

export interface DecomposeRequest {
  // The node being decomposed one layer (§3.3).
  spec: OutcomeSpec;
  // The learnings accumulated reaching this node — including a promoted leaf's
  // keep-lesson reflection, so the re-decomposition does not relearn why it failed
  // (§3.5).
  context: { learnings: readonly string[] };
}

export interface Brain {
  decompose(req: DecomposeRequest, ctx: BrainContext): Promise<Decomposition>;
}

// A deterministic 2-way split mirroring the M1–M3 `stubDecompose`: two leaf
// children, each inheriting the parent's verifications (so a driven child grades
// against the same checks), with disjoint write footprints and one file-boundary
// seam between them. Pure and fixed so a kill-and-rehydrate reproduces identical
// child records (the rehydration contract, §3.2); it is the default brain on the
// spine's hermetic tests, replacing the stub decomposer.
export const stubBrain: Brain = {
  decompose(req: DecomposeRequest): Promise<Decomposition> {
    const parentSpec = req.spec;
    const children: ChildPlan[] = [0, 1].map((i) => {
      const part = (i + 1).toString();
      return {
        spec: {
          outcome: `${parentSpec.outcome} (part ${part} of 2)`,
          verifications: parentSpec.verifications,
        },
        kind: 'leaf' as NodeKind,
        footprint: { writeGlobs: [`part-${part}/**`] },
      };
    });
    const seams: SeamPlan[] = [
      {
        id: 'seam-0',
        kind: 'file-boundary',
        producer: 0,
        consumer: 1,
        payload: {
          producerGlobs: children[0].footprint.writeGlobs,
          consumerGlobs: children[1].footprint.writeGlobs,
        },
        intent: 'the two parts write disjoint paths and compose into the parent outcome',
      },
    ];
    return Promise.resolve({ children, seams });
  },
};

export interface BrainInvocation {
  bin: string;
  args: string[];
  cwd: string;
}

export interface BrainInvocationResult {
  stdout: string;
  code: number;
}

export interface AgentBrainOptions {
  // Which provider renders the judgment. The orchestrator's own judgment runs on
  // the author provider by default; the harness resolves that choice.
  provider: BrainProvider;
  // Per-role cost-guardrail knob (design §8): omitted pins the provider's cheapest
  // model, mirroring the executor and critic adapters.
  model?: string;
  // The provider binary; defaults to the one on PATH.
  bin?: string;
  // Injectable CLI runner so the brain is exercisable without the real model
  // (hermetic tests). Defaults to spawning `bin` with the built argv.
  invoke?: (call: BrainInvocation) => Promise<BrainInvocationResult>;
  // Observe the judgment call's usage (F5); the harness records it into the same
  // per-call sink as the executor/critic so the recap surfaces it.
  onUsage?: (usage: ExecutorUsage) => void;
}

// Render the decompose prompt. The model is asked to decompose ONE layer (lazy,
// §3.3), classify each child, pin footprints + seams, and return a single fenced
// JSON document the spine parses deterministically.
export function buildDecomposePrompt(req: DecomposeRequest): string {
  const lines: string[] = [
    'You are decomposing one outcome into the SINGLE next layer of sub-outcomes.',
    'Decompose only ONE layer down — do not plan deeper structure; later layers are',
    'decomposed when each child activates. For each child, also decide whether it is',
    'a `leaf` (small enough to hand to one executor, do in a single shot, and verify)',
    'or a `branch` (still too big — it will be decomposed one more layer). Pin each',
    "child's resource footprint (the repo-relative globs it will write) and the seams",
    'between children (shared interfaces where their outputs must meet).',
    '',
    `Outcome to decompose: ${req.spec.outcome}`,
  ];
  if (req.spec.verifications.length > 0) {
    lines.push('', 'The parent outcome is verified by:');
    for (const v of req.spec.verifications) {
      lines.push(`- [${v.kind}] ${v.check} (grounding: ${v.grounding})`);
    }
  }
  if (req.context.learnings.length > 0) {
    lines.push('', 'Prior attempts established (do not relearn — let this inform the split):');
    for (const l of req.context.learnings) {
      lines.push(`- ${l}`);
    }
  }
  lines.push(
    '',
    'Return ONLY a single fenced ```json block with this shape:',
    '{',
    '  "children": [',
    '    { "outcome": string, "kind": "leaf" | "branch",',
    '      "verifications": [ { "kind": string, "grounding": string, "check": string } ],',
    '      "footprint": { "writeGlobs": [string] } }',
    '  ],',
    '  "seams": [',
    '    { "id": string, "kind": "interface"|"http"|"file-boundary"|"data-schema",',
    '      "producer": number, "consumer": number, "intent": string, "payload": object }',
    '  ]',
    '}',
    'where seam producer/consumer are 0-based indices into children. Use an empty',
    'seams array if the children share no interface to pin.',
  );
  return lines.join('\n');
}

// Build the read-only judgment argv. The brain inspects to inform its split but
// never edits (it produces no diff), so Claude gets only inspection tools and Codex
// runs `--sandbox read-only`. The model is always pinned (cost guardrail), and the
// granted MCP servers are routed in through the spine's shared grant builders.
export function buildBrainArgs(
  provider: BrainProvider,
  prompt: string,
  config: { model: string; mcpServers: readonly McpServerConfig[] },
): string[] {
  if (provider === 'claude') {
    return [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--allowedTools',
      'Read',
      'Glob',
      'Grep',
      '--model',
      config.model,
      ...claudeMcpArgs(config.mcpServers),
    ];
  }
  return [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--model',
    config.model,
    ...codexMcpArgs(config.mcpServers),
    prompt,
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

// Extract the JSON document from the model's review text. Prefer the last fenced
// ```json block; fall back to the first `{` … last `}` span so a model that emits
// bare JSON still parses. Returns the raw string for `JSON.parse`.
function extractJson(text: string): string {
  const fence = /```json\s*([\s\S]*?)```/gi;
  let last: string | null = null;
  for (let m = fence.exec(text); m !== null; m = fence.exec(text)) {
    last = m[1];
  }
  if (last !== null) return last.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  throw new Error('brain judgment carried no JSON decomposition');
}

function parseVerifications(value: unknown): Verification[] {
  if (!Array.isArray(value)) {
    throw new Error('decomposition child missing `verifications` array');
  }
  return value.map((raw) => {
    const v = asRecord(raw);
    if (!v || typeof v.kind !== 'string' || typeof v.check !== 'string') {
      throw new Error('decomposition verification missing string `kind`/`check`');
    }
    return {
      kind: v.kind as Verification['kind'],
      grounding: typeof v.grounding === 'string' ? v.grounding : '',
      check: v.check,
    };
  });
}

function parseFootprint(value: unknown): Footprint {
  const f = asRecord(value);
  const globs = f?.writeGlobs;
  if (!Array.isArray(globs) || !globs.every((g) => typeof g === 'string')) {
    throw new Error('decomposition child footprint missing string[] `writeGlobs`');
  }
  return { writeGlobs: globs };
}

// Deterministically parse + validate the model's decomposition (Rule 5/11): a
// malformed document fails loud rather than letting the loop commit a half-typed
// layer. Exported so the parse is testable without a model.
export function parseDecomposition(text: string): Decomposition {
  const doc = asRecord(JSON.parse(extractJson(text)));
  if (!doc) {
    throw new Error('brain decomposition is not a JSON object');
  }
  if (!Array.isArray(doc.children) || doc.children.length === 0) {
    throw new Error('brain decomposition has no children');
  }
  const children: ChildPlan[] = doc.children.map((raw) => {
    const c = asRecord(raw);
    if (!c || typeof c.outcome !== 'string') {
      throw new Error('decomposition child missing string `outcome`');
    }
    if (c.kind !== 'leaf' && c.kind !== 'branch') {
      throw new Error(`decomposition child has invalid kind: ${JSON.stringify(c.kind)}`);
    }
    return {
      spec: { outcome: c.outcome, verifications: parseVerifications(c.verifications) },
      kind: c.kind,
      footprint: parseFootprint(c.footprint),
    };
  });
  const seamsRaw = Array.isArray(doc.seams) ? doc.seams : [];
  const seams: SeamPlan[] = seamsRaw.map((raw, i) => {
    const s = asRecord(raw);
    if (!s) {
      throw new Error('decomposition seam is not an object');
    }
    const producer = s.producer;
    const consumer = s.consumer;
    if (typeof producer !== 'number' || typeof consumer !== 'number') {
      throw new Error('decomposition seam missing numeric `producer`/`consumer` index');
    }
    if (!inRange(producer, children.length) || !inRange(consumer, children.length)) {
      throw new Error('decomposition seam producer/consumer index out of range');
    }
    const kind = s.kind;
    if (
      kind !== 'interface' &&
      kind !== 'http' &&
      kind !== 'file-boundary' &&
      kind !== 'data-schema'
    ) {
      throw new Error(`decomposition seam has invalid kind: ${JSON.stringify(kind)}`);
    }
    return {
      id: typeof s.id === 'string' ? s.id : `seam-${i.toString()}`,
      kind,
      producer,
      consumer,
      payload: asRecord(s.payload) ?? {},
      intent: typeof s.intent === 'string' ? s.intent : '',
    };
  });
  return { children, seams };
}

function inRange(i: number, len: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < len;
}

function defaultInvoke(call: BrainInvocation): Promise<BrainInvocationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(call.bin, call.args, { cwd: call.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code: code ?? 1 }));
  });
}

function parseProviderStream(
  provider: BrainProvider,
  stdout: string,
  model: string,
  wallClockMs: number,
): { review: string; usage: ExecutorUsage } {
  if (provider === 'claude') {
    const p = parseClaudeStream(stdout);
    return {
      review: p.selfReport,
      usage: {
        provider: 'claude',
        model: p.model ?? model,
        inputTokens: p.inputTokens,
        cachedInputTokens: p.cachedInputTokens,
        outputTokens: p.outputTokens,
        wallClockMs,
        costUsd: p.costUsd,
      },
    };
  }
  const p = parseCodexStream(stdout);
  return {
    review: p.selfReport,
    usage: {
      provider: 'codex',
      model: p.model ?? model,
      inputTokens: p.inputTokens,
      cachedInputTokens: p.cachedInputTokens,
      outputTokens: p.outputTokens,
      wallClockMs,
      costUsd: p.costUsd,
    },
  };
}

// The real brain: a cross-provider-capable judgment agent connected to the granted
// MCP servers, returning a parsed decomposition. It writes nothing durable; the
// orchestrator commits what it returns.
export function agentBrain(opts: AgentBrainOptions): Brain {
  const provider = opts.provider;
  const bin = opts.bin ?? provider;
  const model = opts.model ?? (provider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL);
  const invoke = opts.invoke ?? defaultInvoke;

  return {
    async decompose(req: DecomposeRequest, ctx: BrainContext): Promise<Decomposition> {
      const prompt = buildDecomposePrompt(req);
      const args = buildBrainArgs(provider, prompt, { model, mcpServers: ctx.mcpServers });
      const start = Date.now();
      const { stdout } = await invoke({ bin, args, cwd: ctx.worktree });
      const wallClockMs = Date.now() - start;
      const { review, usage } = parseProviderStream(provider, stdout, model, wallClockMs);
      opts.onUsage?.(usage);
      // Code reads the answer the model produced (Rule 5); a malformed judgment
      // fails loud (Rule 11) rather than committing a half-typed layer.
      return parseDecomposition(review);
    },
  };
}
