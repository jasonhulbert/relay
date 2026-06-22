# Relay — agent orientation

Relay is a terminal-based, multi-provider loop orchestrator for software work. The
operator specifies a verifiable **outcome**; capable models decide how to reach it
just in time. Relay turns that outcome into a loop it runs and verifies on its own,
handing the actual work to Claude Code or Codex as interchangeable executor
backends. Target platform is macOS, shipped as a single binary via Node SEA.

## The mental model

The orchestrator **is** the loop, and the loop is a **code-owned state machine** —
not an autonomous agent. Internalize these invariants before changing anything:

- **Code owns the loop and the writes.** Code owns dispatch, the gates, and every
  write to `.relay/`. A model is called only for discrete judgments (decompose,
  execute, critique). No model owns the loop or the durable state.
- **Agents are disposable; truth lives in `.relay/`.** Orchestrators are stateless
  views over an on-disk Markdown record. One OS process per active orchestrator.
  Any instant of `.relay/` is coherent enough to reconstitute the orchestrator that
  owns it; a non-`done` child found at rehydration is discarded and re-dispatched.
- **No shared write target.** Each orchestrator is the sole writer of its own
  subtree region, so concurrent orchestrators write disjoint files with no locks.
  Global views (run log, cross-tree render) are **read-time projections** composed
  from per-node files, never stored as a shared mutable file.
- **Done-ness is ruled by an independent critic.** A cross-provider critic decides
  acceptance and sees **evidence only** — spec, diff, evidence refs — never the
  executor's self-report. This split is enforced at a runtime chokepoint (a single
  constructor for the critic view, a branded type, a property test), not by
  prompting. Never hand a raw node record to a critic.
- **MCP is the capability bus.** The spine is the MCP host: it authors first-party
  servers and routes granted servers into the agents it spawns. Agents are
  `claude -p` / `codex exec` CLIs that connect as MCP clients.
- **Surface correctable failures to the human.** Mismatches and ambiguous or
  irreversible gates go to the human-owned decision inbox. Orchestrators only read
  and drain it; they never auto-resolve or silently swallow such cases.

## Where things live (`src/`)

- `index.ts` — the CLI. Three commands: `relay run` is the real entry — it grills
  intake (or compiles a grounded seed from `--outcome`), commits a CHILDLESS root,
  lets the orchestrator decompose + execute it, and applies the verified result
  back as a `relay/<runId>` branch; `relay dev-run --outcome <text>` is the
  dev/eval harness — it hand-seeds a single-leaf root (no intake, no decomposition)
  and drives the same real orchestrator against the project's `~/.relay/` store;
  `relay web` serves a read-only browser view of that store.
- `spine/` — the orchestrator state machine: dispatch, promotion, done/blocked
  transitions, the brain (decompose judgment), the critic, cost telemetry, and the
  per-region write-ahead intent journal. `spine/adapters/` holds the Claude and
  Codex executor adapters behind one uniform `Executor` contract.
- `relay-state/` — the on-disk `.relay/` mechanics: node files, root manifest,
  evidence refs, the decision inbox, the intent journal with idempotent
  roll-forward, and the read-time projections. Code here is the sole writer.
- `mcp/` — the routing chokepoint that translates granted MCP server configs into
  each provider's CLI grant flags.
- `intake/` — the bounded conversational compiler that grills the human and
  compiles a run seed (outcome spec + grounded verifications + a non-binding
  sketch), then commits it as the `.relay/` root.
- `surface/` — visual/behavioral verification: the `Surface` contract, a
  WebSurface driver over a Playwright MCP, the local-host runner, the visual critic
  path, and the baseline pipeline.
- `webview/` — the read-only local web view: a projection of `.relay/` plus the
  human decision inbox, served over loopback HTTP.
- `dogfood/` — real outcomes Relay runs against itself (the evidence compactor, the
  drill-in panel), each with a seed, a graded fixture, and a loop test.

## Build and checks

- `npm run build` — bundle with esbuild, then produce the single macOS binary via
  Node SEA (`scripts/build.mjs`, see `docs/sea-notes.md`).
- `npm test` — Vitest. Property tests use `fast-check`. Integration tests are named
  `*.integration.test.ts`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — ESLint. `npm run format` / `format:check` — Prettier.

Node 22 (`.nvmrc`). Runtime deps are only the MCP SDK and `yaml`; everything else
is dev-only.

## Conventions

- Use conventional-commit style commits.
- Tests encode **why** behavior matters, not just what it does — a test that can't
  fail when the intent regresses is wrong.
- The richest orientation is the header comment atop each module's `index.ts`. Read
  it before touching that module. For the on-disk record, read
  `docs/relay-state-layout.md`.
