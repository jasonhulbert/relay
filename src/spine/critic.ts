// The independent critic decides done-ness: a separate agent, different provider
// by default, that did not do the work. Its integrity rests on never seeing the
// executor's self-report — which the evidence-only projection (`CriticView`) has
// already withheld before the critic is reached. The critic grounds its verdict
// in the spec + diff + evidence alone.
//
// See docs/relay-spec.md for the architecture this implements.
//
// This STUB critic runs over the cheapest verification kind — `command` (exit 0):
// it runs the spec's declared command and passes iff it exits 0. This exercises
// the real critic-spawn path (it is typed `CriticSpawn`, so only a constructed
// `CriticView` reaches it) without a model; agent-critic model review lives in
// agent-critic.ts.
import { spawn } from 'node:child_process';
import type { CriticSpawn, CriticVerdict } from '../relay-state/index';

function runCommand(check: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', check], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

// A controllable critic for deterministic failure tests: it returns a scripted
// sequence of verdicts so a test can inject persistent failure (`['fail']`) or
// fail-then-succeed (`['fail', 'fail', 'pass']`) without a real provider. The last
// entry repeats once the script is exhausted, so a one-entry script is a constant.
// The command critic above is unchanged; the real agent-critic lives in
// agent-critic.ts.
export interface ScriptedCriticOptions {
  // Verdict per call, consumed in order; the final entry repeats thereafter.
  results: ('pass' | 'fail')[];
  provider?: string;
}

export function scriptedCritic(opts: ScriptedCriticOptions): CriticSpawn {
  if (opts.results.length === 0) {
    throw new Error('scriptedCritic requires at least one result');
  }
  const provider = opts.provider ?? 'stub-critic';
  let call = 0;
  // The scripted verdict ignores the projection; a zero-arg function still
  // satisfies `CriticSpawn`.
  return (): Promise<CriticVerdict> => {
    const result = opts.results[Math.min(call, opts.results.length - 1)];
    call += 1;
    return Promise.resolve({
      pass: result === 'pass',
      provider,
      rationale: `scripted critic returned ${result} (call ${call.toString()})`,
      evidenceRefs: [],
    });
  };
}

export const stubCritic: CriticSpawn = async (view): Promise<CriticVerdict> => {
  const command = view.spec.verifications.find((v) => v.kind === 'command');
  if (!command) {
    return {
      pass: false,
      provider: 'stub-critic',
      rationale: 'no command verification declared',
      evidenceRefs: [],
    };
  }
  const code = await runCommand(command.check);
  const pass = code === 0;
  return {
    pass,
    provider: 'stub-critic',
    rationale: `command \`${command.check}\` exited ${code.toString()}`,
    evidenceRefs: [],
  };
};
