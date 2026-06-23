// The evidence-directory compactor dogfood. One step exports the run seed (committed
// via intake in a later step) and the graded fixture with its golden expectations; a
// later step adds the compactor itself.
export { COMPACTOR_SEED_MESSAGE, compactorSeed } from './seed';
export { GOLDEN, buildCompactorFixture } from './fixture';
export type { CompactorFixture } from './fixture';
export { compactEvidence } from './compactor';
export type { CompactionManifest } from './compactor';
