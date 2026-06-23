// The evidence drill-in panel dogfood. The seed-production step exports the run seed
// (committed via intake in a later step) and the deterministic fixture with its declared
// grounding; a later step builds the panel on the read-only web view and drives the full
// visual path.
export { DRILL_IN_PANEL_SEED_MESSAGE, drillInPanelSeed } from './seed';
export { PANEL_FIXTURE, buildDrillInPanelFixture } from './fixture';
export type { DrillInPanelFixture } from './fixture';
