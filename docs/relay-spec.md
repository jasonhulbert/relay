# Relay — canonical spec

This is the living "how and why" reference for Relay's architecture. It explains
what the system does, how the loop actually runs, and the reasoning behind the
decisions that shape it. `AGENTS.md` is the short orientation; `README.md` is the
pitch; this document is the deep reference they both point into.

## What Relay is

Relay is a terminal-based, multi-provider orchestrator for software work. You
describe a **verifiable outcome** — what "done" looks like and how to check it —
and capable models decide how to reach it just in time. Relay turns that outcome
into a loop it runs and verifies on its own, handing the actual work to Claude
Code or Codex as interchangeable executor backends. It targets macOS and ships as
a single binary.

One principle governs every decision in the system:

> **Don't depend on a model behaving well under pressure. Make the structure
> hold the truth, make the agents disposable, and author every durable record
> for the specific consumer whose correctness depends on it.**

Models are fallible, and they fail most where it costs the most: under long
context, ambiguous instructions, and the standing incentive to declare success.
So Relay never asks a model to be the thing that stays honest. Instead:

- The structure holds the truth. Durable state lives in files that code writes and
  owns. No model is trusted to maintain it, and no model's word is the system of
  record.
- The agents are disposable. Any agent can be killed and re-created from the
  on-disk record. Nothing the loop depends on lives only inside an agent's head,
  so losing an agent costs a re-dispatch, never correctness.
- Every record is authored for its reader. Each durable artifact is written for the
  exact consumer whose correctness depends on it. The clearest case is the critic:
  it is shown evidence only, never the executor's self-report, because what it
  reads decides whether work is accepted.

Everything below is an application of this one idea.

## Mental model

The orchestrator is the loop, and the loop is a **code-owned state machine** —
not an autonomous agent. A model is called only for discrete judgments inside a
loop that code drives, gates, and records. Four pillars carry the whole design.

- **Code owns the loop and the writes.** Code owns dispatch, the gates, and every
  write to `.relay/`. A model is invoked only for bounded judgments — decompose a
  node, execute a leaf, critique a result — and its answer is data the loop acts
  on, never control the loop hands over. No model owns the loop or the durable
  state.
- **Agents are disposable; truth lives in `.relay/`.** Orchestrators are stateless
  views over an on-disk Markdown record, one OS process per active orchestrator.
  Any instant of `.relay/` is coherent enough to reconstitute the orchestrator
  that owns it. A child found in a non-`done` state at rehydration is discarded and
  re-dispatched, because a half-finished agent's state is never trusted — only the
  record is.
- **No shared write target.** Each orchestrator is the sole writer of its own
  subtree region, so concurrent orchestrators write disjoint files with no locks.
  Anything that needs a whole-tree view — the run log, the cross-tree render — is a
  read-time projection composed from the per-node files, never a shared mutable
  file that two writers contend over.
- **Done-ness is ruled by an independent critic.** A cross-provider critic decides
  acceptance, and it sees evidence only — the spec, the diff, the evidence
  refs — never the executor's self-report. The split is enforced at a runtime
  chokepoint, not by prompting: a single constructor builds the critic's view, a
  branded type marks it, and a property test guards it. A false "done" is more
  dangerous than a false "failed", so the judge is structurally prevented from ever
  reading the worker's own claim of success.

These four are invariants, not preferences. The rest of this document shows how the
loop, the guarantees, and each subsystem are built to keep them true.

## The core loop

Relay runs one loop, and it is the same loop at every level of the tree. An
orchestrator owns a single node, drives it to a verdict, and dies. What follows is
one full activation, end to end.

**Activate and drain the inbox.** An orchestrator wakes on its node — a fresh
process, or one rehydrated from `.relay/` after a kill. Before anything else it
drains the human decision inbox for its own region, applying any pending decisions
— gate approvals, answers to a blocked node, budget changes — as ordinary atomic
transitions. Cancellation is the one thing it does not wait for here; a
cancellation preempts through the failure rule instead.

**Decompose one lazy layer (branch path).** If the node is a branch, the
orchestrator decomposes exactly one layer down, and only now, informed by
everything learned on the way to this node. Deeper structure does not exist yet —
the plan is emergent, materializing one level ahead of execution. Decomposing a
layer is more than naming children. It also pins, for this layer only, each
child's resource footprint (the files, ports, databases, and the single shared
macOS session it will touch) and the seams between children — their interfaces.
These are short-horizon local predictions about one layer, not a long-range master
plan, which is why they don't break laziness: they are what a layer is. The
reasoning behind the split is persisted as node-attributed evidence the
orchestrator and human can read but the critic never sees.

