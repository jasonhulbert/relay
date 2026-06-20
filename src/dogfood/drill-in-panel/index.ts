// The evidence drill-in panel dogfood (design §12 / D3, M9). Phase 1 exports the run
// seed (committed via intake in Phase 2) and the deterministic fixture with its declared
// grounding; Phase 2 builds the panel on the M5 web view and drives the full visual path.
export { DRILL_IN_PANEL_SEED_MESSAGE, drillInPanelSeed } from './seed';
export { PANEL_FIXTURE, buildDrillInPanelFixture } from './fixture';
export type { DrillInPanelFixture } from './fixture';
