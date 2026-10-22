/**
 * @fileoverview Tests for appleScriptLiteral — the AppleScript string literal
 * every AppleScript sink builds for a caller string.
 *
 * The pure cases pin the encoding: `\` and `"` escaped, every other character
 * raw, and U+0000 and unpaired surrogates rejected as invalid input naming the
 * argument. On macOS the round-trip cases hand each literal to the real
 * `osascript -e 'return id of …'` through OsascriptService and compare the code
 * points AppleScript reports with the ones sent; those scripts only evaluate a
 * literal, so they change nothing on the machine.
 * @module tests/services/applescript-literal.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { appleScriptLiteral } from '@/services/osascript/applescript-literal.js';
import { OsascriptService } from '@/services/osascript/osascript-service.js';

const ch = (...codes: number[]) => String.fromCharCode(...codes);

/** `U+0001` for a test name. */
const name = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

/** U+0001–U+001F (tab, LF, and CR among them), U+007F, U+0085, U+2028, and U+2029. */
const CONTROL_CODES = [
  ...Array.from({ length: 0x1f }, (_, i) => i + 1),
  0x7f,
  0x85,
  0x2028,
  0x2029,
];

/** The error `appleScriptLiteral` throws for `value`, which it must reject. */
function rejectionOf(value: string, argName: string): McpError {
  try {
    appleScriptLiteral(value, argName);
  } catch (err) {
    if (err instanceof McpError) return err;
    throw err;
  }
  throw new Error('appleScriptLiteral accepted the value');
}

describe('appleScriptLiteral', () => {
  it('wraps text in double quotes', () => {
    expect(appleScriptLiteral('Safari', 'app_name')).toBe('"Safari"');
    expect(appleScriptLiteral('', 'body')).toBe('""');
  });

  it('escapes a backslash and a double quote, and only those', () => {
    expect(appleScriptLiteral('a\\b"c', 'title')).toBe('"a\\\\b\\"c"');
    expect(appleScriptLiteral('\\"', 'title')).toBe('"\\\\\\""');
    expect(appleScriptLiteral("it's 'quoted' “curly” «chevron» ¬", 'title')).toBe(
      `"it's 'quoted' “curly” «chevron» ¬"`,
    );
  });

  for (const code of CONTROL_CODES) {
    it(`writes ${name(code)} raw between the quotes`, () => {
      expect(appleScriptLiteral(`a${ch(code)}b`, 'title')).toBe(`"a${ch(code)}b"`);
    });
  }

  it('passes a surrogate pair through as the character it encodes', () => {
    expect(appleScriptLiteral('a😀b', 'body')).toBe('"a😀b"');
  });

  it('rejects U+0000 as invalid input naming the argument and its offset', () => {
    const err = rejectionOf(`ab${ch(0x00)}c`, 'app_name');
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.message).toBe(
      'app_name contains U+0000 at UTF-16 offset 2, which osascript cannot pass to AppleScript.',
    );
    expect(err.data).toEqual({
      reason: 'invalid_arguments',
      recovery: { hint: 'Remove U+0000 from app_name and call again.' },
    });
  });

  for (const { label, value, unit, offset } of [
    { label: 'a lone high surrogate', value: `x${ch(0xd83d)}y`, unit: 'D83D', offset: 1 },
    { label: 'a trailing high surrogate', value: `xy${ch(0xd800)}`, unit: 'D800', offset: 2 },
    { label: 'a leading low surrogate', value: `${ch(0xdfff)}xy`, unit: 'DFFF', offset: 0 },
    { label: 'a pair written low first', value: `x${ch(0xde00, 0xd83d)}`, unit: 'DE00', offset: 1 },
    {
      label: 'a lone surrogate after a valid pair',
      value: `😀${ch(0xdc00)}`,
      unit: 'DC00',
      offset: 2,
    },
  ]) {
    it(`rejects ${label} as invalid input naming the argument and its offset`, () => {
      const err = rejectionOf(value, 'path');
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.message).toBe(
        `path contains an unpaired surrogate U+${unit} at UTF-16 offset ${offset}, which AppleScript text cannot represent.`,
      );
      expect(err.data).toEqual({
        reason: 'invalid_arguments',
        recovery: {
          hint: 'Remove the unpaired surrogate from path, or send the whole character it belongs to.',
        },
      });
    });
  }
});

