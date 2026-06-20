// The Surface abstraction (design §13, V-series). A Surface is the single seam
// between the visual verification subsystem and a running application: the executor
// drives it to reach state, and the critic REPLAYS the same semantic path against
// it to grade an outcome (V1). One interface, many drivers — v0.1 ships the
// `WebSurface` over a Playwright/CDP MCP; later runners reuse the contract so the
// critic path and baseline pipeline never special-case the driver.
//
// Semantic-first, pixel-fallback (the V-series constraint): the load-bearing read
// is the accessibility snapshot (a stable semantic tree), and the screenshot is
// the pixel fallback. Interactions therefore target a semantic ref pulled from a
// snapshot, not raw coordinates.
//
// Evidence-ref discipline (design §3.2, §4): the Surface PRODUCES a snapshot/
// screenshot; it never persists one. Callers write artifacts into the run-scoped
// evidence store and keep only the ref — so `Screenshot` carries bytes-in-memory,
// not a path, and nothing here touches `.relay/`.

// What a concrete Surface driver can do, reported so a caller can pick a grading
// granularity it supports (V4) without probing. `semantic` is a11y-snapshot
// support (the semantic-first read), `screenshot` is the pixel fallback.
export interface SurfaceCapabilities {
  // The driver kind, for logging/selection. v0.1: 'web'.
  kind: 'web';
  // Accessibility-snapshot support: the semantic tree interactions and the critic
  // replay grade against (V1, V7). True for the WebSurface.
  semantic: boolean;
  // Pixel screenshot support: the fallback the baseline-diff granularity needs (V4,
  // V6). True for the WebSurface.
  screenshot: boolean;
  // Window/viewport resize support, so a check can pin a deterministic frame size.
  resize: boolean;
}

// The accessibility snapshot: a semantic tree of the current page as text. This is
// the semantic-first ground truth — element refs inside it are what `interact` and
// `queryState` address (V7 element-scoping), and what the critic replays (V1).
export interface AccessibilitySnapshot {
  // The serialized a11y tree (Playwright MCP's YAML-ish snapshot text). Treated as
  // opaque text at this layer; the critic path (Phase 3) parses refs out of it.
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

// A semantic interaction the executor drives and the critic replays (V1). Every
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
  // semantic element via `ref` (V7), in which case the function receives it.
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

// The one Surface contract every driver implements (design §13). Lifecycle is
// explicit: `launch` brings the surface up at a target and `close` tears it down;
// the spine owns one long-lived instance and shares it across checks rather than
// re-launching per check.
export interface Surface {
  // Static capability descriptor (V4): which granularities this driver supports.
  capabilities(): SurfaceCapabilities;

  // Bring the surface up at a target URL. Idempotent on the underlying server: the
  // first call starts the long-lived backing server and connects; subsequent calls
  // reuse it and re-navigate (the "one long-lived shared server" lifecycle).
  launch(url: string): Promise<void>;

  // Resize the window/viewport to a deterministic frame size.
  resize(width: number, height: number): Promise<void>;

  // Capture the accessibility snapshot (semantic-first read). Optionally scoped to
  // a semantic element ref (V7), so a component-scoped check ignores the rest of
  // the frame.
  snapshot(opts?: { ref?: string }): Promise<AccessibilitySnapshot>;

  // Capture a pixel screenshot (the fallback). Optionally scoped to an element ref.
  screenshot(opts?: { ref?: string; element?: string }): Promise<Screenshot>;

  // Drive one semantic interaction (V1). Resolves once the driver reports the
  // action applied; throws on a typed driver failure (the V5 classifier reads it).
  interact(action: Interaction): Promise<void>;

  // Read live page state via an in-page evaluation (the a11y-tree escape hatch).
  queryState(request: QueryStateRequest): Promise<QueryStateResult>;

  // Tear down the surface and its backing server.
  close(): Promise<void>;
}
