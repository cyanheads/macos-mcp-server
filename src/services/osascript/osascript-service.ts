/**
 * @fileoverview Shared JXA/AppleScript runner with permission detection.
 * Wraps osascript subprocess execution with consistent security (argv arrays,
 * no shell interpolation) and structured error classification.
 * @module services/osascript/osascript-service
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  forbidden,
  internalError,
  JsonRpcErrorCode,
  McpError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { type OsascriptExclusion, runExclusive } from '@/services/osascript/osascript-exclusion.js';
import { execFailureDetail } from '@/utils/exec-failure.js';

const execFile = promisify(execFileCallback);

/** Result of running an osascript script. */
export interface OsascriptResult {
  stderr: string;
  stdout: string;
}

/** Options for runJxa / runAppleScript. */
export interface RunOptions {
  /**
   * The script's side of the NSScreen / process-enumeration exclusion
   * (`./osascript-exclusion.ts`): `process-enumeration` for every script that
   * enumerates System Events processes, `nsscreen-read` for every script that
   * reads NSScreen. The script waits while a run of the other side is in
   * flight, and the wait counts against `timeoutMs`.
   */
  exclusion?: OsascriptExclusion;
  /** Timeout in milliseconds. Default 10 000. */
  timeoutMs?: number;
}

/** Stderr fragments macOS prints when Automation (Apple events to another app) is denied. */
const AUTOMATION_DENIALS = [
  'is not allowed to send Apple events',
  'Not authorized to send Apple events',
  '(-1743)',
];

/**
 * Stderr fragments macOS prints when Accessibility (assistive access) is denied.
 * Matched by text, plus `-25211` (kAXErrorAPIDisabled), the one number that is a
 * denial on its own. A bare `-1719` is also errAEIllegalIndex ("Invalid index",
 * e.g. Finder with no window open) and `-25212` is kAXErrorNoValue, so neither
 * number alone is a denial.
 */
const ACCESSIBILITY_DENIALS = [
  'not allowed assistive access',
  'Assistive access is not',
  'Access for assistive devices',
  'Application is not permitted',
  '-25211',
];

/** Which Privacy & Security permission a failed script was denied, if any. */
type Denial = { kind: 'accessibility' } | { kind: 'automation'; target: string | undefined };

function classifyDenial(stderr: string): Denial | undefined {
  if (AUTOMATION_DENIALS.some((m) => stderr.includes(m))) {
    const target = stderr.match(/send Apple events to ([^\n(]+?)\.?\s*(?:\(-?\d+\)|$)/m)?.[1];
    return { kind: 'automation', target: target?.trim() || undefined };
  }
  if (ACCESSIBILITY_DENIALS.some((m) => stderr.includes(m))) return { kind: 'accessibility' };
  return;
}

/**
 * The AppleScript/JXA error line out of osascript's stderr — `execution error:
 * <text> (<number>)` or `syntax error: …` — without the script offsets that
 * precede it or the sandbox chatter Finder prints above it. Falls back to what
 * the process reported when no such line exists.
 */
function osascriptErrorText(err: unknown, stderr: string): string {
  const lines = stderr.split('\n').reverse();
  for (const line of lines) {
    const match = line.match(/(?:execution|syntax) error: .*/);
    if (match) return match[0].trim();
  }
  return execFailureDetail(err);
}

/**
 * A permission denial carrying the `accessibility_required` reason every tool
 * that runs osascript declares, worded for the permission that was actually
 * denied.
 */
function denialError(denial: Denial, text: string, cause: unknown): McpError {
  const [message, hint] =
    denial.kind === 'accessibility'
      ? [
          'Accessibility permission denied',
          'Grant Accessibility in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.',
        ]
      : [
          `Automation permission denied${denial.target ? ` for ${denial.target}` : ''}`,
          `Grant ${denial.target ? `Automation > ${denial.target}` : 'Automation'} permission in System Settings > Privacy & Security > Automation for your terminal or MCP host app.`,
        ];
  return forbidden(
    `${message}: ${text}`,
    { reason: 'accessibility_required', recovery: { hint } },
    { cause },
  );
}

export class OsascriptService {
  /**
   * Run a JXA (JavaScript for Automation) script.
   * NEVER interpolate raw user content into script — caller must use JSON.stringify
   * for any dynamic values within the JXA source.
   */
  runJxa(script: string, ctx: Context, opts: RunOptions = {}): Promise<OsascriptResult> {
    ctx.log.debug('runJxa', { scriptLen: script.length });
    return this.run(['-l', 'JavaScript', '-e', script], script, ctx, opts);
  }

  /**
   * Run a legacy AppleScript (non-JXA) script. Every caller string the script
   * embeds goes through `appleScriptLiteral()` (`./applescript-literal.ts`),
   * never `JSON.stringify`: AppleScript does not compile JSON's `\u`, `\b`, and
   * `\f` escapes.
   */
  runAppleScript(script: string, ctx: Context, opts: RunOptions = {}): Promise<OsascriptResult> {
    ctx.log.debug('runAppleScript', { scriptLen: script.length });
    return this.run(['-e', script], script, ctx, opts);
  }

  /** Runs the script, after taking its side of the exclusion when it has one. */
  private run(
    args: string[],
    script: string,
    ctx: Context,
    opts: RunOptions,
  ): Promise<OsascriptResult> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    if (opts.exclusion === undefined) return this.exec(args, script, ctx, timeoutMs, timeoutMs);
    return runExclusive(opts.exclusion, ctx.signal, timeoutMs, (remainingMs) =>
      this.exec(args, script, ctx, remainingMs, timeoutMs),
    );
  }

  /**
   * Runs osascript, killing it after `killAfterMs`, and classifies a failure: a
   * timeout (reported against the run's whole `timeoutMs`), a permission denial
   * (`accessibility_required`), or a generic failure carrying the AppleScript
   * error text and number. The caller's cancellation is rethrown as the abort
   * it raised, never classified. The script source never enters a thrown error;
   * it is logged at debug level only.
   */
  private async exec(
    args: string[],
    script: string,
    ctx: Context,
    killAfterMs: number,
    timeoutMs: number,
  ): Promise<OsascriptResult> {
    /**
     * Checked before the spawn as well as passed to it: Bun can still run a
     * child whose signal fired before the spawn, and a script may change state.
     */
    ctx.signal.throwIfAborted();
    try {
      // No shell: true — argv array only, no interpolation
      const result = await execFile(SYSTEM_BINARIES.osascript, args, {
        timeout: killAfterMs,
        signal: ctx.signal,
      });
      return { stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
    } catch (err: unknown) {
      if (ctx.signal.aborted) throw err;
      const e = err as { stderr?: string; killed?: boolean };
      const stderr = e.stderr ?? '';
      ctx.log.debug('osascript failed', { script, stderr });

      if (e.killed) {
        throw new McpError(JsonRpcErrorCode.Timeout, `osascript timed out after ${timeoutMs}ms`, {
          timeoutMs,
        });
      }
      const text = osascriptErrorText(err, stderr);
      const denial = classifyDenial(stderr);
      if (denial) throw denialError(denial, text, err);
      throw internalError(`osascript failed: ${text}`, undefined, { cause: err });
    }
  }
}

// --- Init/accessor pattern ---

let _service: OsascriptService | undefined;

export function initOsascriptService(_config: AppConfig, _storage: StorageService): void {
  _service = new OsascriptService();
}

export function getOsascriptService(): OsascriptService {
  if (!_service)
    throw new Error('OsascriptService not initialized — call initOsascriptService() in setup()');
  return _service;
}
