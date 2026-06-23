// Root commit: turn the approved intake seed into the `.relay/` root the orchestrator
// activates from. Approval is the commit point — `runIntake` returns at the
// interviewer's `done` turn having run nothing, and this performs the atomic
// intent-journal transaction that writes the durable root: the manifest (outcome spec
// + grounded verifications + the non-binding sketch) and the root branch node.
//
// Intake stays execution-free: this writes `.relay/` files and STOPS. It dispatches
// no executor and runs no loop — activation is the orchestrator's job, which reads
// this root and decomposes it. Crucially, NO binding decomposition is written here:
// the root is a CHILDLESS BRANCH, so the brain owns the first layer at activation,
// decomposing one lazy layer at a time. The sketch rides in the manifest as
// non-binding orientation; its `Sketch` shape (`{ notes }`) cannot encode
// children/footprints/seams, so "no binding decomposition beyond the sketch" is
// structural here, not merely asserted.
import {
  commit,
  relativeManifestPath,
  relativeNodePath,
  serializeManifest,
  serializeNode,
} from '../relay-state/index';
import type { IntentWrite, NodeRecord, RootManifest } from '../relay-state/index';
import type { IntakeSeed } from './seed';

export interface CommitRootOptions {
  // The run id and root node-id the committed root carries. Default to the stable
  // single-run values so a dev harness need not invent them; a real multi-run store
  // passes unique ids.
  runId?: string;
  rootId?: string;
  // ISO-8601 creation timestamp; defaults to now. Injectable so a test commit is
  // byte-deterministic (mirrors `seedFixture`'s fixed timestamp).
  createdAt?: string;
}

export interface RootCommitResult {
  runId: string;
  rootId: string;
}

// Commit the approved seed as the `.relay/` root in one atomic transaction. The
// manifest and the root node land all-or-nothing through the intent journal: a crash
// after the journal's commit point leaves a pending intent that the activating
// orchestrator rolls forward (its journal region is the root id — the same region
// `runOrchestrator` rolls forward at the start of a run), so rehydration never sees a
// manifest without its root node or vice versa. This is why the root commit goes
// through the journal where `seedFixture` (a test scaffold with nothing to be atomic
// against) uses the plain writers: the real entry path's root must be an atomic,
// crash-recoverable transaction. Returns the ids so the caller can activate the
// orchestrator immediately.
export async function commitRoot(
  relayDir: string,
  seed: IntakeSeed,
  opts: CommitRootOptions = {},
): Promise<RootCommitResult> {
  const runId = opts.runId ?? 'run-1';
  const rootId = opts.rootId ?? 'root';
  const createdAt = opts.createdAt ?? new Date().toISOString();

  const manifest: RootManifest = {
    runId,
    rootId,
    spec: seed.spec,
    sketch: seed.sketch,
    createdAt,
  };
  // The root is a childless branch: an orchestrator binds only to a branch it owns as
  // sole writer, and decomposes it lazily at activation. Committing no children — and
  // no layer manifest — is what keeps intake from smuggling a binding plan into the
  // root.
  const root: NodeRecord = {
    id: rootId,
    parentId: null,
    kind: 'branch',
    status: 'pending',
    spec: seed.spec,
    children: [],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };

  // Region = the root id: the ownership-partitioned region the activating orchestrator
  // rolls forward, so an interrupted root commit is recovered the moment the run begins.
  const writes: IntentWrite[] = [
    { path: relativeManifestPath, content: serializeManifest(manifest) },
    { path: relativeNodePath(rootId), content: serializeNode(root) },
  ];
  await commit(relayDir, rootId, writes);

  return { runId, rootId };
}
