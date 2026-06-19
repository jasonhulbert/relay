import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { arbNodeRecord } from './arbitraries';
import { runCritic, toCriticView } from './projection';
import type { CriticContext, CriticSpawn, CriticView } from './projection';
import type { CriticVerdict, NodeRecord } from './types';

// The non-evidentiary context every critic-spawn is granted alongside the view;
// nothing in it is graded, so it cannot reopen the C7 leak.
const CTX: CriticContext = { worktree: '/tmp/wt', mcpServers: [] };

// Field names that carry the orchestrator-visible narrative. None may appear in
// the critic-visible projection (design §3.6, §4).
const NARRATIVE_KEYS = ['selfReport', 'learnings', 'narrative', 'self_report'];

describe('critic-visible projection (C7)', () => {
  // WHY: the critic's verdict is only trustworthy if it never sees the executor's
  // self-report. The chokepoint must build a view that *structurally* omits the
  // narrative — so this test fails the instant a narrative field is added to the
  // projection (the key set is pinned to exactly the admissible fields).
  test('carries only spec + diff + evidence, never a narrative field', () => {
    fc.assert(
      fc.property(arbNodeRecord, fc.string(), (node, diff) => {
        const view = toCriticView(node, diff);
        const keys = Object.keys(view);
        // Pinning the key set to exactly the admissible fields means adding any
        // narrative field to the projection breaks this test.
        expect(new Set(keys)).toEqual(new Set(['spec', 'diff', 'evidenceRefs']));
        for (const banned of NARRATIVE_KEYS) {
          expect(keys).not.toContain(banned);
        }
        // The admissible evidence is faithfully carried through.
        expect(view.spec).toEqual(node.spec);
        expect(view.diff).toBe(diff);
        expect(view.evidenceRefs).toEqual(node.evidenceRefs);
      }),
    );
  });

  test('omits the narrative even when the node has a rich self-report and learnings', () => {
    const node: NodeRecord = {
      id: 'leaf-1',
      parentId: 'root',
      kind: 'leaf',
      status: 'active',
      spec: {
        outcome: 'feature X works',
        verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
      },
      children: [],
      selfReport: 'I confidently did everything correctly, trust me.',
      learnings: ['watch out for the edge case'],
      verdict: null,
      evidenceRefs: [{ runId: 'r1', path: 'diff.patch', kind: 'diff', summary: 'the change' }],
      blocked: null,
    };
    const serialized = JSON.stringify(toCriticView(node, 'the diff'));
    expect(serialized).not.toContain('confidently');
    expect(serialized).not.toContain('edge case');
    expect(serialized).toContain('the diff');
  });
});

// Type-level guard, enforced by `npm run typecheck` (vitest strips types, so the
// directives below are checked by tsc, not at runtime). If the critic-spawn path
// is ever loosened to accept a raw record — or the brand removed so a plain
// object forges a view — the `@ts-expect-error` directives become unused and
// `tsc` fails. This is the falsifiable type-level test the phase requires.
describe('critic-spawn path admits only a constructed CriticView', () => {
  test('rejects a raw node record and an unbranded look-alike at the type level', () => {
    const spawn: CriticSpawn = () =>
      Promise.resolve<CriticVerdict>({
        pass: true,
        provider: 'stub',
        rationale: 'ok',
        evidenceRefs: [],
      });
    const node: NodeRecord = {
      id: 'n',
      parentId: null,
      kind: 'leaf',
      status: 'pending',
      spec: { outcome: 'o', verifications: [{ kind: 'command', grounding: 'g', check: 'true' }] },
      children: [],
      selfReport: 'secret narrative',
      learnings: [],
      verdict: null,
      evidenceRefs: [],
      blocked: null,
    };

    // @ts-expect-error — a raw NodeRecord is not a CriticView (no diff, no brand).
    void runCritic(spawn, node, CTX);

    // A structurally-similar object still lacks the brand: only toCriticView mints one.
    const lookAlike = { spec: node.spec, diff: 'd', evidenceRefs: node.evidenceRefs };
    // @ts-expect-error — an unbranded look-alike cannot reach the critic-spawn path.
    void runCritic(spawn, lookAlike, CTX);

    // The supported path: construct the projection first, then spawn.
    const view: CriticView = toCriticView(node, 'd');
    void runCritic(spawn, view, CTX);

    expect(typeof spawn).toBe('function');
  });
});
