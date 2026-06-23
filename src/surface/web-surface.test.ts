import { describe, expect, test } from 'vitest';
import {
  PLAYWRIGHT_MCP_SPEC,
  buildInteractionCall,
  parseQueryResult,
  parseScreenshotResult,
  parseSnapshotResult,
  playwrightMcpServerConfig,
  webSurfaceCapabilities,
} from './web-surface';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// WHY: the surface is launched as `npx @playwright/mcp` — the "via npx", pinned-
// version constraint — and the same `McpServerConfig` shape the grant bus speaks, so
// the surface server and a later critic grant are one description. If the spec
// floated or the inline-image flag were dropped, screenshots would silently stop
// returning bytes and a run would not be reproducible. These pin both.
describe('playwrightMcpServerConfig', () => {
  test('launches the pinned package via npx with inline image responses', () => {
    const cfg = playwrightMcpServerConfig();
    expect(cfg.name).toBe('surface');
    expect(cfg.command).toBe('npx');
    // The pinned package is the first arg, so npx runs exactly that version.
    expect(cfg.args?.[0]).toBe(PLAYWRIGHT_MCP_SPEC);
    // Inline image responses are explicit: without this the screenshot tool only
    // saves to disk and the pixel-fallback bytes never come back to the client.
    expect(cfg.args).toContain('--image-responses');
    expect(cfg.args).toContain('allow');
    // Defaults are headless + isolated so two surfaces never fight over one profile.
    expect(cfg.args).toContain('--headless');
    expect(cfg.args).toContain('--isolated');
  });

  test('options toggle headless/isolated and thread browser + viewport flags', () => {
    const cfg = playwrightMcpServerConfig({
      headless: false,
      isolated: false,
      browser: 'chrome',
      viewportSize: '1280x720',
    });
    expect(cfg.args).not.toContain('--headless');
    expect(cfg.args).not.toContain('--isolated');
    expect(cfg.args).toContain('--browser');
    expect(cfg.args).toContain('chrome');
    expect(cfg.args).toContain('--viewport-size');
    expect(cfg.args).toContain('1280x720');
  });

  // WHY: Playwright MCP writes its session output to the process cwd by
  // default; a tier-A run threads `--output-dir` so those artifacts land in the run
  // scope instead. If the flag dropped, run artifacts would scatter into cwd.
  test('threads an output dir as --output-dir for run-scoped session artifacts', () => {
    const cfg = playwrightMcpServerConfig({ outputDir: '/run/scope/out' });
    expect(cfg.args).toContain('--output-dir');
    expect(cfg.args).toContain('/run/scope/out');
    // Omitted by default, so a non-tier-A surface keeps Playwright's default cwd.
    expect(playwrightMcpServerConfig().args).not.toContain('--output-dir');
  });
});

// WHY (Validation): `capabilities()` must report the WebSurface's semantic AND
// screenshot support, because the critic's match granularity is selected from
// it. A driver that under-reported would silently disable a granularity.
describe('webSurfaceCapabilities', () => {
  test('reports semantic and screenshot support', () => {
    const caps = webSurfaceCapabilities();
    expect(caps.kind).toBe('web');
    expect(caps.semantic).toBe(true);
    expect(caps.screenshot).toBe(true);
    expect(caps.resize).toBe(true);
  });
});

// WHY: the snapshot is the semantic-first ground truth the critic replays against.
// An empty or error result must fail loud, never be read as a clean empty
// page (Rule 11) — a silently-empty snapshot would grade every element as absent.
describe('parseSnapshotResult', () => {
  test('extracts the accessibility tree from the text content', () => {
    const result: CallToolResult = {
      content: [
        {
          type: 'text',
          text: '- heading "Relay Surface Fixture" [level=1]\n- button "Run check" [ref=e3]',
        },
      ],
    };
    expect(parseSnapshotResult(result).tree).toContain('button "Run check"');
  });

  test('throws on an error result, surfacing the failure detail', () => {
    const result: CallToolResult = {
      isError: true,
      content: [{ type: 'text', text: 'No open pages available' }],
    };
    expect(() => parseSnapshotResult(result)).toThrow(/browser_snapshot failed.*No open pages/);
  });

  test('throws when the tree is empty rather than returning a blank snapshot', () => {
    const result: CallToolResult = { content: [{ type: 'text', text: '   ' }] };
    expect(() => parseSnapshotResult(result)).toThrow(/no accessibility tree/);
  });
});

// WHY: the screenshot is the pixel fallback the baseline-diff granularity needs.
// The bytes ride back as an image content block; a missing image must
// throw, never yield an empty screenshot a baseline would then "match".
describe('parseScreenshotResult', () => {
  test('extracts image bytes and mime type from the image content block', () => {
    const result: CallToolResult = {
      content: [
        { type: 'text', text: 'Took a screenshot' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ],
    };
    const shot = parseScreenshotResult(result);
    expect(shot.data).toBe('iVBORw0KGgo=');
    expect(shot.mimeType).toBe('image/png');
  });

  test('throws when no image content is present', () => {
    const result: CallToolResult = { content: [{ type: 'text', text: 'saved to disk' }] };
    expect(() => parseScreenshotResult(result)).toThrow(/no image content/);
  });
});

// WHY: queryState is the a11y-tree escape hatch (a computed/JS value the snapshot
// cannot express); it must lift the evaluation's text value, and fail loud on a
// tool error.
describe('parseQueryResult', () => {
  test('returns the evaluation text value', () => {
    const result: CallToolResult = { content: [{ type: 'text', text: '"ran"' }] };
    expect(parseQueryResult(result)).toBe('"ran"');
  });

  test('throws on an error result', () => {
    const result: CallToolResult = {
      isError: true,
      content: [{ type: 'text', text: 'ReferenceError' }],
    };
    expect(() => parseQueryResult(result)).toThrow(/browser_evaluate failed/);
  });
});

// WHY: interactions are semantic-first — they target a `ref` from a snapshot,
// not coordinates — and the executor's path is replayed verbatim by the critic, so
// the action→tool mapping must be exact and stable. Optional fields must be OMITTED
// when unset (not sent as undefined), so the call shape matches what the server
// expects.
describe('buildInteractionCall', () => {
  test('maps a click to browser_click with the semantic ref', () => {
    const call = buildInteractionCall({ kind: 'click', ref: 'e3', element: 'Run check button' });
    expect(call.name).toBe('browser_click');
    expect(call.arguments).toEqual({ target: 'e3', element: 'Run check button' });
  });

  test('omits optional click fields when unset', () => {
    const call = buildInteractionCall({ kind: 'click', ref: 'e3' });
    expect(call.arguments).toEqual({ target: 'e3' });
    expect('element' in call.arguments).toBe(false);
    expect('doubleClick' in call.arguments).toBe(false);
  });

  test('maps a type with submit to browser_type', () => {
    const call = buildInteractionCall({ kind: 'type', ref: 'e5', text: 'hello', submit: true });
    expect(call.name).toBe('browser_type');
    expect(call.arguments).toEqual({ target: 'e5', text: 'hello', submit: true });
  });

  test('maps a key press to browser_press_key (keyboard-only, no target)', () => {
    const call = buildInteractionCall({ kind: 'press', key: 'Enter' });
    expect(call.name).toBe('browser_press_key');
    expect(call.arguments).toEqual({ key: 'Enter' });
  });
});
