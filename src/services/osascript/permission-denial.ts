/**
 * @fileoverview Recognizes the permission denial OsascriptService raises.
 * @module services/osascript/permission-denial
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';

/**
 * True for the `accessibility_required` denial OsascriptService raises. Tools
 * that map osascript failures to their own reasons check this first, so a
 * denial keeps its reason instead of reading as a missing window or a refused
 * operation.
 */
export function isPermissionDenial(err: unknown): boolean {
  return (
    err instanceof McpError &&
    (err.data as { reason?: unknown } | undefined)?.reason === 'accessibility_required'
  );
}
