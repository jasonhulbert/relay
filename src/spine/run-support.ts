// Shared run scaffolding for the two real-run entry points (M4 dev-run harness and
// the M6 `relay run` command). Both resolve a project store, drive the SAME
// orchestrator, and print the SAME operator recap; only their seeding differs
// (dev-run hand-seeds a single leaf; `relay run` compiles + commits an intake seed).
// To keep the two command bodies distinct (the hermetic harness must not couple to
// the real entry point) while guaranteeing identical provider construction and an
// identical recap, only the genuinely generic pieces live here: the per-role provider
// executor builder and the store-reading recap renderer. The orchestration flow and
// option wiring stay written out in each command.
import { readdir } from 'node:fs/promises';
import { relayPaths, readNode } from '../relay-state/index';
import type { CallUsage } from '../relay-state/index';
import type { Executor } from './executor';
import { claudeExecutor } from './adapters/claude';
import type { ClaudeAdapterOptions } from './adapters/claude';
import { codexExecutor } from './adapters/codex';
import type { CodexAdapterOptions } from './adapters/codex';
import type { OrchestratorResult } from './orchestrator';

export type Provider = 'claude' | 'codex';

// Build a real provider executor at its cheapest default, with an optional
// per-role model override (the cost-guardrail knob). Both adapters expose the
// same `{ model }` option shape, so provider selection is a single switch.
export function buildProviderExecutor(provider: Provider, model?: string): Executor {
  if (provider === 'claude') {
    const claudeOpts: ClaudeAdapterOptions = {};
    if (model !== undefined) claudeOpts.model = model;
    return claudeExecutor(claudeOpts);
  }
  const codexOpts: CodexAdapterOptions = {};
  if (model !== undefined) codexOpts.model = model;
  return codexExecutor(codexOpts);
}

function formatUsd(cost: number | null): string {
  return cost === null ? 'n/a (unpriced)' : `$${cost.toFixed(6)}`;
}

// Render the apply-back section of the recap (workspace-substrate §6). On the
// success path it names the reviewable `relay/<runId>` branch and the exact commands
// to review and merge it (the operator's working tree was never touched). On the
// fail-loud path (dirty / non-git workspace, or a patch that did not apply) it prints
// the reason, the persisted `result.patch` path, and the manual `git apply` step — so
// the verified work is never lost, just surfaced for the human instead of auto-landed.
// `none` (the hermetic/empty path, or a non-done run) adds nothing.
function applyBackLines(projectPath: string, applyBack: OrchestratorResult['applyBack']): string[] {
  if (applyBack.kind === 'none') return [];
  if (applyBack.kind === 'branch') {
    return [
      '',
      'apply-back (workspace-substrate §6):',
      `  branch: ${applyBack.branch}   (operator repo; working tree untouched)`,
      `  review: git -C ${projectPath} diff ${applyBack.base}..${applyBack.branch}`,
      `  merge:  git -C ${projectPath} merge ${applyBack.branch}`,
      `  patch:  ${applyBack.patchPath}`,
    ];
  }
  return [
    '',
    `apply-back: NOT APPLIED (${applyBack.reason}) — verified result delivered as a patch:`,
    `  reason: ${applyBack.notice}`,
    `  patch:  ${applyBack.patchPath}`,
    `  apply manually (review first): git -C ${projectPath} apply ${applyBack.patchPath}`,
  ];
}

// Render the operator recap: where the store is, every node's status, the run's
// evidence files, the per-call usage/cost, and any blocked record. Built by
// reading the store back so it reflects what was actually persisted, not the
// in-memory result alone.
export async function renderRecap(
  storeDir: string,
  projectPath: string,
  key: string,
  runId: string,
  result: OrchestratorResult,
  usages: readonly CallUsage[],
): Promise<string> {
  const paths = relayPaths(storeDir);
  const lines: string[] = [
    '=== relay run recap ===',
    `store (.relay/): ${storeDir}   [git log-able]`,
    `project: ${projectPath}   key=${key}`,
    `run: ${runId}   root status: ${result.rootStatus}`,
    '',
    'node statuses (read: nodes/<id>.md):',
  ];

  const nodeFiles = (await readdir(paths.nodesDir)).filter((f) => f.endsWith('.md')).sort();
  for (const file of nodeFiles) {
    const id = file.slice(0, -3);
    const node = await readNode(storeDir, id);
    lines.push(`  ${id} [${node.kind}] -> ${node.status}`);
    if (node.verdict) {
      // The independent critic's verdict (design §3.6): who graded it (a different
      // provider than the author by default) and the result it certified.
      lines.push(`    critic [${node.verdict.provider}] -> ${node.verdict.pass ? 'PASS' : 'FAIL'}`);
    }
    if (node.blocked) {
      lines.push(`    blocked: ${node.blocked.humanFacing}`);
    }
  }

  lines.push('', `evidence (evidence/${runId}/):`);
  try {
    const evRoot = paths.evidenceDir(runId);
    const groups = (await readdir(evRoot, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const g of groups) {
      if (!g.isDirectory()) {
        lines.push(`  ${g.name}`);
        continue;
      }
      const files = (await readdir(`${evRoot}/${g.name}`)).sort();
      for (const f of files) {
        lines.push(`  ${g.name}/${f}`);
      }
    }
  } catch {
    lines.push('  (none persisted this run)');
  }

  lines.push(...applyBackLines(projectPath, result.applyBack));

  lines.push('', 'per-call usage (node-attributed; F5):');
  if (usages.length === 0) {
    lines.push('  (no model calls)');
  }
  let runTotal = 0;
  let uncosted = 0;
  for (const u of usages) {
    if (u.costUsd === null) uncosted += 1;
    else runTotal += u.costUsd;
    lines.push(
      `  ${u.nodeId} [${u.role} #${u.seq.toString()}] provider=${u.provider} ` +
        `model=${u.model ?? 'unknown'} ` +
        `in=${u.inputTokens.toString()} cached=${u.cachedInputTokens.toString()} ` +
        `out=${u.outputTokens.toString()} wall=${u.wallClockMs.toString()}ms ` +
        `cost=${formatUsd(u.costUsd)} (${u.costSource})`,
    );
  }
  if (usages.length > 0) {
    lines.push(
      `  run total: ${formatUsd(runTotal)}` +
        (uncosted > 0 ? `  (+${uncosted.toString()} uncosted)` : ''),
      `  rollup: ${paths.costRollup(runId)}`,
    );
  }

  lines.push('', `read first: ${paths.nodesDir} and ${paths.evidenceDir(runId)}`);
  return lines.join('\n');
}
