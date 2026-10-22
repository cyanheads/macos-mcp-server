/**
 * @fileoverview Tests for parseJsonOutput — JSON text, a subprocess's output or
 * a file's contents, through a schema.
 * @module tests/utils/parse-json-output.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { parseJsonOutput } from '@/utils/parse-json-output.js';

const ScreenSchema = z.object({ index: z.number(), name: z.string() });

describe('parseJsonOutput', () => {
  it('returns the schema’s output for JSON in shape, unknown keys stripped', () => {
    expect(parseJsonOutput(ScreenSchema, '{"index":1,"name":"Built-in","extra":true}')).toEqual({
      index: 1,
      name: 'Built-in',
    });
  });

  it.each([
    ['valid JSON of the wrong shape', '{"index":"1","name":"Built-in"}'],
    ['text that is not JSON', 'execution error: Not authorized (-1743)'],
    ['an empty string', ''],
  ])('returns undefined for %s', (_label, text) => {
    expect(parseJsonOutput(ScreenSchema, text)).toBeUndefined();
  });
});
