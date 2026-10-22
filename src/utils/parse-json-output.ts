/**
 * @fileoverview Parses JSON text — a subprocess's output, or a file's contents
 * such as the Focus state file — through a schema.
 * @module utils/parse-json-output
 */

import type { z } from '@cyanheads/mcp-ts-core';

/**
 * `text` parsed as JSON and checked against `schema`, or undefined when it is
 * not JSON or not that shape. Callers treat both the same way, so they are not
 * told apart.
 */
export function parseJsonOutput<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
