// The evidence-directory compactor dogfood (design §12 step 8 / D2, M7). Phase 1
// exports the run seed (committed via intake in Phase 2) and the graded fixture with
// its golden expectations; the compactor itself is Phase 2.
export { COMPACTOR_SEED_MESSAGE, compactorSeed } from './seed';
export { GOLDEN, buildCompactorFixture } from './fixture';
export type { CompactorFixture } from './fixture';
