import { defineConfig } from 'vitest/config';

// The M2 hierarchy tests spawn real `node` sub-orchestrator processes (C6) and run
// in parallel with the filesystem-backed property tests (node/contract round-trip,
// 150 disk round-trips each). Under that combined load the property tests can
// exceed Vitest's 5s default, so give every test headroom. This is a wall-clock
// allowance, not a correctness knob — the assertions are unchanged.
export default defineConfig({
  test: {
    testTimeout: 20000,
  },
});