**Schedule by the concurrency law.** Two children may run at the same time only if
both conditions hold: their footprints are disjoint, and the seam between them can
be pinned now. Otherwise they serialize. The sharp corollary: if a seam cannot be
known until one sibling explores its territory, the siblings have a real dependency
and must run in order — the explorer derives the seam, then its peer consumes it. A
layer is serial by default; concurrency is the justified exception, not the
assumption.

**Dispatch.** The orchestrator dispatches per the schedule. Each child is either a
sub-orchestrator — a branch run as its own OS process over its own subtree — or an
executor: a fresh `claude -p` or `codex exec` spawned in its own worktree, handed
its granted MCP servers, doing one outcome and dying.

**Execute and gate a leaf (leaf path).** A leaf's executor runs in a worktree
seeded from the real project, returns, and writes its self-report into `.relay/`
where only the orchestrator can read it. The orchestrator captures the diff against
the seeded base and hands an independent critic — a different provider by default —
the evidence only: the outcome spec, the diff, and the captured evidence, never the
self-report. The critic decides done-ness. An empty diff is not automatically a
failure; the critic grades it against the spec, telling "already satisfied" apart
from a non-attempt by the seed mode.

**Climb the escalation ladder on failure.** When the critic fails a leaf, the
orchestrator discards the worktree clean — the attempt's learnings are already
persisted, so a clean restart is never an amnesiac one — and climbs a fixed ladder:
retry, then swap to a different provider, then raise the model tier. If the outcome
is judged too big, or the ladder is running out, the leaf is promoted to a branch
and re-decomposed a layer down. If the ladder is exhausted, the node is marked
blocked with a self-sufficient exhaustion summary and enters the failure rule. The
blocked record names which rungs were already spent, so a rehydrating orchestrator
knows in one read not to re-burn the ladder.

**Gather verdicts and run the integration gate (branch path).** Compact verdicts
come back: a leaf returns its diff plus evidence, a sub-orchestrator returns a
verified outcome contract plus the seam evidence its parent needs. When any child
in a layer ran concurrently, the branch cannot simply declare itself done. Parallel
siblings each forked from the same pre-layer base and never saw each other, so no
per-child critic ever witnessed their combination. The integration gate recovers
that witness: the orchestrator merges the finished layer onto a throwaway copy of
the one fixed per-run base and re-runs its own critic on the merged whole against
its own spec. This catches silent conflicts — diffs that merge cleanly but are
semantically incompatible — and because the merge is deterministic against that
fixed base, the merged whole the critic judges is exactly what apply-back will
land. Pass marks the branch done; fail is treated as this node's own failure and
enters the failure rule.

**Halt and surface on terminal failure.** A doneness-failure propagates to the root
unconditionally. Relay never routes around a dead node to call the rest of the run
a success. The failure rule traces the seam graph out from the dead node:
seam-dependents, including the node's own siblings, are cancelled and discarded;
seam-independent work already in flight is drained to completion and then
quarantined. The run halts and surfaces at the root with the self-sufficient
blocked record.

**Apply back at the root.** Only when the root reaches done does the run land its
result, and only on the root critic's committed verdict — never a self-report. Two
acts, in order. First the canonical verified change is persisted as patch evidence
in `.relay/`. Because that durable record exists before any branch does, landing
the work is a deterministic re-derivation of truth, not a fresh act of trust. Then
the orchestrator builds the branch `relay/<runId>` off the per-run base — one
commit in a throwaway worktree, leaving the operator's working tree and `HEAD`
untouched. The branch is reviewable output, not the system of record. A snapshot
seed lands a patch only; the hermetic `dev-run` lands nothing. A dirty tree, a
non-git workspace, or an apply conflict surfaces on the CLI with a non-zero exit,
not in the inbox — that report runs from orchestrator to human, the opposite
direction of the inbox.

The whole activation as one picture:

