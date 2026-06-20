// The WebSurface driver (design §13): the `Surface` contract implemented over a
// Playwright MCP server. The spine is the MCP HOST (see ../mcp/index.ts); here it
// is also an MCP CLIENT, connecting to a Playwright MCP server it launches as one
// long-lived shared process and driving its `browser_*` tools to reach, read, and
// screenshot the app. The same server config the surface launches is the grant the
// spine later routes into the critic so it can replay against the app (V1) — which
// is why the launch spec is an `McpServerConfig`, the shape the grant bus already
// speaks.
//
// Split for testability, the same shape as the executor adapters: the pure helpers
// (server-config build + tool-result parse + interaction mapping) are unit-tested
// against captured Playwright MCP result shapes, and the live MCP I/O lives in the
// `WebSurface` class, exercised only by the gated integration test (it spawns a
// real browser).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '../relay-state/index';
import type {
  AccessibilitySnapshot,
  Interaction,
  QueryStateRequest,
  QueryStateResult,
  Screenshot,
  Surface,
  SurfaceCapabilities,
} from './types';

// Pinned at build time (the verified-tooling discipline, design constraint): the
// Playwright MCP package the surface launches via `npx`. A pin, not a floating
// tag, so a surface run is reproducible.
export const PLAYWRIGHT_MCP_SPEC = '@playwright/mcp@0.0.76';

export interface WebSurfaceOptions {
  // Run the browser headless. Default true (CI/eval); a tier-A run on the logged-in
  // session (Phase 2) flips this off.
  headless?: boolean;
  // Keep the browser profile in memory instead of a shared on-disk profile. Default
  // true: a persistent profile can only be used by one browser at a time, so the
  // shared on-disk profile would make two surfaces conflict.
  isolated?: boolean;
  // Browser/channel: chrome | firefox | webkit | msedge. Default Playwright's.
  browser?: string;
  // Initial viewport, "WIDTHxHEIGHT" (e.g. "1280x720"), for a deterministic frame.
  viewportSize?: string;
  // The `npx` binary; defaults to the one on PATH.
  npxBin?: string;
}

// Build the Playwright MCP launch spec as an `McpServerConfig` — the same shape the
// grant bus routes into agents — so the surface server and a later critic grant are
// one description. Launched `via npx` (the constraint), pinned to PLAYWRIGHT_MCP_SPEC.
// `--image-responses allow` is explicit so `browser_take_screenshot` returns image
// bytes inline (the pixel fallback) rather than only saving to disk.
export function playwrightMcpServerConfig(opts: WebSurfaceOptions = {}): McpServerConfig {
  const args = [PLAYWRIGHT_MCP_SPEC, '--image-responses', 'allow'];
  if (opts.headless ?? true) args.push('--headless');
  if (opts.isolated ?? true) args.push('--isolated');
  if (opts.browser !== undefined) args.push('--browser', opts.browser);
  if (opts.viewportSize !== undefined) args.push('--viewport-size', opts.viewportSize);
  return { name: 'surface', command: opts.npxBin ?? 'npx', args };
}

// The WebSurface's static capabilities (V4): a11y snapshot (semantic-first) and
// pixel screenshot are both supported, as is resize.
export function webSurfaceCapabilities(): SurfaceCapabilities {
  return { kind: 'web', semantic: true, screenshot: true, resize: true };
}

// A failed tool call must surface loudly, never read as a clean empty result
// (Rule 11): an MCP tool reports failure with `isError: true` and the reason in its
// text content, so we lift that into a thrown Error rather than parsing on.
function assertOk(result: CallToolResult, tool: string): void {
  if (result.isError === true) {
    const text = textOf(result);
    throw new Error(`playwright mcp ${tool} failed: ${text || '(no detail)'}`);
  }
}

// Concatenate the text content blocks of a tool result. Playwright MCP returns its
// a11y snapshot and evaluation results as text blocks.
function textOf(result: CallToolResult): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// Parse a `browser_snapshot` result into the semantic snapshot. The whole text
// payload is the a11y tree (opaque here; the critic path parses refs out of it).
// A result with no text is a hard error — an empty snapshot is never a valid read.
export function parseSnapshotResult(result: CallToolResult): AccessibilitySnapshot {
  assertOk(result, 'browser_snapshot');
  const tree = textOf(result);
  if (tree.trim() === '') {
    throw new Error('playwright mcp browser_snapshot returned no accessibility tree');
  }
  return { tree };
}

