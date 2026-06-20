// The Surface subsystem (M8 Phase 1, design §13): one Surface contract and the
// WebSurface driver over a Playwright/CDP MCP. Later phases add the tier-A runner
// (Phase 2), the visual critic path (Phase 3), and the baseline pipeline (Phase 4)
// on top of this seam.
export type {
  Surface,
  SurfaceCapabilities,
  AccessibilitySnapshot,
  Screenshot,
  Interaction,
  QueryStateRequest,
  QueryStateResult,
} from './types';
export { SurfaceCallError } from './types';
export {
  WebSurface,
  webSurfaceCapabilities,
  playwrightMcpServerConfig,
  parseSnapshotResult,
  parseScreenshotResult,
  parseQueryResult,
  buildInteractionCall,
  PLAYWRIGHT_MCP_SPEC,
} from './web-surface';
export type { WebSurfaceOptions } from './web-surface';
export { FIXTURE_HTML, startFixture } from './fixture';
export type { StartedFixture } from './fixture';
export { MeteredSurface, WaitMeter, waitFraction } from './wait-meter';
export type { Clock } from './wait-meter';
export {
  LocalHostRunner,
  caffeinateCommand,
  spawnCaffeinate,
  fileTccGate,
  tccGrantNotice,
  renderRunSummary,
} from './local-host-runner';
export type {
  LocalHostRunnerOptions,
  LocalHostRunResult,
  VisualCheck,
  CaffeinateController,
  TccGate,
} from './local-host-runner';
export { parseRefs, replayPath, classifyReplayFailure, replayAndGrade } from './visual-critic';
export type {
  MatchGranularity,
  ElementScope,
  VisualVerification,
  IntentEvidence,
  VisualGrade,
  IntentJudge,
  BaselineGrader,
  ReplayClassification,
  VisualVerdict,
} from './visual-critic';
export {
  BaselineStore,
  exactBytesDiffer,
  DEFAULT_FLAKE_BUDGET,
  readBaselineRef,
  writeBaselineRef,
  promoteBaseline,
  requestReVersion,
  approveReVersion,
  diffAgainstBaseline,
  verifyBaselineDiff,
  makeBaselineGrader,
} from './baseline';
export type {
  BaselineRef,
  ScreenshotDiffer,
  BaselineMismatchKind,
  BaselineMismatch,
  MismatchSink,
  FlakeBudget,
  BaselineContext,
  BaselineDiffResult,
} from './baseline';
