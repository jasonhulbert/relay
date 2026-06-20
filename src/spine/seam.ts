// Seam predicates — F3 made code-checkable (design §3.8, A8, M10 Phase 2). A seam is
// the typed contract the parent authors between two children of one decomposed layer
// (A8); v0.1 ships two kinds whose match is decided by CODE, not a model (Rule 5):
//
//   - file-boundary: the two children write disjoint repo paths. The predicate
//     reuses the footprint glob matcher (`footprintsDisjoint`) — the same
//     disjointness that LICENSES their concurrency (A2) is what the seam asserts as
//     their contract.
//   - interface: the producer exports a named symbol/type, optionally matching a
//     declared signature. The predicate does a SYNTACTIC AST lookup over the
//     producer's source (`ts.createSourceFile` — no type-checker, no program), so it
//     is deterministic and hermetic (Rule 5).
//
// A seam kind with no v0.1 predicate (`http`, `data-schema`; design §13) is NOT
// checkable. F3's forcing function: an uncheckable seam between two siblings forces
// them to serialize — the scheduler reads `seamIsCheckable` (the A1 safe ground
// state), because a seam the parent cannot reduce to a code-checkable kind cannot
// gate a parallel merge. The integration gate (Phase 3) RUNS these predicates against
// the merged tree; this module only provides them and the checkability gate.
import ts from 'typescript';
import type { FileBoundaryPayload, InterfacePayload, SeamKind } from '../relay-state/index';
import { footprintsDisjoint } from './footprint';

// Can this seam kind be verified by a v0.1 code predicate? Only the two kinds with
// predicates below; the deferred kinds are not. This is the A2 condition-2 / F3 gate
// the scheduler reads to decide parallel-vs-serial.
export function seamIsCheckable(kind: SeamKind): boolean {
  return kind === 'file-boundary' || kind === 'interface';
}

// The verdict of running a seam predicate: pass/fail plus a self-sufficient reason.
// The reason is never silently swallowed — the integration gate records it so a
// mismatch reads as a verifiable element of the layer's outcome (A8, Rule 11).
export interface SeamCheckResult {
  ok: boolean;
  reason: string;
}

// file-boundary (F3): the producer and consumer write disjoint repo paths. Reuses the
// footprint glob matcher so the seam's disjointness test is exactly the scheduler's.
// Pass ⇒ the two outputs cannot collide on a concrete file.
export function checkFileBoundary(payload: FileBoundaryPayload): SeamCheckResult {
  const disjoint = footprintsDisjoint(
    { writeGlobs: payload.producerGlobs },
    { writeGlobs: payload.consumerGlobs },
  );
  return disjoint
    ? { ok: true, reason: 'producer and consumer write disjoint paths' }
    : {
        ok: false,
        reason: `file-boundary seam overlaps: producer [${payload.producerGlobs.join(', ')}] and consumer [${payload.consumerGlobs.join(', ')}] can write a common path`,
      };
}

// interface (F3): the producer exports the named symbol, and — when the seam declares
// a signature — that symbol's declared signature matches. `source` is the producer
// module's text (the integration gate reads `payload.module` from the merged tree and
// hands it here; the predicate itself is pure over the text). Pass ⇒ the consumer's
// declared dependency is actually published.
export function checkInterface(payload: InterfacePayload, source: string): SeamCheckResult {
  const sig = exportedSignature(source, payload.symbol);
  if (sig === null) {
    return { ok: false, reason: `interface seam: producer does not export \`${payload.symbol}\`` };
  }
  if (payload.signature === undefined) {
    return { ok: true, reason: `producer exports \`${payload.symbol}\`` };
  }
  const actual = normalizeSignature(sig);
  const expected = normalizeSignature(payload.signature);
  return actual === expected
    ? { ok: true, reason: `\`${payload.symbol}\` matches the declared signature` }
    : {
        ok: false,
        reason: `interface seam: \`${payload.symbol}\` signature mismatch — expected \`${expected}\`, found \`${actual}\``,
      };
}

// The declared signature of an EXPORTED top-level `symbol` in `source`, or null if no
// exported declaration of that name exists. Syntactic only (no type resolution).
// Supported forms — the v0.1 subset, scoped and documented like the footprint glob
// matcher:
//   - function declarations                 → name, type params, params, return type
//                                              (the BODY is excluded — a seam pins the
//                                              contract, not the implementation)
//   - const/let/var with an arrow value     → up to the arrow body (params + return)
//   - const/let/var otherwise               → the full declaration (name + annotation)
//   - type alias / interface / class / enum → the full declaration
function exportedSignature(source: string, symbol: string): string | null {
  const sf = ts.createSourceFile('seam-producer.ts', source, ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (!isExported(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === symbol) {
      const end = stmt.body ? stmt.body.getStart(sf) : stmt.getEnd();
      return source.slice(stmt.getStart(sf), end);
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === symbol) {
          const init = decl.initializer;
          if (init && ts.isArrowFunction(init)) {
            return source.slice(stmt.getStart(sf), init.body.getStart(sf));
          }
          return decl.getText(sf);
        }
      }
    }
    if (
      (ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt)) &&
      stmt.name?.text === symbol
    ) {
      return stmt.getText(sf);
    }
  }
  return null;
}

function isExported(node: ts.Statement): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

// Normalize a signature for comparison: drop the `export` keyword, collapse runs of
// whitespace, strip whitespace around punctuation, and drop a trailing `;`/`{`. Both
// the producer's extracted signature and the seam's declared one pass through this, so
// the match is insensitive to formatting (`a: number` vs `a:number`) but exact on
// structure.
function normalizeSignature(s: string): string {
  return s
    .replace(/\bexport\b/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(){}<>,;:|&=]|=>)\s*/g, '$1')
    .replace(/[;{]+$/, '')
    .trim();
}