```
An orchestrator activates on a node — a fresh process, or rehydrated from .relay/

  Drain the decision inbox
    apply the human's pending decisions for this region (approvals, answers,
    budget changes) as atomic transitions
    cancellation does NOT wait here — it preempts through the failure rule

  If the node is a BRANCH:
    Decompose ONE layer (a judgment call): children + footprints + seams → commit
    Build the schedule from the concurrency law:
      disjoint footprints AND seam knowable now → may run CONCURRENTLY
      shared resource OR seam not yet knowable   → run SERIALLY
    Dispatch per schedule: each child → sub-orchestrator (own process) or executor (leaf)
    Gather verdicts: leaf → diff + evidence
                     sub-orchestrator → verified outcome contract + seam evidence
    INTEGRATION GATE (required if any child ran concurrently):
      merge the finished layer → re-run THIS node's critic on the merged whole
        against THIS node's spec
      pass → mark the branch done, report its contract upward
      fail → treat as this node's own failure → failure rule
    Any child terminally blocked → failure rule

  If the node is a LEAF:
    Dispatch a fresh executor in its own worktree, seeded from the project
      (checkout off the per-run base | snapshot if dirty/non-git | empty for dev-run)
    Executor returns → write its self-report to .relay/ (orchestrator-visible only)
    Capture the diff vs the seeded base (an empty diff is allowed, and graded)
    Spawn an independent critic (a different provider) with the critic-visible
      projection only: outcome spec + diff + evidence; NO narrative
      an empty diff is graded here too: "already satisfied" vs non-attempt, by seed mode
    critic passes → mark the leaf done, report a compact verdict upward
    critic fails → discard the worktree (learnings already persisted), then climb the
      ESCALATION LADDER:
        within budget → retry → swap provider → raise tier
        judged too big (or ladder exhausting) → promote leaf → branch, re-decompose
        ladder exhausted → mark BLOCKED (exhaustion summary) → failure rule

The FAILURE RULE (coordinated at the root):
  a doneness-failure reaches the root unconditionally — no route-around
  a human cancellation enters here too, preemptively
  dispatch no new work anywhere
  trace the seam graph out from the dead/cancelled node:
    seam-dependents (incl. its siblings) → cancel + discard (persist learnings first)
    seam-independent work in flight       → drain to completion, then quarantine
  halt and surface at the root with the self-sufficient blocked record

APPLY-BACK (only when the root is done):
  persist the canonical verified change as patch evidence FIRST (the re-derivable record)
  then build the branch relay/<runId> off the per-run base — one commit, operator
    worktree and HEAD untouched
  gated only on the committed root critic verdict, never a self-report
  snapshot → patch only (no branch); empty/dev-run → no apply-back
  dirty tree / non-git / apply conflict → CLI recap + stderr, exit non-zero (not the inbox)

Every transition is an atomic .relay/ commit; rehydration sees only pre- or post-state,
never a torn write, and discards and re-dispatches any non-done child it finds.
```

## The guarantees

The loop only holds together because a handful of invariants are guaranteed by
construction. Each one rests on a specific piece of reasoning, given inline below.

### Disposable, rehydratable state

The rehydration contract is the foundation: any instant of `.relay/` is coherent
enough to reconstitute the orchestrator that owns it. Orchestrators are stateless
views over the on-disk record, one OS process each. Kill one mid-flight and a
replacement rebuilds its entire working state by reading its region — nothing the
loop depends on lived only in the dead process's memory. The rule that makes this
safe is strict: a child found in any non-`done` state at rehydration is discarded
and re-dispatched, never resumed. A half-finished agent's in-memory state is never
trusted; only the committed record is. So the cost of a kill is a re-dispatch,
never a corrupted result — which is exactly what lets Relay treat agents as
disposable without losing work.

### The evidence-only critic

Done-ness is decided by a critic that never sees the worker's story. The
executor's self-report and the critic's evidence are two separate projections of
the same node: the orchestrator-visible projection carries the self-report and
learnings, while the critic-visible projection carries only the outcome spec, the
diff, and the captured evidence. The split is enforced at a runtime chokepoint,
not by prompting — a single constructor builds the critic view, a branded type
makes a raw record impossible to pass, and a property test asserts the view holds
no narrative field. The reason for the machinery: a false "done" is more dangerous
than a false "failed", because it propagates upward as truth and later work builds
on it. Structure beats steering here. You cannot reliably instruct a model to
ignore a self-report it can see, so Relay makes sure it never sees one. The critic
is also a different provider by default, so one model's blind spot cannot both
produce and bless the same mistake.

