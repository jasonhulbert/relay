// MCP as the universal capability bus. The spine is the MCP
// HOST: it authors first-party servers and is the lifecycle manager for the fleet
// — registering, launching, and ROUTING granted servers into the agents it spawns.
// The agents (executor, critic, and the orchestrator's own decompose/leaf-vs-branch
// judgment) are `claude -p` / `codex exec` CLIs that connect to those servers as
// MCP CLIENTS and use the granted tools freely. The code remains the sole writer of
// `.relay/` and the sole dispatcher of work: a model may drive tools inside the
// code-owned loop; no model owns the loop or the durable state.
//
// This module is the single chokepoint for the routing half of that role: it
// translates a granted `McpServerConfig[]` into each provider's CLI grant flags, so
// every agent adapter (executor, critic, brain) wires a grant the same way rather
// than each re-deriving the provider's flag syntax. Authoring concrete first-party
// servers (e.g. a Surface driver) is deferred until their specific tools are needed;
// this module only routes already-granted servers, it does not author them.
import type { McpServerConfig } from '../relay-state/index';

// Claude takes a single `--mcp-config <json>` document plus `--strict-mcp-config`
// (so only the granted servers are visible — no inherited user config). An empty
// grant contributes no flags.
export function claudeMcpArgs(servers: readonly McpServerConfig[]): string[] {
  if (servers.length === 0) return [];
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const s of servers) {
    mcpServers[s.name] = { command: s.command, args: s.args ?? [] };
  }
  return ['--mcp-config', JSON.stringify({ mcpServers }), '--strict-mcp-config'];
}

// Codex grants MCP through config, not a single CLI flag: `-c <key=value>` where the
// dotted key overrides a nested config value and the value is parsed as TOML. Each
// granted server becomes `[mcp_servers.<name>]` with a `command` (and `args`). JSON
// encoding of a string / string-array is valid TOML (a basic string / array), so we
// reuse `JSON.stringify` for the values. An empty grant contributes no flags.
export function codexMcpArgs(servers: readonly McpServerConfig[]): string[] {
  const args: string[] = [];
  for (const s of servers) {
    args.push('-c', `mcp_servers.${s.name}.command=${JSON.stringify(s.command)}`);
    args.push('-c', `mcp_servers.${s.name}.args=${JSON.stringify(s.args ?? [])}`);
  }
  return args;
}
