// The independent critic decides done-ness (design §3.6): a separate agent,
// different provider by default, that did not do the work. Its integrity rests
// on never seeing the executor's self-report — which the C7 projection
// (`CriticView`) has already withheld before the critic is reached. The critic
// grounds its verdict in the spec + diff + evidence alone.
//
// M1 ships a STUB critic over the cheapest verification kind — `command` (exit 0,
// design §6.3): it runs the spec's declared command and passes iff it exits 0.
// This exercises the real critic-spawn path (it is typed `CriticSpawn`, so only
// a constructed `CriticView` reaches it) without a model; agent-critic review is
// M4.
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
