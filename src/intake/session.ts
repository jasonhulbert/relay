// The bounded interactive intake session (design §3.11, C3, M6 Phase 1): the
// system's ONE genuinely conversational agent. It grills the human one question at a
// time until it can distill a run seed, then terminates at approval. Its only output
// is an `IntakeSeed` (I1/I2) — it holds no executor, orchestrator, or `.relay/`
// handle, so it is structurally incapable of "continuing into execution." Committing
// the seed as the `.relay/` root is Phase 2; this module stops at the seed.
//
// Like the brain (§3.3), the interviewer is an AGENT (a `claude -p` / `codex exec`
// shell-out) that returns structured data the code reads (Rule 5). The "interactive"
// quality lives in the LOOP here — the human answers between turns — not in a
// persistent REPL: each turn re-feeds the running transcript, exactly as the brain
// builds a fresh prompt per call. The loop is bounded (a max-questions cap) so a
// runaway interview terminates loudly rather than grilling forever (Rule 11).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_CLAUDE_MODEL, parseClaudeStream } from '../spine/adapters/claude';
import { DEFAULT_CODEX_MODEL, parseCodexStream } from '../spine/adapters/codex';
import { compileSeed } from './seed';
import type { IntakeSeed } from './seed';

export type IntakeProvider = 'claude' | 'codex';

// One exchange in the conversation transcript. The interviewer is re-fed the whole
// transcript each turn so its next question (or the seed) is grounded in everything
// the human has already said.
export interface TranscriptEntry {
  role: 'interviewer' | 'human';
  text: string;
}

// The interviewer's next move: either ask the human one more question, or finalize by
// returning the compiled seed (the human approved it — the conversation ends here).
export type InterviewerTurn = { done: false; question: string } | { done: true; seed: IntakeSeed };

// The conversational agent. Given the transcript so far, it produces its next turn.
// The real one shells out to a provider; tests inject a scripted one (cf. how the
// brain tests inject an inline `Brain`).
export interface Interviewer {
  next(transcript: readonly TranscriptEntry[]): Promise<InterviewerTurn>;
}

// How the human answers a question the interviewer puts to them. Production reads a
// line from stdin (`stdinAsk`); tests inject scripted answers. This and the
// `Interviewer` are the session's ONLY collaborators — there is deliberately no
// execution capability in scope, so intake cannot bleed into running the loop.
export type AskHuman = (question: string) => Promise<string>;

// Default cap on questions before the interview MUST converge on a seed. Bounded
// component (C3): keeps the one conversational agent finite.
export const DEFAULT_MAX_QUESTIONS = 24;

export interface IntakeOptions {
  interviewer: Interviewer;
  ask: AskHuman;
  // Optional opening framing seeded as the human's first transcript line (e.g. a
  // one-line statement of what they want). Omitted starts from a blank slate.
  opening?: string;
  // Max questions the grilling may put to the human before it must produce a seed.
  maxQuestions?: number;
}

export interface IntakeResult {
  // The conversation's sole output (I1/I2). Phase 2 commits this as the root.
  seed: IntakeSeed;
  // The full Q&A transcript, in order. Kept for the recap / evidence; never executed.
  transcript: TranscriptEntry[];
  // How many questions the human answered before approval.
  questionsAsked: number;
}

