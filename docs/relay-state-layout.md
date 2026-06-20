# `.relay/` on-disk layout (M0 conventions)

`.relay/` is Relay's system of record: durable, human-readable, git-trackable
plain Markdown, with the orchestrators as stateless views over it. The record is
**files-only Markdown** (design doc v1.0 §4, decision v0.8) — chosen for
inspectability, not efficiency, so a human can `git log` the tree, diff two
critic verdicts, and read a `blocked` node by eye. SQLite was weighed and
rejected as the record because a single database is a shared write target that
collides with the no-shared-write-target process model (C6).

This document fixes the M0 working conventions. Exact front-matter field schemas
are pinned by the walking skeleton (M1) and later milestones; design §4 and §9.3
are authoritative where this doc is silent.

## On-disk shape

```
.relay/
  manifest.md            # root manifest
  nodes/<node-id>.md     # one file per node (root -> branches -> leaves)
  contracts/<node-id>.md # verified outcome contract a sub-orchestrator hands up (A7)
  evidence/<run-id>/     # run-scoped evidence store (refs only live in nodes)
    <node-id>/usage/     # raw per-call cost records, attributed to the node (F5)
    cost.md              # per-run cost rollup, composed from the usage records (F5)
  inbox/                 # human-owned decision inbox
  journal/<region>/      # per-region write-ahead intent journal (C8)
```

## The load-bearing elements

### Root manifest — `.relay/manifest.md`

Markdown plus front-matter describing the tree shape (root → branches → leaves),
the root spec, and run-level rollups (e.g. cost-per-outcome, design §8). It is
read-and-rewritten only within the owning region's transactions. Genuinely
global views — the run log, any cross-tree render — are **not** stored here as a
shared write target; they are read-time projections composed from per-node
records (design §4).

### Node file — `.relay/nodes/<node-id>.md`

One file per node, Markdown plus front-matter. Holds the node's spec,
self-report/learnings, child manifest for the one layer it decomposed, critic
verdicts, and **evidence refs** — never inline transcripts or screenshots.
Ownership is partitioned: each orchestrator is the **sole writer of its own
subtree region** (its node file plus that child manifest), so concurrent
sub-orchestrators write disjoint files with no locks and no write races. The
only cross-region write is a parent recording a child's returned verdict into
the parent's own region, funnelled and serial within that parent (design §4).

A `blocked` node carries its self-sufficient exhaustion summary (§3.7).
Quarantined drained work is retained for resume but flagged un-integrated
(§3.9).

### Outcome contract — `.relay/contracts/<node-id>.md`

A sub-orchestrator hands its result up to its parent as a **verified outcome
contract**, not a diff (A7, design §3.8, §9.2). Across an orchestrator-process
boundary there is no single merged artifact to run a critic over, so the child
commits this record into its own region: the outcome it claims, the structural
`.relay/` fact that its own critic gate certified it (read from the ledger, never
its narrative), and the seam evidence the parent needs to verify composition
(placeholder until the typed seam union, F3). It is written in the **same atomic
transaction** as the child's `done` transition, so the parent never observes a
`done` child without its contract. The parent reads it from the ledger to decide
acceptance — never from the child's stdout or return value — and never re-verifies
the child's internals.

### Evidence store — `.relay/evidence/<run-id>/`

The run-scoped store for transcripts, screenshots, and raw per-call cost
records. Nodes hold only **refs** into this store, keeping `.relay/` compact and
the evidence prunable by the evidence compactor (D2). Per-call usage records
(F5, design §8) live at `evidence/<run-id>/<node-id>/usage/<role>-<seq>.md`,
one per model call (executor / critic / brain), each carrying the call's tokens
and resolved dollar cost — direct from the provider (Claude `total_cost_usd`) or
derived from the local price table (Codex). The per-run rollup `cost.md` is a
read-time projection composed from those records by the top-level run; it is the
operator's cost-per-outcome view and is not a shared write target. Visual
baselines are the
exception: they live in a separate durable content-addressed store excluded from
the compactor, with only the ref (hash, outcome-id, granularity, version,
tolerance) recorded in `.relay/` so binaries never enter files-only state
(design §7.5, F2).

### Decision inbox — `.relay/inbox/`

A **human-owned** region for decisions surfaced to the operator (irreversible or
ambiguous gates, baseline re-versioning). The orchestrators only **read and
drain** it; they never author into it. Pending inbox items survive process
teardown and are drained by the replacement orchestrator on rehydration (design
§3.11, §4).

## The intent journal (C8)

Structural mutations — promotion, done/blocked transitions, the failure rule's
cancellations, applying a drained human decision — are atomic across the several
files they touch, via a **per-region write-ahead intent journal**:

1. Write one **intent file** holding the complete post-state for every file the
   transaction touches, and fsync it. This fsync is the **commit point**.
2. Apply the named writes.
3. Remove the intent file.

A rehydrating orchestrator that finds an intent **rolls it forward idempotently**
before doing anything else — the intent carries full target contents, so
re-applying is safe — then removes it. The intent journal is **per-region** so a
rehydrating orchestrator bound to a node-id finds exactly its region's pending
intent under `journal/<region>/`. The filesystem gives one atomic primitive
(single-file rename); the journal lifts it to all-or-nothing across the files a
transition touches (design §9.3).

This upholds the **rehydration contract** (§3.2): any instant of `.relay/` is
coherent enough to reconstitute the responsible orchestrator; a non-`done` child
at rehydration is discarded and re-dispatched.

## Field-partitioned projections (C7)

The records carry two audiences: orchestrator-visible (self-report + learnings)
and critic-visible (spec + diff + evidence only). The split is enforced at a
runtime chokepoint — one constructor for the critic view, a critic-spawn path
that accepts only that view, a branded type, and a property test — not by
prompting (design §4, §9.3). Readers of node files must go through that
chokepoint when composing a critic view; they must never hand a raw node record
to a critic.

## macOS durability caveat

Node's `fsync` issues `fsync`, not `F_FULLFSYNC`, so a synced file can still sit
in the drive's cache against a true power loss. This does not threaten the
disposability model, which is built for process kills and crashes where write
ordering plus intent roll-forward suffice. Power-loss durability would be an
explicit native `F_FULLFSYNC` call later, not a default (design §4).
