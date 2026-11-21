/**
 * @fileoverview A linear-time check for a function over caller-sized text,
 * measured in this thread's CPU time.
 * @module tests/helpers/expect-linear-time
 */

import { expect } from 'vitest';

/** The size every larger size is timed beside. */
const BASE_SIZE = 5_000;
/** Doubling from the baseline to 64× it. */
const SIZES = [10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
/** Characters processed per measurement, so a batch at every size does the same work. */
const BATCH_CHARS = 640_000;
/** CPU microseconds allowed per character of a single call: far above the measured cost. */
const MICROS_PER_CHAR = 1;
/** Baseline-and-size pairs timed at each size. */
const PAIRS = 3;
/** The bound on growth across the full span: far under the 4096× a quadratic shows over 64×. */
const MAX_GROWTH = 256;

/** User plus system CPU time this thread has used, in microseconds. */
function cpuMicros(): number {
  const { user, system } = process.threadCpuUsage();
  return user + system;
}

/** CPU microseconds per call of `run` on `text`, over one batch of calls. */
function microsPerCall(run: (text: string) => unknown, text: string): number {
  const calls = Math.max(1, Math.round(BATCH_CHARS / text.length));
  const start = cpuMicros();
  for (let i = 0; i < calls; i++) run(text);
  return (cpuMicros() - start) / calls;
}

/**
 * Asserts that `run` takes time linear in the length of `build(size)`, a text
 * of `size` characters. Sizes double from 5k to 320k (64×), and each is held
 * to an absolute bound in CPU time before the next one runs, so a super-linear
 * `run` fails in seconds instead of hanging on the largest size. The 5k
 * baseline is timed again beside every size, and the full span is held to the
 * least growth across those pairs, below 256: a baseline timed once can land on
 * a performance core while a later size runs on an efficiency core, several-fold
 * slower on the same code. A batch of calls per measurement keeps the small
 * sizes above the timer's resolution, and the least of several measurements
 * drops a garbage-collection pause, which only ever adds time.
 *
 * Call it from a test whose timeout is 0: vitest cannot interrupt a synchronous
 * body, so a timeout guards no hang and only fails linear work under load.
 */
export function expectLinearTime(
  run: (text: string) => unknown,
  build: (size: number) => string,
): void {
  const base = build(BASE_SIZE);
  run(base);
  let growth = Number.NaN;
  for (const size of SIZES) {
    const text = build(size);
    let fastest = Number.POSITIVE_INFINITY;
    growth = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < PAIRS; pair++) {
      const baseMicros = microsPerCall(run, base);
      const sizeMicros = microsPerCall(run, text);
      fastest = Math.min(fastest, sizeMicros);
      growth = Math.min(growth, sizeMicros / baseMicros);
    }
    expect(fastest, `${size} characters`).toBeLessThan(text.length * MICROS_PER_CHAR);
  }
  expect(growth).toBeLessThan(MAX_GROWTH);
}