### Ownership-partitioned writes

Each orchestrator is the sole writer of its own subtree region — its node file and
the one child manifest it decomposed. Concurrent orchestrators therefore write
disjoint files, with no locks and no write races, because the process model
guarantees no two of them ever target the same path. The only cross-region write
is a parent recording a child's returned verdict into the parent's own region, and
that is funnelled serially within the parent. Anything that needs a whole-tree view
— the run log, a cross-tree render, the per-run cost rollup — is a read-time
projection composed from the per-node files on demand, never a shared mutable file
that two writers contend over. Refusing a shared write target is what makes
lock-free concurrency correct, not merely fast.

### Halt and surface on terminal failure

When a node exhausts its options and goes terminally blocked, that failure reaches
the root unconditionally. Relay does not route around a dead node to declare the
rest of the run a success — a doneness-failure is load-bearing and must be seen.
The failure rule stops dispatching new work, then traces the seam graph out from
the dead node: seam-dependents, including its siblings, are cancelled and their
worktrees discarded once their learnings are persisted; seam-independent work
already in flight is drained to completion and quarantined rather than thrown away.
The run then halts and surfaces at the root with a self-sufficient blocked record —
one that explains what is wrong without making the reader reconstruct the run. A
correctable failure is the human's to resolve, never the loop's to silently
swallow.

### Atomic `.relay/` transactions

A structural change usually touches several files at once — a promotion, a done or
blocked transition, the failure rule's cancellations, applying a drained human
decision. Each is made atomic by a per-region write-ahead intent journal. The
orchestrator writes one intent file holding the complete post-state of every file
the transaction touches and fsyncs it; that fsync is the commit point. It then
applies the named writes and removes the intent. A rehydrating orchestrator that
finds an intent rolls it forward idempotently before doing anything else — the
intent carries full target contents, so re-applying is always safe — then removes
it. The journal is per-region, so an orchestrator bound to a node finds exactly its
own pending intent. The filesystem offers one atomic primitive, the single-file
rename; the journal lifts that to all-or-nothing across every file a transition
spans. This is what upholds the rehydration contract: a rehydrating reader sees
only the pre-state or the post-state, never a torn write.

## Subsystems

The loop and its guarantees are realized by five subsystems. Each is described
here at the concept level.

### State model

`.relay/` is the system of record: durable, human-readable, git-trackable plain
Markdown, with orchestrators as stateless views over it. The record is files-only
Markdown on purpose, chosen for inspectability over efficiency — a human can
`git log` the tree, diff two critic verdicts, and read a blocked node by eye.
SQLite was weighed as the record and rejected, because a single database is a
shared write target that collides head-on with the no-shared-write-target process
model, the very thing that makes lock-free concurrency correct. If large-tree reads
ever prove slow, a derived read-index is the deferred answer, not a migration of
the record itself.

Every node file carries two audiences, kept apart as projections: the
orchestrator-visible projection (self-report and learnings) and the
critic-visible projection (spec, diff, and evidence only). A third projection
serves the human supervisor — a read-only view composed for the operator. The
decompose reasoning is persisted as node-attributed evidence of kind `rationale`:
visible to the orchestrator and the human, never to the critic.

This section stays at the concept level. For the on-disk schema — the manifest,
node files, outcome contracts, the evidence store, the inbox, and the intent
journal — see [the on-disk layout reference](./relay-state-layout.md).

### Executors and the workspace bridge

Executors are disposable single-purpose workers behind one uniform adapter, so the
loop never special-cases a provider. The adapter runs a unit and returns the
produced changes (a diff — the critic's evidence), a self-report (narrative,
orchestrator-only), usage, and an exit status; a companion call reports the
backend's capabilities. One fresh executor per leaf, no long-lived sessions, and
executors never write durable state — only the owning orchestrator does.

Claude Code and Codex are interchangeable backends behind that adapter, each a
shell-out CLI: `claude -p` and `codex exec`. Their sandboxes are deliberately
symmetric. The Claude adapter runs with file edits auto-accepted inside the
worktree and denied outside it, matching the Codex OS-level workspace sandbox that
confines edits and subprocesses to the working directory. The honest residual gap:
the Claude file-edit scope does not cover `Bash`, so a shell command on the Claude
path can still write outside the worktree, where the Codex OS sandbox already
confines subprocesses. True subprocess confinement on the Claude path is a named,
deferred milestone, surfaced loudly rather than papered over.

