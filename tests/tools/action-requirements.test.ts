/**
 * @fileoverview Tests for the per-action requirement helper on a synthetic
 * tool, covering the shapes no production tool uses yet (two either-of groups
 * on one action) and the argument-narrowing guard.
 * @module tests/tools/action-requirements.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { suppliedArg, withActionRequirements } from '@/mcp-server/tools/action-requirements.js';

const probe = tool('probe_requirements', {
  description: 'Synthetic tool exercising per-action requirements.',
  input: withActionRequirements(
    z.object({
      mode: z.enum(['idle', 'pair', 'solo']).describe('Mode.'),
      a: z.string().optional().describe('A.'),
      b: z.string().optional().describe('B.'),
      c: z.number().optional().describe('C.'),
      d: z.number().optional().describe('D.'),
    }),
    'mode',
    {
      pair: [
        ['a', 'b'],
        ['c', 'd'],
      ],
      solo: [['c']],
    },
  ),
  output: z.object({ mode: z.string().describe('Mode echoed back.') }),
  handler: (input) => ({ mode: input.mode }),
  format: (result) => [{ type: 'text', text: `mode: ${result.mode}` }],
});

describe('withActionRequirements', () => {
  it('advertises two either-of groups as an allOf of typed anyOf branches', () => {
    const schema = z.toJSONSchema(probe.input, { io: 'input' }) as {
      anyOf: Array<Record<string, unknown>>;
    };
    expect(schema.anyOf).toEqual([
      { type: 'object', properties: { mode: { enum: ['idle'] } }, required: ['mode'] },
      {
        type: 'object',
        properties: { mode: { const: 'pair' } },
        required: ['mode'],
        allOf: [
          {
            type: 'object',
            anyOf: [
              { type: 'object', required: ['a'], properties: { a: { minLength: 1 } } },
              { type: 'object', required: ['b'], properties: { b: { minLength: 1 } } },
            ],
          },
          {
            type: 'object',
            anyOf: [
              { type: 'object', required: ['c'] },
              { type: 'object', required: ['d'] },
            ],
          },
        ],
      },
      { type: 'object', properties: { mode: { const: 'solo' } }, required: ['mode', 'c'] },
    ]);
  });

  it('reports each unmet group, and the hint names every acceptable argument', async () => {
    const result = await runToolContract(probe, { mode: 'pair' });
    const error = (result.structuredContent as { error: { code: number; data: never } }).error;
    expect(error.code).toBe(-32602);
    expect(error.data).toMatchObject({ reason: 'invalid_arguments' });
    const hint = (error.data as { recovery: { hint: string } }).recovery.hint;
    expect(hint).toContain('mode=pair requires at least one of a or b.');
    expect(hint).toContain('mode=pair requires at least one of c or d.');
  });

  it('accepts a value with no requirements and off-mode arguments', async () => {
    const result = await runToolContract(probe, { mode: 'idle', a: 'x', c: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ mode: 'idle' });
  });

  it('accepts one argument from each either-of group', async () => {
    const result = await runToolContract(probe, { mode: 'pair', b: 'y', c: 0 });
    expect(result.isError).toBeFalsy();
    expect(result.content?.[0]).toMatchObject({ text: 'mode: pair' });
  });

  it('counts 0 as supplied for a number and rejects a blank string', async () => {
    expect((await runToolContract(probe, { mode: 'solo', c: 0 })).isError).toBeFalsy();
    const blank = await runToolContract(probe, { mode: 'pair', a: '', c: 1 });
    expect(blank.isError).toBe(true);
  });

  it('keeps the root strict — an unknown key is still rejected', async () => {
    const result = await runToolContract(probe, { mode: 'idle', e: 1 } as never);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('invalid_arguments');
  });
});

describe('suppliedArg', () => {
  it('returns a supplied value unchanged', () => {
    expect(suppliedArg('Safari', 'app_name')).toBe('Safari');
    expect(suppliedArg(0, 'x')).toBe(0);
  });

  it('fails as an internal error for an unset value', () => {
    expect(() => suppliedArg(undefined, 'app_name')).toThrow(/app_name/);
    expect(() => suppliedArg('', 'app_name')).toThrow(expect.objectContaining({ code: -32603 }));
  });
});
