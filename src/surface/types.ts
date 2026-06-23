// The Surface abstraction. A Surface is the single seam
// between the visual verification subsystem and a running application: the executor
// drives it to reach state, and the critic REPLAYS the same semantic path against
// it to grade an outcome. One interface, many drivers — the current implementation
// ships the `WebSurface` over a Playwright/CDP MCP; later runners reuse the contract
// so the critic path and baseline pipeline never special-case the driver.
//
// Semantic-first, pixel-fallback: the load-bearing read
// is the accessibility snapshot (a stable semantic tree), and the screenshot is
// the pixel fallback. Interactions therefore target a semantic ref pulled from a
// snapshot, not raw coordinates.
//
// Evidence-ref discipline: the Surface PRODUCES a snapshot/
// screenshot; it never persists one. Callers write artifacts into the run-scoped
// evidence store and keep only the ref — so `Screenshot` carries bytes-in-memory,
// not a path, and nothing here touches `.relay/`.

// What a concrete Surface driver can do, reported so a caller can pick a grading
// granularity it supports without probing. `semantic` is a11y-snapshot
// support (the semantic-first read), `screenshot` is the pixel fallback.
export interface SurfaceCapabilities {
  // The driver kind, for logging/selection. Currently: 'web'.
  kind: 'web';
  // Accessibility-snapshot support: the semantic tree interactions and the critic
  // replay grade against, including element-scoped checks. True for the WebSurface.
  semantic: boolean;
  // Pixel screenshot support: the fallback the baseline-diff granularity needs.
  // True for the WebSurface.
  screenshot: boolean;
  // Window/viewport resize support, so a check can pin a deterministic frame size.
  resize: boolean;
}

// The accessibility snapshot: a semantic tree of the current page as text. This is
// the semantic-first ground truth — element refs inside it are what `interact` and
// `queryState` address for element-scoping, and what the critic replays.
export interface AccessibilitySnapshot {
  // The serialized a11y tree (Playwright MCP's YAML-ish snapshot text). Treated as
  // opaque text at this layer; the critic path parses refs out of it.
  tree: string;
}

// A pixel screenshot of the current frame. Bytes in memory (base64) plus the image
// MIME type — never a path (evidence-ref discipline: the caller persists it).
export interface Screenshot {
  // Base64-encoded image bytes.
  data: string;
  // e.g. 'image/png'.
  mimeType: string;
}

// A semantic interaction the executor drives and the critic replays. Every
// kind that addresses an element targets a semantic `ref` from a prior snapshot
// (semantic-first), with an optional human-readable `element` description the
// driver uses for its interaction-permission record. `press` is keyboard-only and
// needs no element.
export type Interaction =
  | {
      kind: 'click';
      // Semantic element ref from a snapshot, or a unique selector (pixel-fallback).
      ref: string;
      // Human-readable description of the target element.
      element?: string;
      doubleClick?: boolean;
    }
  | {
      kind: 'type';
      ref: string;
      text: string;
      element?: string;
      // Press Enter after typing.
      submit?: boolean;
    }
  | {
      kind: 'press';
      // A key name ('Enter', 'ArrowLeft') or a single character.
      key: string;
    };

// A read of live page state via an in-page function evaluation — the escape hatch
// for outcomes the a11y tree cannot express (e.g. a computed style or a JS value).
// Read-only by intent: used by `queryState`, never to drive the app.
export interface QueryStateRequest {
  // An in-page function body, e.g. `() => document.title`. Optionally scoped to a
  // semantic element via `ref`, in which case the function receives it.
  function: string;
  // Optional element ref to scope the evaluation to (the function's argument).
  ref?: string;
  // Human-readable description of the scoped element, when `ref` is set.
  element?: string;
}

export interface QueryStateResult {
  // The evaluation result, serialized to text by the driver.
  value: string;
}

// A typed Surface failure. A driver call that fails surfaces this
// rather than a bare `Error`, so the visual critic's failure classification keys off
// a structural `tool` + `detail` — never a brittle parse of a free-text message
// (Rule 11: fail loud, and loudly *typed*). `tool` is the driver operation that
// failed (e.g. the Playwright `browser_*` tool); `detail` is the driver's reason,
// carried verbatim so a transient mode (`timeout`, navigation error) is recognizable
// without a model call.
export class SurfaceCallError extends Error {
  readonly tool: string;
  readonly detail: string;
  constructor(tool: string, detail: string) {
    super(`playwright mcp ${tool} failed: ${detail || '(no detail)'}`);
    this.name = 'SurfaceCallError';
    this.tool = tool;
    this.detail = detail;
  }
}

// The one Surface contract every driver implements. Lifecycle is
// explicit: `launch` brings the surface up at a target and `close` tears it down;
// the spine owns one long-lived instance and shares it across checks rather than
// re-launching per check.
export interface Surface {
  // Static capability descriptor: which match granularities this driver supports.
  capabilities(): SurfaceCapabilities;

  // Bring the surface up at a target URL. Idempotent on the underlying server: the
  // first call starts the long-lived backing server and connects; subsequent calls
  // reuse it and re-navigate (the "one long-lived shared server" lifecycle).
  launch(url: string): Promise<void>;

  // Resize the window/viewport to a deterministic frame size.
  resize(width: number, height: number): Promise<void>;

  // Capture the accessibility snapshot (semantic-first read). Optionally scoped to
  // a semantic element ref, so a component-scoped check ignores the rest of
  // the frame.
  snapshot(opts?: { ref?: string }): Promise<AccessibilitySnapshot>;

  // Capture a pixel screenshot (the fallback). Optionally scoped to an element ref.
  screenshot(opts?: { ref?: string; element?: string }): Promise<Screenshot>;

  // Drive one semantic interaction. Resolves once the driver reports the
  // action applied; throws on a typed driver failure (the failure classifier reads it).
  interact(action: Interaction): Promise<void>;

  // Read live page state via an in-page evaluation (the a11y-tree escape hatch).
  queryState(request: QueryStateRequest): Promise<QueryStateResult>;

  // Tear down the surface and its backing server.
  close(): Promise<void>;
}