A leaf's worktree is a view of the real project, not an empty directory, chosen
per run in one of three modes: a git checkout off a fixed per-run base (the clean
default, so diff capture yields only the executor's change); a file snapshot for a
dirty or non-git workspace; or empty, the greenfield baseline preserved
byte-for-byte for the hermetic harness. The seed is one half of the
real-workspace bridge. Apply-back is the other: when the root is done, the verified
change is persisted as patch evidence and then re-derived into a reviewable
`relay/<runId>` branch — one commit off the per-run base, the operator's working
tree untouched. The branch is durable output, never the system of record.

### Verification and the integration gate

The critic grounds every verdict in whatever evidence the outcome admits, cheapest
first: a command exiting cleanly, then a test, then an artifact or state assertion,
then a structural semantic-snapshot assertion, then a visual screenshot judgment,
then a cross-provider agent review of the diff and evidence, and finally a human
gate for the irreversible or ambiguous case. Every unit declares at least one
grounded verification, fixed at dispatch rather than chosen after the fact; a
verdict that cites no evidence is rejected, and the author of a change is never its
sole judge.

The independent critic is the gate on every non-trivially-checkable "done": a
different provider by default, evidence-only, projection-enforced at the
chokepoint, and applied at every altitude — a sub-orchestrator's done-ness is
critic-certified too, and its parent trusts the structural ledger fact that the
gate fired, not the child's narrative. When a layer ran any children concurrently,
the integration gate adds the cross-sibling check that parallelism strips: the
parent verifies composition cheapest-first — footprints from the write-ahead
journal catch the loud violations, each declared seam's code-checkable predicate is
answered by code rather than a model, and the parent's own evidence-only critic
re-runs on the merged whole to catch the silent ones. An empty diff is a gradeable
outcome here, not a failure: after a seed-from-project, the critic judges against
the spec whether the work was already satisfied, and only an empty diff that fails
against spec re-enters the escalation ladder.

### Surfaces and visual verification

Visual and behavioral verification live behind one Surface interface — attach or
launch, resize, snapshot, screenshot, interact, query state, report capabilities —
with pluggable drivers, supporting the structural and visual verification kinds
without touching the core loop. A web driver over Chrome DevTools and Playwright
covers web and Electron with full DOM and screenshots; a desktop driver reaches
native macOS through the accessibility tree, degrading to a pixel-crop where that
tree is thin.

The default runner is tier-A, a hands-off local-host runner on the developer's
logged-in macOS session. Because there is exactly one logged-in session, it is a
shared, non-disjoint resource: concurrent visual-verification leaves contend on it
and therefore serialize under the concurrency law. Interaction is semantic-first
and pixel-fallback — the critic reaches the verifiable state by replaying an
executor-emitted semantic-action path, capturing its own evidence rather than
re-driving the app by pixels. A visual outcome names a match granularity: intent
(tolerant multimodal judgment, the default), structural (assertions over a named
element's semantic subtree), or baseline-diff (pixel comparison against a stored
reference, strictest and most flake-prone). A baseline is captured, never authored
from nothing: the first run that passes at structural level or better promotes its
approved capture, and later runs diff against it; replacing a known-good baseline
needs human approval through the decision inbox. When richer runner tiers get built
is a measured decision, covered under Deferred.

### Provider routing and cost

Judgment and execution route differently. Orchestration, sizing, and critic
judgment go to the most-trusted planner in small discrete calls; heavy execution
goes to the cheaper-per-token path; the critic and visual judgment always route to
a different provider than the author. The orchestrator's own brain provider is a
routing choice, not a structural lock, and an explicit override always wins.

Cost telemetry is deterministic and parsed straight from each CLI's structured
stream — the same stream the loop already consumes for dispatch — recording
provider, model, token counts, wall-clock, and node for every call. There is no
billing API and no new credential path. Dollars are taken directly where the CLI
emits them and derived from a local, editable price table otherwise; tokens are the
ground truth, dollars a projection. The optimized unit is cost-per-verified-outcome,
not cost-per-token, because a model that is cheap per token but loops five times to
pass is expensive per outcome. The first version measures, attributes, and surfaces
that number per provider and task class; letting it automatically steer routing is
deferred until the data exists to justify a policy.

## Human interaction

Relay is operated, not chatted with. The human's involvement is concentrated at
two points — defining the outcome up front, and resolving the few decisions only a
human can make — and is otherwise read-only.

**Intake compiles the seed.** A run begins with a bounded conversational intake: a
compiler that grills the human just enough to produce a run seed — an outcome spec,
the verification grounding that says how "done" is checked, and a non-binding
sketch of an approach. The sketch is genuinely non-binding; the orchestrator is
free to decompose differently. Intake runs once, before the tree exists, and ends
by committing a childless `.relay/` root. The conversation is over before the loop
starts: once the seed is committed, the human supervises rather than steers.

**Supervision is state-only.** The operator watches the run through a read-only web
view served over loopback — a projection of `.relay/` plus the decision inbox,
never a control surface. It renders the live tree and drills into a per-node
supervisor detail: that node's self-report, diff, verdict, footprints and seams,
and the decompose rationale. It deliberately does not surface full executor
transcripts or model thinking. Supervision means seeing the truth in the record,
not reaching into the loop.

**The decision inbox is the one inbound channel.** Anything that genuinely needs a
human — an irreversible or ambiguous gate, a baseline re-versioning — is surfaced
into a human-owned decision inbox. Orchestrators only read and drain it; they never
author into it, never auto-resolve a correctable case, and never silently swallow
one. Each orchestrator drains its region's inbox at the start of every activation,
applying decisions as ordinary atomic transitions. Cancellation is the lone
exception to drain-on-activation: it does not wait for the next activation but
preempts immediately through the failure rule, because a doomed run should stop
dispatching work now, not later.

**Two entry points.** `relay run` is the real entry: it runs intake (or compiles a
grounded seed from a one-shot outcome flag with no human turns), commits a childless
root, lets the orchestrator decompose and execute it, and applies the verified
result back as a `relay/<runId>` branch. `relay dev-run` is the hermetic harness
for development and evaluation: it hand-seeds a single-leaf root with no intake and
no decomposition, drives the same real orchestrator against a local store, and
applies nothing back. Same loop, same gates; the difference is only how the root is
seeded and whether the result lands.

## Deferred

Relay takes a position on each of the following but has not built its full edges
yet. Each waits on evidence from real runs rather than a calendar date.

- **Isolated and remote runner tiers (tier-B and tier-C).** The first version ships
  the single shared local-host runner, tier-A, and instruments one metric: how much
  of a run's wall-clock is lost to visual-verification leaves waiting on that one
  shared session. When that wait-fraction crosses a threshold on real runs, tier-B —
  isolated parallel sessions — is built to restore the siblings' disjointness, and
  tier-C, a remote fleet, is a further step on the same metric at scale. Automatic
  tier selection waits until more than one tier exists.
- **Cross-subtree and cross-run learning.** Learning today stays local, with
  parent-mediated lateral propagation to not-yet-dispatched siblings. Cousin-to-
  cousin and cross-run propagation wait for a real tree to show that
  local-plus-lateral loses value; the vehicle would be a later knowledge base
  carrying its own staleness and trust model.
- **Closed-loop cost routing.** The first version measures and surfaces
  cost-per-verified-outcome. Letting that history automatically steer provider and
  model routing waits until the data exists to justify a policy.
- **Growth of the seam vocabulary.** The starter seam kinds — interface, http,
  file-boundary, data-schema — are extensible. Which further kinds real
  multi-codebase seams demand is learned from use, not pre-enumerated.
- **A SQLite read index.** Durable state stays files-only Markdown. If large-tree
  reads prove slow, the deferred answer is a derived read-index over the files,
  built only then, and even then framed as a clean either-or against migrating the
  record — with neither pre-built.
- **An OS-level Bash sandbox.** On the Claude path, the file-edit scope does not
  cover `Bash`, so a shell command can still write outside the worktree, while the
  Codex OS sandbox already confines subprocesses. True subprocess confinement on the
  Claude path is the named, deferred gap.
- **Fuller transcript capture.** The supervisor view surfaces self-report, diff,
  verdict, footprints, seams, and the decompose rationale, but not full executor
  transcripts or model thinking. Capturing those is deferred behind a stronger
  narrative-exclusion test that proves the richer record still never reaches the
  critic.
