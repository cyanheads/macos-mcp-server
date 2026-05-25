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
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';

const execFile = promisify(execFileCallback);

/** Result of running an osascript script. */
export interface OsascriptResult {
  stderr: string;
  stdout: string;
}

/** Options for runJxa / runAppleScript. */
export interface RunOptions {
  /** Timeout in milliseconds. Default 10 000. */
  timeoutMs?: number;
}

/**
 * Detects whether the given stderr/error message indicates a permission denial.
 * Works for both Accessibility and Automation errors.
 */
function isPermissionError(msg: string): boolean {
  return (
    msg.includes('not allowed assistive access') ||
    msg.includes('Assistive access is not') ||
    msg.includes('-25211') || // AXError: kAXErrorAPIDisabled
    msg.includes('-1719') || // AppleScript: not authorized
    msg.includes('is not allowed to send Apple events') ||
    msg.includes('Access for assistive devices') ||
    msg.includes('Application is not permitted') ||
    msg.includes('-25212') ||
    msg.includes('Not authorized to send Apple events')
  );
}

export class OsascriptService {
  /**
   * Run a JXA (JavaScript for Automation) script.
   * NEVER interpolate raw user content into script — caller must use JSON.stringify
   * for any dynamic values within the JXA source.
   */
  async runJxa(script: string, ctx: Context, opts: RunOptions = {}): Promise<OsascriptResult> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    ctx.log.debug('runJxa', { scriptLen: script.length });

    let stdout = '';
    let stderr = '';
    try {
      const result = await execFile('osascript', ['-l', 'JavaScript', '-e', script], {
        timeout: timeoutMs,
        // No shell: true — argv array only, no interpolation
      });
      stdout = result.stdout ?? '';
      stderr = result.stderr ?? '';
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
      const msg = stderr || e.message || '';

      if (e.killed) {
        throw new McpError(JsonRpcErrorCode.Timeout, `osascript timed out after ${timeoutMs}ms`, {
          timeoutMs,
        });
      }
      if (isPermissionError(msg)) {
        throw new McpError(
          JsonRpcErrorCode.Forbidden,
          `Accessibility permission denied. ${msg.trim()}`,
          {
            recovery: {
              hint: 'Grant Accessibility in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.',
            },
          },
        );
      }
      // Surface stderr as error message for other failures
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `osascript failed: ${msg.trim() || 'unknown error'}`,
        { script: script.slice(0, 200) },
      );
    }

    return { stdout: stdout.trim(), stderr: stderr.trim() };
  }

  /**
   * Run a legacy AppleScript (non-JXA) script.
   * Caller is responsible for escaping any dynamic values before passing in.
   */
  async runAppleScript(
    script: string,
    ctx: Context,
    opts: RunOptions = {},
  ): Promise<OsascriptResult> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    ctx.log.debug('runAppleScript', { scriptLen: script.length });

    let stdout = '';
    let stderr = '';
    try {
      const result = await execFile('osascript', ['-e', script], {
        timeout: timeoutMs,
      });
      stdout = result.stdout ?? '';
      stderr = result.stderr ?? '';
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
      const msg = stderr || e.message || '';

      if (e.killed) {
        throw new McpError(JsonRpcErrorCode.Timeout, `osascript timed out after ${timeoutMs}ms`, {
          timeoutMs,
        });
      }
      if (isPermissionError(msg)) {
        throw new McpError(JsonRpcErrorCode.Forbidden, `Permission denied. ${msg.trim()}`, {
          recovery: {
            hint: 'Grant the required permission in System Settings > Privacy & Security.',
          },
        });
      }
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `osascript failed: ${msg.trim() || 'unknown error'}`,
        { script: script.slice(0, 200) },
      );
    }

    return { stdout: stdout.trim(), stderr: stderr.trim() };
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