// Drive the bounded interview to a seed. Terminates at the interviewer's `done` turn
// (approval) and returns the seed; it NEVER dispatches an executor or touches
// `.relay/`. If the interviewer keeps asking past `maxQuestions` without converging,
// that is a loud failure (Rule 11), not a silently truncated seed.
export async function runIntake(opts: IntakeOptions): Promise<IntakeResult> {
  const maxQuestions = opts.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const transcript: TranscriptEntry[] = [];
  if (opts.opening !== undefined && opts.opening !== '') {
    transcript.push({ role: 'human', text: opts.opening });
  }
  let questionsAsked = 0;

  for (;;) {
    const turn = await opts.interviewer.next(transcript);
    if (turn.done) {
      // Approval: the seed is the conversation's only output. Return control to the
      // caller (Phase 2 decides to commit); intake itself stops here.
      return { seed: turn.seed, transcript, questionsAsked };
    }
    if (questionsAsked >= maxQuestions) {
      throw new Error(
        `intake did not converge on a seed within ${maxQuestions.toString()} questions`,
      );
    }
    transcript.push({ role: 'interviewer', text: turn.question });
    const answer = await opts.ask(turn.question);
    transcript.push({ role: 'human', text: answer });
    questionsAsked += 1;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

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
  throw new Error('interviewer turn carried no JSON document');
}

// Deterministically read the interviewer's turn from its message (Rule 5). The turn
// is discriminated by `kind`: a `question` turn carries the next question; a `seed`
// turn carries the seed fields at top level, so it is itself a valid `compileSeed`
// input (the `kind` field is ignored by the compiler). A malformed/ambiguous turn
// fails loud (Rule 11). Exported so the parse is testable without a live model.
export function parseInterviewerTurn(message: string): InterviewerTurn {
  const doc = asRecord(JSON.parse(extractJson(message)));
  if (!doc) {
    throw new Error('interviewer turn is not a JSON object');
  }
  if (doc.kind === 'question') {
    if (typeof doc.question !== 'string' || doc.question.trim() === '') {
      throw new Error('interviewer question turn missing non-empty `question`');
    }
    return { done: false, question: doc.question };
  }
  if (doc.kind === 'seed') {
    // The seed fields live at the top level of the same document; reuse the seed
    // compiler so the turn and the fixture path validate identically.
    return { done: true, seed: compileSeed(message) };
  }
  throw new Error('interviewer turn missing `kind` of "question" | "seed"');
}

// Render the interviewer prompt: the role (grill the human toward a verifiable
// outcome + grounded verifications + a SHORT non-binding sketch), the strict turn
// protocol it must emit, and the transcript so far. One question at a time keeps the
// conversation bounded and legible.
export function buildInterviewerPrompt(
  transcript: readonly TranscriptEntry[],
  opening?: string,
): string {
  const lines: string[] = [
    'You are the intake interviewer for a single automated run. Your job is to grill',
    'the human until you can write a precise run SEED, then stop. Ask exactly ONE',
    'question per turn, building on their previous answers, until you can pin down:',
    '  - outcome: one verifiable statement of what "done" means;',
    '  - verifications: how done-ness will be checked, each with explicit grounding',
    '    (what evidence makes the check trustworthy) — at least one;',
    '  - sketch: a SHORT, non-binding list of high-level orientation notes. This is',
    '    NOT a plan or task breakdown; the orchestrator is free to ignore it.',
    'Do not start any work and do not propose a binding decomposition.',
    '',
    'Each turn, output ONLY a single fenced ```json block, one of:',
    '  { "kind": "question", "question": string }',
    '  { "kind": "seed", "outcome": string,',
    '    "verifications": [ { "kind": string, "grounding": string, "check": string } ],',
    '    "sketch": { "notes": [string] } }',
    'Emit the "seed" turn only once you have enough to write all three parts.',
  ];
  if (opening !== undefined && opening !== '') {
    lines.push('', `The human opened with: ${opening}`);
  }
  if (transcript.length > 0) {
    lines.push('', 'Conversation so far:');
    for (const entry of transcript) {
      const who = entry.role === 'interviewer' ? 'You asked' : 'Human';
      lines.push(`- ${who}: ${entry.text}`);
    }
  }
  lines.push('', 'Produce your next turn now.');
  return lines.join('\n');
}

// Build the conversational argv. The interviewer needs no tools and writes nothing —
// it only talks — so Claude gets no `--allowedTools` and Codex runs `--sandbox
// read-only`. The model is always pinned (the cost guardrail, §8), mirroring the
// brain and adapters.
export function buildInterviewerArgs(
  provider: IntakeProvider,
  prompt: string,
  model: string,
): string[] {
  if (provider === 'claude') {
    return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model];
  }
  return [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--model',
    model,
    prompt,
  ];
}

export interface InterviewerInvocation {
  bin: string;
  args: string[];
  cwd: string;
}

export interface InterviewerInvocationResult {
  stdout: string;
  code: number;
}

export interface AgentInterviewerOptions {
  // Which provider renders the conversation. Provider-agnostic by design (C3).
  provider: IntakeProvider;
  // Per-role cost-guardrail knob (§8): omitted pins the provider's cheapest model.
  model?: string;
  // The provider binary; defaults to the one on PATH.
  bin?: string;
  // Working directory for the shell-out; defaults to the current directory. Intake
  // runs before any worktree exists, so this is just where the CLI is launched.
  cwd?: string;
  // Injectable CLI runner so the interviewer is exercisable without the real model
  // (hermetic tests). Defaults to spawning `bin` with the built argv.
  invoke?: (call: InterviewerInvocation) => Promise<InterviewerInvocationResult>;
}

function defaultInvoke(call: InterviewerInvocation): Promise<InterviewerInvocationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(call.bin, call.args, { cwd: call.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code: code ?? 1 }));
  });
}

function providerMessage(provider: IntakeProvider, stdout: string): string {
  // Both providers' final prose is the bounded `selfReport` the adapters already
  // parse; the interviewer's turn JSON rides in that final message.
  return provider === 'claude'
    ? parseClaudeStream(stdout).selfReport
    : parseCodexStream(stdout).selfReport;
}

// The real interviewer: a provider shell-out that, given the transcript, returns its
// next parsed turn. Provider-agnostic (C3) and tool-free; it writes nothing durable.
export function agentInterviewer(opts: AgentInterviewerOptions): Interviewer {
  const provider = opts.provider;
  const bin = opts.bin ?? provider;
  const model = opts.model ?? (provider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL);
  const cwd = opts.cwd ?? process.cwd();
  const invoke = opts.invoke ?? defaultInvoke;

  return {
    async next(transcript: readonly TranscriptEntry[]): Promise<InterviewerTurn> {
      const prompt = buildInterviewerPrompt(transcript, undefined);
      const args = buildInterviewerArgs(provider, prompt, model);
      const { stdout } = await invoke({ bin, args, cwd });
      // Code reads the model's answer (Rule 5); a malformed turn fails loud (Rule 11).
      return parseInterviewerTurn(providerMessage(provider, stdout));
    },
  };
}

// The production human-answer source: read one line from stdin per question. The
// interactive half of "grill the human." Tests never use this — they inject scripted
// answers — so the loop stays hermetic.
export function stdinAsk(prompt: (q: string) => string = (q) => `${q}\n> `): AskHuman {
  return async (question: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(prompt(question))).trim();
    } finally {
      rl.close();
    }
  };
}
