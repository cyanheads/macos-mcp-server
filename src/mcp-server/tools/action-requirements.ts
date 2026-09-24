/**
 * @fileoverview Per-action argument requirements for flat tool input schemas.
 *
 * Multi-action tools keep a flat `z.object` root so every argument stays in the
 * advertised `properties` and arguments meant for another action are still
 * accepted. What an action needs is declared once here, and that one
 * declaration drives both halves of the contract: a root `superRefine` that
 * rejects a call missing a required argument before the handler runs (the
 * framework returns it as `-32602` `invalid_arguments`), and a root `anyOf`
 * that advertises the same requirement in `inputSchema`.
 * @module mcp-server/tools/action-requirements
 */

import { z } from '@cyanheads/mcp-ts-core';
import { internalError } from '@cyanheads/mcp-ts-core/errors';

/**
 * The argument groups one discriminator value needs. Every group must be
 * satisfied; a group of one names a required argument, a group of several is
 * satisfied by any one of them.
 */
type Requirements<Shape extends z.ZodRawShape, Key extends keyof Shape> = Partial<
  Record<z.output<Shape[Key]> & string, ReadonlyArray<ReadonlyArray<keyof Shape & string>>>
>;

/**
 * An argument counts as supplied unless it is absent or an empty string. Form
 * clients send `""` for fields the user left alone, and every handler here
 * already treated a blank name or path as missing.
 */
function isSupplied(value: unknown): boolean {
  return value !== undefined && value !== '';
}

/** `a`, `a or b`, `a, b, or c`. */
function orList(names: readonly string[]): string {
  if (names.length < 3) return names.join(' or ');
  return `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`;
}

/**
 * Returns `schema` made strict, with its per-value requirements enforced and
 * advertised. `.strict()` is applied first so `tool()` keeps the `anyOf` meta
 * instead of strictening a clone that has none.
 *
 * A missing single argument is reported at its own path, which the framework
 * turns into a `Provide <name>.` hint. An either-of group is reported without a
 * path, so its message — naming every acceptable argument — becomes the hint.
 */
export function withActionRequirements<
  Shape extends z.ZodRawShape,
  Key extends keyof Shape & string,
>(schema: z.ZodObject<Shape>, key: Key, requirements: Requirements<Shape, Key>) {
  const table = requirements as Record<string, ReadonlyArray<ReadonlyArray<string>> | undefined>;
  const values = (schema.shape[key] as unknown as { options: readonly string[] }).options;

  /**
   * JSON Schema `required` is met by `""`, so a free-text string argument also
   * advertises `minLength: 1` — the blank `isSupplied` rejects. An enum already
   * excludes `""`, and no other type can hold one.
   */
  const nonBlank = (fields: readonly string[]) =>
    Object.fromEntries(
      fields
        .filter((field) => {
          const arg = (schema.shape as z.ZodRawShape)[field];
          return (arg instanceof z.ZodOptional ? arg.unwrap() : arg) instanceof z.ZodString;
        })
        .map((field) => [field, { minLength: 1 }]),
    );

  const branches: Record<string, unknown>[] = [];
  const unconstrained = values.filter((value) => !table[value]?.length);
  if (unconstrained.length > 0) {
    branches.push({
      type: 'object',
      properties: { [key]: { enum: unconstrained } },
      required: [key],
    });
  }
  for (const value of values) {
    const groups = table[value];
    if (!groups?.length) continue;
    const alternatives = groups
      .filter((group) => group.length > 1)
      .map((group) =>
        group.map((field) => {
          const properties = nonBlank([field]);
          return { type: 'object', required: [field], ...(field in properties && { properties }) };
        }),
      );
    const singles = groups.filter((group) => group.length === 1).map(([field]) => field as string);
    branches.push({
      type: 'object',
      properties: { [key]: { const: value }, ...nonBlank(singles) },
      required: [key, ...singles],
      ...(alternatives.length === 1 && { anyOf: alternatives[0] }),
      ...(alternatives.length > 1 && {
        allOf: alternatives.map((anyOf) => ({ type: 'object', anyOf })),
      }),
    });
  }

  return schema
    .strict()
    .superRefine((input, ctx) => {
      const args = input as Record<string, unknown>;
      const value = String(args[key]);
      for (const group of table[value] ?? []) {
        if (group.some((field) => isSupplied(args[field]))) continue;
        const [only] = group;
        ctx.addIssue(
          group.length === 1 && only !== undefined
            ? { code: 'custom', path: [only], message: `${only} is required for ${key}=${value}.` }
            : {
                code: 'custom',
                message: `${key}=${value} requires at least one of ${orList(group)}.`,
              },
        );
      }
    })
    .meta({ anyOf: branches });
}

/**
 * Narrows an argument the schema's per-action requirement already guarantees.
 * Reaching the throw means the handler ran without schema validation — a
 * programmer error, not a caller one.
 */
export function suppliedArg<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') {
    throw internalError(`${name} reached the handler unset despite its schema requirement.`);
  }
  return value;
}
