import { expect, test } from 'vitest';

// Proves the test harness compiles TypeScript and executes assertions. Later
// milestones replace this with real spine tests; until then it guards that
// `npm test` itself is wired up and green.
test('test harness runs and reports', () => {
  expect(1 + 1).toBe(2);
});
