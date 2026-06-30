import { describe, expect, test } from 'vitest';
import type { CriticSpawn } from '../relay-state/index';
import type { AgentCriticOptions } from './agent-critic';
import type { AgentBrainOptions, Brain } from './brain';
import { CHILD_ENTRY_BUNDLE, resolveChildEntry, runOptionsFromChildRuntime } from './child-runtime';
import type { ChildRuntimeConfig, Provider, Executor } from './index';

function fakeExecutor(provider: string, model: string | undefined): Executor {
  return {
    capabilities: () => ({
      provider: `${provider}:${model ?? 'default'}`,
      json: true,
      resume: false,
      sandbox: true,
      mcp: true,
    }),
    run: () => {
      throw new Error('not exercised');
    },
  };
}

describe('child runtime config', () => {
  test('RELAY_CHILD_ENTRY wins over the bundled artifact path', () => {
    expect(
      resolveChildEntry({
        env: { RELAY_CHILD_ENTRY: '/tmp/custom-child.cjs' },
        runningEntry: '/repo/dist/index.js',
      }),
    ).toBe('/tmp/custom-child.cjs');
  });

  test('defaults to the bundled child entry beside the running build', () => {
    expect(resolveChildEntry({ env: {}, runningEntry: '/repo/dist/index.js' })).toBe(
      `/repo/dist/${CHILD_ENTRY_BUNDLE}`,
    );
  });

  test('reconstructs production run options from serializable runtime config', () => {
    const executorCalls: Array<{ provider: Provider; model: string | undefined }> = [];
    const criticCalls: AgentCriticOptions[] = [];
    const brainCalls: AgentBrainOptions[] = [];
    const critic: CriticSpawn = () =>
      Promise.resolve({
        provider: 'codex',
        pass: true,
        rationale: 'ok',
        evidenceRefs: [],
      });
    const brain: Brain = {
      decompose: () => {
        throw new Error('not exercised');
      },
    };
    const config: ChildRuntimeConfig = {
      projectPath: '/repo',
      workRoot: '/repo/.relay-worktrees',
      provider: 'claude',
      executorModel: 'claude-sonnet-test',
      swapProvider: 'codex',
      swapModel: 'gpt-test',
      criticProvider: 'codex',
      criticModel: 'gpt-critic-test',
      brainProvider: 'claude',
      brainModel: 'claude-brain-test',
      mcpServers: [{ name: 'probe', command: 'srv', args: ['--flag'] }],
      childEntry: '/repo/dist/child-entry.cjs',
    };

    const opts = runOptionsFromChildRuntime(config, {
      executor(provider, model) {
        executorCalls.push({ provider, model });
        return fakeExecutor(provider, model);
      },
      critic(options) {
        criticCalls.push(options);
        return critic;
      },
      brain(options) {
        brainCalls.push(options);
        return brain;
      },
    });

    expect(executorCalls).toEqual([
      { provider: 'claude', model: 'claude-sonnet-test' },
      { provider: 'codex', model: 'gpt-test' },
    ]);
    expect(criticCalls).toEqual([{ provider: 'codex', model: 'gpt-critic-test' }]);
    expect(brainCalls).toEqual([{ provider: 'claude', model: 'claude-brain-test' }]);
    expect(opts.executor?.capabilities().provider).toBe('claude:claude-sonnet-test');
    expect(opts.swapExecutor?.capabilities().provider).toBe('codex:gpt-test');
    expect(opts.critic).toBe(critic);
    expect(opts.brain).toBe(brain);
    expect(opts.projectPath).toBe('/repo');
    expect(opts.workRoot).toBe('/repo/.relay-worktrees');
    expect(opts.mcpServers).toEqual([{ name: 'probe', command: 'srv', args: ['--flag'] }]);
    expect(opts.childEntry).toBe('/repo/dist/child-entry.cjs');
    expect(opts.childRuntime).toBe(config);
  });
});