describe.runIf(process.platform === 'darwin')(
  'appleScriptLiteral round-trip through osascript',
  () => {
    const svc = new OsascriptService();

    /** What `return id of <literal>` prints: the code points of the text AppleScript read. */
    async function idsOf(literal: string): Promise<string> {
      const { stdout } = await svc.runAppleScript(`return id of ${literal}`, createMockContext());
      return stdout;
    }

    /** The code points of `text`, printed the way `id of` prints a list. */
    const codePoints = (text: string) => [...text].map((c) => c.codePointAt(0)).join(', ');

    const cases = [
      ...CONTROL_CODES.map((code) => ({ label: name(code), text: `a${ch(code)}b` })),
      { label: 'a double quote', text: 'a"b' },
      { label: 'a backslash', text: 'a\\b' },
      { label: 'a backslash before a quote', text: 'a\\"b' },
      { label: 'a surrogate pair', text: 'a😀b' },
      { label: 'every case above at once', text: `x${ch(...CONTROL_CODES)}"\\😀y` },
    ];

    for (const { label, text } of cases) {
      it(`returns the same code points for ${label}`, async () => {
        expect(await idsOf(appleScriptLiteral(text, 'text'))).toBe(codePoints(text));
      });
    }

    for (const [code, escaped] of [
      [0x09, '\\t'],
      [0x0a, '\\n'],
      [0x0d, '\\r'],
    ] as const) {
      it(`reads ${name(code)} raw the same as AppleScript's own escape for it`, async () => {
        expect(await idsOf(appleScriptLiteral(`a${ch(code)}b`, 'text'))).toBe(
          await idsOf(`"a${escaped}b"`),
        );
      });
    }
  },
);

/**
 * Linear-time bound on caller-sized text. Each shape doubles from 5k to 320k
 * characters (64×). Every size is held to an absolute bound in this thread's
 * CPU time before the next one runs, and the whole span to a ratio below 256 —
 * well under the 4096× a quadratic scan would show. A batch of calls per size
 * keeps the small sizes measurable.
 */
describe('appleScriptLiteral timing', () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  /** Characters encoded per measurement, so a batch at every size does the same work. */
  const BATCH_CHARS = 640_000;
  /** CPU microseconds allowed per character of a single call: far above the measured cost. */
  const MICROS_PER_CHAR = 1;

  const cpuMicros = () => {
    const { user, system } = process.threadCpuUsage();
    return user + system;
  };

  /** The fastest of three batches, in CPU microseconds per call. */
  function microsPerCall(text: string): number {
    const calls = Math.max(1, Math.round(BATCH_CHARS / text.length));
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = cpuMicros();
      for (let i = 0; i < calls; i++) appleScriptLiteral(text, 'body');
      best = Math.min(best, (cpuMicros() - start) / calls);
    }
    return best;
  }

  const SHAPES: Array<[string, (size: number) => string]> = [
    ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`],
    ['breaks throughout', (size) => '  \r\n'.repeat(size / 4)],
    ['every character a double quote', (size) => '"'.repeat(size)],
    ['every character a backslash', (size) => '\\'.repeat(size)],
    ['surrogate pairs throughout', (size) => '😀'.repeat(size / 2)],
  ];

  for (const [shape, build] of SHAPES) {
    it(`timing: grows linearly for ${shape}`, () => {
      appleScriptLiteral(build(5_000), 'body');
      let first: number | undefined;
      let last = Number.NaN;
      for (const size of SIZES) {
        const text = build(size);
        last = microsPerCall(text);
        expect(last).toBeLessThan(text.length * MICROS_PER_CHAR);
        first ??= last;
      }
      expect(last / (first ?? Number.NaN)).toBeLessThan(256);
    });
  }
});
