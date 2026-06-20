import { describe, expect, test } from 'vitest';
import { claudeMcpArgs, codexMcpArgs } from './index';
import type { McpServerConfig } from '../relay-state/index';

// WHY: the spine (MCP host) routes the granted server fleet into each agent's CLI
// config. The two providers differ in HOW a grant is wired — Claude takes one
// `--mcp-config` JSON document, Codex takes per-server `-c mcp_servers.*` TOML
// overrides — so the single chokepoint must produce each provider's exact shape,
// and an empty grant must add no flags at all (so unchanged stub paths stay byte-
// identical).
describe('claudeMcpArgs', () => {
  test('an empty grant contributes no flags', () => {
    expect(claudeMcpArgs([])).toEqual([]);
  });

  test('routes the fleet into one --mcp-config JSON document with strict mode', () => {
    const servers: McpServerConfig[] = [
      { name: 'probe', command: 'srv', args: ['--flag'] },
      { name: 'surface', command: 'play' },
    ];
    const args = claudeMcpArgs(servers);
    expect(args[0]).toBe('--mcp-config');
    expect(args[2]).toBe('--strict-mcp-config');
    const doc = JSON.parse(args[1]) as { mcpServers: Record<string, unknown> };
    expect(doc.mcpServers).toEqual({
      probe: { command: 'srv', args: ['--flag'] },
      // A server with no args is normalized to an empty list.
      surface: { command: 'play', args: [] },
    });
  });
});

describe('codexMcpArgs', () => {
  test('an empty grant contributes no flags', () => {
    expect(codexMcpArgs([])).toEqual([]);
  });

  test('routes each server into `-c mcp_servers.*` TOML overrides', () => {
    const args = codexMcpArgs([{ name: 'probe', command: 'srv', args: ['--flag'] }]);
    // Each override is a `-c` flag followed by the dotted key=value (TOML-parsed).
    expect(args).toEqual([
      '-c',
      'mcp_servers.probe.command="srv"',
      '-c',
      'mcp_servers.probe.args=["--flag"]',
    ]);
  });

  test('normalizes a server with no args to an empty TOML array', () => {
    const args = codexMcpArgs([{ name: 'surface', command: 'play' }]);
    expect(args).toContain('mcp_servers.surface.args=[]');
  });
});
