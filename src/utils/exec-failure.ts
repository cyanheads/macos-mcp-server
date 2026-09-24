/**
 * @fileoverview Caller-safe description of a failed child process.
 *
 * Node's `execFile` rejection message opens with `Command failed: <cmd> <args>`,
 * and those args carry scripts, paths, and user input that must never reach a
 * caller-facing error. These helpers read only what the process itself
 * reported — its stderr, exit status, or terminating signal.
 * @module utils/exec-failure
 */

import { internalError, type McpError } from '@cyanheads/mcp-ts-core/errors';

/** The fields Node sets on an `execFile` rejection that are safe to surface. */
interface ExecRejection {
  code?: unknown;
  signal?: unknown;
  stderr?: unknown;
}

/** What the failed process reported: its trimmed stderr, else its exit status or signal. */
export function execFailureDetail(err: unknown): string {
  const { code, signal, stderr } = (err ?? {}) as ExecRejection;
  const text = typeof stderr === 'string' ? stderr.trim() : '';
  if (text) return text;
  if (typeof signal === 'string' && signal) return `terminated by ${signal}`;
  if (typeof code === 'number') return `exited with status ${code}`;
  if (typeof code === 'string' && code) return code;
  return 'unknown error';
}

/**
 * An `InternalError` for a child process that failed in a way no caller can act
 * on. The message names the program and what it printed; the original rejection
 * rides `cause` for the server log only.
 */
export function execFailure(program: string, err: unknown): McpError {
  return internalError(`${program} failed: ${execFailureDetail(err)}`, undefined, { cause: err });
}
