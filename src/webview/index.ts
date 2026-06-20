// The read-only local web view: a render of `.relay/` for operator supervision
// and the human decision inbox (design §3.11). Distinct from Surfaces/visual
// verification. M5 Phase 1 is the read-time projection that composes the whole
// tree, statuses, and run log from the per-node files (design §4, I3); the HTTP
// surface (Phase 2) and cost rollups (Phase 3) build on it.
export { projectRun } from './projection';
export type { NodeView, TreeNode, RunProjection } from './projection';
export { renderRunPage, renderErrorPage, renderNodePanel, panelHref } from './render';
export { createWebViewServer, startWebView } from './server';
export type { WebViewServerOptions, StartedWebView } from './server';
