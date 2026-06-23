// The read-only local web view: a render of `.relay/` for operator supervision
// and the human decision inbox. Distinct from Surfaces/visual verification. The
// read-time projection composes the whole tree, statuses, and run log from the
// per-node files and writes nothing to `.relay/`; the HTTP surface and cost
// rollups build on it.
export { projectRun, projectSupervisorNode } from './projection';
export type {
  NodeView,
  TreeNode,
  RunProjection,
  SupervisorView,
  EvidenceContent,
} from './projection';
export { renderRunPage, renderErrorPage, renderNodePanel, panelHref } from './render';
export { createWebViewServer, startWebView } from './server';
export type { WebViewServerOptions, StartedWebView } from './server';
