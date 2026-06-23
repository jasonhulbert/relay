// The branch-level integration gate — concurrency pays for it. Because parallel
// siblings each fork from the same pre-layer base and never see one another, NO
// per-child critic can witness their combination: a child's critic graded its
// diff in isolation, blind to its sibling. So a branch that
// ran ANY children concurrently must, before it may be `done`, MERGE the completed
// layer and verify the merged whole — recovering the cross-sibling verification that
// serial execution got for free.
//
// The gate verifies composition in three DETERMINISTIC-FIRST layers, each a
// stricter, more expensive catch than the last, and stops at the first failure so the
// cheap deterministic checks gate the model call:
//
//   1. footprint from the WAL (the loud-violation catch) — code. Over the children's
//      ACTUAL writes (the intent-journal footprint, not the declared hint): each
//      child stayed within its declared footprint, AND no two children wrote a common
//      concrete path. A cross-sibling write clash is exactly what a per-child dispatch
//      check — each child blind to its siblings — cannot see, so the merged WAL is
//      where it surfaces.
//   2. each declared kind's seam predicate (code answers, not a model). file-boundary
//      reuses the footprint disjointness; interface does the syntactic AST lookup over
//      the producer's source read from the merged tree (`InterfacePayload.module`).
//      Only `seamIsCheckable` kinds run — a deferred kind already forced serialization
//      upstream, so a concurrent layer should carry none.
//   3. the parent re-running its OWN evidence-only critic on the merged whole against
//      its OWN spec (the silent-violation catch — two diffs that merge cleanly but are
//      semantically incompatible, and anything a predicate cannot express).
//
// A failure at any layer is self-sufficient (named layer + reason) and never silently
// swallowed: the gate returns it so the orchestrator surfaces a concurrent
// layer that could not be composed, rather than marking it `done`.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCritic, toCriticView } from '../relay-state/index';
import type {
  CriticCallUsage,
  CriticSpawn,
  CriticVerdict,
  LayerManifest,
  McpServerConfig,
  NodeRecord,
} from '../relay-state/index';
import { footprintEscapes } from './footprint';
import { checkFileBoundary, checkInterface } from './seam';

// The deterministic-first layer a gate verdict came from: the layer that FAILED
// (`ok: false`), or `critic` when all three passed (the last and strictest layer).
export type GateLayer = 'footprint' | 'seam' | 'critic';

// The gate's verdict on a merged concurrent layer. Self-sufficient: `layer` says how
// far the deterministic-first sequence got and `reason` says why it stopped, so a
// reader (or the blocked record the orchestrator authors from it) needs nothing else.
export interface GateResult {
  ok: boolean;
  layer: GateLayer;
  reason: string;
  // The critic verdict, present only when the gate reached and ran the critic layer.
  verdict?: CriticVerdict;
}

export interface GateInput {
  // The branch node whose concurrent layer is being integrated — its spec is what the
  // critic layer re-grades, and `toCriticView` reads its critic-admissible fields.
  parentNode: NodeRecord;
  // The merged layer's combined produced change, handed to the critic as its evidence.
  mergedDiff: string;
  // The merged worktree the critic runs its declared verifications against, and the
  // tree the interface-seam predicate reads the producer module's source from.
  mergedWorktree: string;
  // The layer manifest (declared footprints + the seam graph). `null` for a hand-
  // seeded branch with no manifest — then there is nothing concurrent to gate, but the
  // caller only invokes the gate for a concurrent layer, which always has a manifest.
  layer: LayerManifest | null;
  // Each child's ACTUAL repo-relative writes (the WAL footprint), by child node-id. A
  // child that reported none (the hermetic stub path) maps to an empty list.
  childWrites: Record<string, readonly string[]>;
  // The parent's own critic (the same spawn the loop uses), and the context it is
  // granted — the merged worktree plus the granted MCP servers.
  critic: CriticSpawn;
  mcpServers: readonly McpServerConfig[];
  // Per-call usage sink for the gate's critic call, attributed by the caller to the parent.
  onUsage?: (usage: CriticCallUsage) => void;
}

