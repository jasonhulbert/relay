import { describe, expect, test } from 'vitest';
import { checkFileBoundary, checkInterface, seamIsCheckable } from './seam';

// WHY: `seamIsCheckable` is the seam-checkability forcing function the scheduler reads.
// If a deferred kind (no code predicate yet) read as checkable, the scheduler would let
// two siblings merge in parallel across a seam nothing can verify — the exact unsafe
// direction the concurrency law forbids. These pin which kinds the gate trusts.
describe('seamIsCheckable — the seam-checkability forcing gate', () => {
  test('the two checkable kinds are checkable; the deferred kinds are not', () => {
    expect(seamIsCheckable('file-boundary')).toBe(true);
    expect(seamIsCheckable('interface')).toBe(true);
    expect(seamIsCheckable('http')).toBe(false);
    expect(seamIsCheckable('data-schema')).toBe(false);
  });
});

// WHY (validation 1): the file-boundary predicate certifies that two children's
// outputs cannot collide on a file. It must pass on disjoint write globs and fail on
// overlapping ones — a false pass would let conflicting writes merge silently.
describe('checkFileBoundary — disjoint repo-qualified write globs', () => {
  test('passes on disjoint globs', () => {
    const r = checkFileBoundary({ producerGlobs: ['src/a/**'], consumerGlobs: ['src/b/**'] });
    expect(r.ok).toBe(true);
  });

  test('fails on overlapping globs, naming the conflict', () => {
    const r = checkFileBoundary({
      producerGlobs: ['src/a/**'],
      consumerGlobs: ['src/a/overlap.ts'],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('overlap');
  });
});

// WHY (validation 2): the interface predicate certifies the producer actually
// publishes what the consumer depends on. It must pass on a matching signature and
// fail on a mismatch (or an absent symbol) — the falsifiable direction is a consumer
// compiling against a contract the producer never shipped.
describe('checkInterface — a named symbol/type/signature via AST lookup', () => {
  const producer = [
    'export function widgetCount(items: Widget[]): number {',
    '  return items.length;',
    '}',
    'export interface Widget {',
    '  id: string;',
    '}',
    'const internalHelper = (x: number): number => x + 1;',
  ].join('\n');

  test('passes when the symbol is exported (no signature pinned)', () => {
    expect(checkInterface({ symbol: 'Widget' }, producer).ok).toBe(true);
  });

  test('fails when the symbol is not exported', () => {
    // `internalHelper` exists but is not exported — the seam contract is not published.
    expect(checkInterface({ symbol: 'internalHelper' }, producer).ok).toBe(false);
    expect(checkInterface({ symbol: 'Missing' }, producer).ok).toBe(false);
  });

  test('passes on a matching signature (formatting-insensitive)', () => {
    const r = checkInterface(
      { symbol: 'widgetCount', signature: 'function widgetCount(items:Widget[]):number' },
      producer,
    );
    expect(r.ok).toBe(true);
  });

  test('fails on a signature mismatch', () => {
    const r = checkInterface(
      // The consumer expects a `string` return; the producer returns `number`.
      { symbol: 'widgetCount', signature: 'function widgetCount(items: Widget[]): string' },
      producer,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('mismatch');
  });
});