// Parse a `browser_take_screenshot` result into image bytes. The image rides back
// as an image content block (base64 + mime). Missing image content is a hard error
// rather than a silent empty screenshot.
export function parseScreenshotResult(result: CallToolResult): Screenshot {
  assertOk(result, 'browser_take_screenshot');
  const image = result.content.find(
    (b): b is { type: 'image'; data: string; mimeType: string } => b.type === 'image',
  );
  if (!image) {
    throw new Error('playwright mcp browser_take_screenshot returned no image content');
  }
  return { data: image.data, mimeType: image.mimeType };
}

// Parse a `browser_evaluate` result (the queryState read) into its text value.
export function parseQueryResult(result: CallToolResult): string {
  assertOk(result, 'browser_evaluate');
  return textOf(result);
}

// Map a semantic `Interaction` to the Playwright MCP tool call. The interaction
// tools take `target` (the semantic ref or selector) and an optional human-readable
// `element` description; `press` is keyboard-only. Pure, so the mapping is pinned by
// a unit test without spawning a browser.
export function buildInteractionCall(action: Interaction): {
  name: string;
  arguments: Record<string, unknown>;
} {
  switch (action.kind) {
    case 'click': {
      const args: Record<string, unknown> = { target: action.ref };
      if (action.element !== undefined) args.element = action.element;
      if (action.doubleClick !== undefined) args.doubleClick = action.doubleClick;
      return { name: 'browser_click', arguments: args };
    }
    case 'type': {
      const args: Record<string, unknown> = { target: action.ref, text: action.text };
      if (action.element !== undefined) args.element = action.element;
      if (action.submit !== undefined) args.submit = action.submit;
      return { name: 'browser_type', arguments: args };
    }
    case 'press':
      return { name: 'browser_press_key', arguments: { key: action.key } };
  }
}

// The MCP-client-backed WebSurface. Holds one long-lived connection to a Playwright
// MCP server: `launch` starts the server on first call and reuses it after, so the
// spine keeps one shared surface across checks rather than respawning a browser per
// check.
export class WebSurface implements Surface {
  readonly #config: McpServerConfig;
  #client: Client | null = null;

  constructor(opts: WebSurfaceOptions = {}) {
    this.#config = playwrightMcpServerConfig(opts);
  }

  capabilities(): SurfaceCapabilities {
    return webSurfaceCapabilities();
  }

  // Connect the long-lived MCP client on first use, then reuse it. The transport
  // spawns the `npx @playwright/mcp` server process; the browser itself launches
  // lazily on the first `browser_*` call.
  async #connect(): Promise<Client> {
    if (this.#client) return this.#client;
    const transport = new StdioClientTransport({
      command: this.#config.command,
      args: this.#config.args ?? [],
    });
    const client = new Client({ name: 'relay-web-surface', version: '0.1.0' });
    await client.connect(transport);
    this.#client = client;
    return client;
  }

  async #call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.#connect();
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  async launch(url: string): Promise<void> {
    const result = await this.#call('browser_navigate', { url });
    assertOk(result, 'browser_navigate');
  }

  async resize(width: number, height: number): Promise<void> {
    const result = await this.#call('browser_resize', { width, height });
    assertOk(result, 'browser_resize');
  }

  async snapshot(opts: { ref?: string } = {}): Promise<AccessibilitySnapshot> {
    const args: Record<string, unknown> = {};
    if (opts.ref !== undefined) args.target = opts.ref;
    return parseSnapshotResult(await this.#call('browser_snapshot', args));
  }

  async screenshot(opts: { ref?: string; element?: string } = {}): Promise<Screenshot> {
    const args: Record<string, unknown> = { type: 'png' };
    if (opts.ref !== undefined) args.target = opts.ref;
    if (opts.element !== undefined) args.element = opts.element;
    return parseScreenshotResult(await this.#call('browser_take_screenshot', args));
  }

  async interact(action: Interaction): Promise<void> {
    const { name, arguments: args } = buildInteractionCall(action);
    const result = await this.#call(name, args);
    assertOk(result, name);
  }

  async queryState(request: QueryStateRequest): Promise<QueryStateResult> {
    const args: Record<string, unknown> = { function: request.function };
    if (request.ref !== undefined) args.target = request.ref;
    if (request.element !== undefined) args.element = request.element;
    return { value: parseQueryResult(await this.#call('browser_evaluate', args)) };
  }

  async close(): Promise<void> {
    if (!this.#client) return;
    await this.#client.close();
    this.#client = null;
  }
}