// Layer 1 — footprint from the WAL (the loud-violation catch, gate scope). Returns a
// failure reason, or null if the merged writes compose cleanly. Two ways to fail:
//   - escape: a child's actual writes left its declared footprint. (A per-child
//     dispatch check already catches this in-flight; re-checked here so the merged
//     WAL is authoritative even for a child whose footprint went unchecked at
//     dispatch — e.g. it reported no writes until merge.)
//   - clash: two children wrote a common concrete path. This is the genuinely cross-
//     sibling violation no per-child critic or dispatch check can see, since each
//     sibling is blind to the others.
function checkFootprints(
  layer: LayerManifest,
  childWrites: Record<string, readonly string[]>,
): string | null {
  // Escape: each child's actual writes must stay within its declared footprint.
  for (const [childId, writes] of Object.entries(childWrites)) {
    const declared = layer.footprints[childId];
    if (declared === undefined) continue;
    const escapes = footprintEscapes(declared, writes);
    if (escapes.length > 0) {
      return `footprint escape: \`${childId}\` wrote outside its declared footprint: ${escapes.join(', ')}`;
    }
  }
  // Clash: no concrete path may be written by two children (the merged WAL must be a
  // disjoint union). First writer of a path owns it; a second writer is the clash.
  const owner = new Map<string, string>();
  for (const [childId, writes] of Object.entries(childWrites)) {
    for (const path of writes) {
      const prior = owner.get(path);
      if (prior !== undefined && prior !== childId) {
        return `footprint clash: \`${prior}\` and \`${childId}\` both wrote \`${path}\``;
      }
      owner.set(path, childId);
    }
  }
  return null;
}

// Layer 2 — each declared kind's seam predicate (code answers). Returns the
// first failing seam's reason, or null if every checkable seam holds. An interface
// seam needs the producer module's source from the merged tree; a seam that names no
// module, or whose module cannot be read, fails loud (the gate cannot verify what it
// cannot locate — never silently passed).
async function checkSeams(layer: LayerManifest, mergedWorktree: string): Promise<string | null> {
  for (const seam of layer.seams) {
    // The `kind` switch both selects the predicate and narrows the typed payload. A
    // deferred (uncheckable) kind — `http`/`data-schema` — forced serialization
    // upstream (`seamIsCheckable`), so it should never reach a concurrent layer's
    // gate; the default arm skips it defensively rather than assert a missing predicate.
    if (seam.kind === 'file-boundary') {
      const r = checkFileBoundary(seam.payload);
      if (!r.ok) return `seam \`${seam.id}\` (file-boundary): ${r.reason}`;
    } else if (seam.kind === 'interface') {
      // The predicate is pure over the producer module's text; the gate supplies that
      // text from the merged tree (the producer's writes are merged in).
      const module = seam.payload.module;
      if (module === undefined) {
        return `seam \`${seam.id}\` (interface): no producer module declared to verify \`${seam.payload.symbol}\` against`;
      }
      let source: string;
      try {
        source = await readFile(join(mergedWorktree, module), 'utf8');
      } catch {
        return `seam \`${seam.id}\` (interface): producer module \`${module}\` not found in the merged tree`;
      }
      const r = checkInterface(seam.payload, source);
      if (!r.ok) return `seam \`${seam.id}\` (interface): ${r.reason}`;
    }
  }
  return null;
}

// Run the integration gate on a merged concurrent layer. Deterministic-first and
// short-circuiting: footprint (code), then seam predicates (code), then the parent's
// own critic (model) — the cheap checks gate the metered model call. The first
// failure is returned with its layer; if all three pass the result carries the critic
// verdict that certifies the merged whole.
export async function runIntegrationGate(input: GateInput): Promise<GateResult> {
  const {
    layer,
    childWrites,
    mergedWorktree,
    parentNode,
    mergedDiff,
    critic,
    mcpServers,
    onUsage,
  } = input;
  // No manifest ⇒ nothing was scheduled concurrently (a hand-seeded branch), so there
  // is nothing to integrate; the caller only reaches here for a concurrent layer, but
  // treat the absent manifest as a vacuous pass rather than throwing.
  if (layer === null) {
    return { ok: true, layer: 'footprint', reason: 'no layer manifest — nothing to integrate' };
  }

  // Layer 1: footprint from the WAL.
  const footprintFail = checkFootprints(layer, childWrites);
  if (footprintFail !== null) {
    return { ok: false, layer: 'footprint', reason: footprintFail };
  }

  // Layer 2: per-kind seam predicates.
  const seamFail = await checkSeams(layer, mergedWorktree);
  if (seamFail !== null) {
    return { ok: false, layer: 'seam', reason: seamFail };
  }

  // Layer 3: the parent re-runs its own evidence-only critic on the merged whole. The
  // evidence-only chokepoint still holds — the critic sees only the constructed
  // projection (the parent's spec + the merged diff + evidence), never any child's
  // self-report.
  const view = toCriticView(parentNode, mergedDiff);
  // Build the context without an explicit `undefined` onUsage (exactOptionalPropertyTypes).
  const ctx = onUsage
    ? { worktree: mergedWorktree, mcpServers, onUsage }
    : { worktree: mergedWorktree, mcpServers };
  const verdict = await runCritic(critic, view, ctx);
  if (!verdict.pass) {
    return {
      ok: false,
      layer: 'critic',
      reason: `integration critic rejected the merged layer: ${verdict.rationale}`,
      verdict,
    };
  }
  return {
    ok: true,
    layer: 'critic',
    reason: `integration critic certified the merged layer: ${verdict.rationale}`,
    verdict,
  };
}
