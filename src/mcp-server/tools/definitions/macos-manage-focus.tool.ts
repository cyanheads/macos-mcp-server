/**
 * @fileoverview Focus/Do Not Disturb tool — get or set macOS Focus mode.
 * @module mcp-server/tools/definitions/macos-manage-focus
 */

import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, timeout } from '@cyanheads/mcp-ts-core/errors';
import { suppliedArg, withActionRequirements } from '@/mcp-server/tools/action-requirements.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { execFailureDetail } from '@/utils/exec-failure.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';
import { parseJsonOutput } from '@/utils/parse-json-output.js';

const execFile = promisify(execFileCallback);

/**
 * The part of `~/Library/DoNotDisturb/DB/Assertions.json` the status is read
 * from: the first store's assertion records, each naming the Focus mode it holds.
 */
const FocusStateSchema = z.object({
  data: z
    .array(
      z.object({
        storeAssertionRecords: z
          .array(
            z.object({
              assertionDetails: z
                .object({ assertionDetailsModeIdentifier: z.string().optional() })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

const UNKNOWN_STATUS_REASON =
  'The Focus state file (~/Library/DoNotDisturb/DB/Assertions.json) could not be read or parsed, so the current Focus status is unknown.';

const SET_FOCUS_SHORTCUT = 'Set Focus';
const SET_TIMEOUT_MS = 15_000;

/** What the shortcuts CLI prints, curly apostrophes included, for a name not in the library. */
const NO_SUCH_SHORTCUT = 'Couldn’t find shortcut';

/**
 * Runs the Set Focus shortcut with `input` on stdin. `-i -` makes the CLI read
 * stdin before it resolves the shortcut, so stdin is closed right after the
 * write; left open, the call blocks until the timeout kills it. `signal`
 * aborting kills the run and rejects with Node's `AbortError`.
 */
function runSetFocusShortcut(input: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(
      SYSTEM_BINARIES.shortcuts,
      ['run', SET_FOCUS_SHORTCUT, '-i', '-'],
      { timeout: SET_TIMEOUT_MS, signal },
      (err) => (err ? reject(err) : resolve()),
    );
    // EPIPE when the child exits before reading its input; the exit callback reports the outcome.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/**
 * The Focus status, best effort: a read that fails reads as `unknown`. The
 * caller's cancellation is rethrown rather than read as a failed read.
 */
async function getFocusStatus(signal: AbortSignal): Promise<{
  status: 'active' | 'inactive' | 'unknown';
  mode: string | null;
  reason?: string;
}> {
  // Try defaults read from the Do Not Disturb domain (works on some configurations)
  try {
    const result = await execFile(
      SYSTEM_BINARIES.defaults,
      ['read', '/Library/Preferences/com.apple.CommCenter.counts'],
      { timeout: 3_000, signal },
    );
    const out = result.stdout ?? '';
    if (out.includes('FocusMode')) {
      return { status: 'active', mode: null };
    }
  } catch (err: unknown) {
    if (signal.aborted) throw err;
    // Expected on most systems
  }

  // Check the Focus assertion file, which the server process may not be able to read
  let raw: string | undefined;
  try {
    raw = await readFile(`${process.env.HOME}/Library/DoNotDisturb/DB/Assertions.json`, {
      encoding: 'utf-8',
      signal,
    });
  } catch (err: unknown) {
    if (signal.aborted) throw err;
  }
  // Unreadable, not JSON, or not that shape — the status is unknown, which get reports rather than throws
  const state = raw === undefined ? undefined : parseJsonOutput(FocusStateSchema, raw);
  if (!state) return { status: 'unknown', mode: null, reason: UNKNOWN_STATUS_REASON };

  const [first] = state.data?.[0]?.storeAssertionRecords ?? [];
  return first
    ? { status: 'active', mode: first.assertionDetails?.assertionDetailsModeIdentifier ?? null }
    : { status: 'inactive', mode: null };
}

export const macosManageFocus = tool('macos_manage_focus', {
  title: 'Manage macOS Focus Mode',
  description:
    'Get or set Do Not Disturb / Focus mode. The get action is best-effort: it reads the Focus state file in ~/Library/DoNotDisturb, which may be unreadable to the server process, and returns status "unknown" when that file cannot be read or parsed. The set action runs a shortcut named "Set Focus" from the Shortcuts library and passes {"mode": <mode>, "enabled": <enabled>} to it as JSON input. That shortcut is not built in: create it so it reads this input (e.g. with Get Dictionary from Input) and applies mode and enabled with the Set Focus action. Mode names must exactly match configured Focus names (e.g. "Do Not Disturb", "Work", "Personal").',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: withActionRequirements(
    z.object({
      action: z
        .enum(['get', 'set'])
        .describe(
          'get — query current Focus status (best-effort); set — enable or disable a Focus mode.',
        ),
      mode: z
        .string()
        .optional()
        .describe(
          'Focus mode name for action=set, e.g. "Do Not Disturb", "Work". Must match a configured Focus name exactly, including case.',
        ),
      enabled: z
        .boolean()
        .optional()
        .describe('For action=set: true=enable the mode, false=disable it. Defaults to true.'),
    }),
    'action',
    { set: [['mode']] },
  ),
  output: z.object({
    action: z.string().describe('The action that was performed.'),
    // get
    status: z
      .enum(['active', 'inactive', 'unknown'])
      .optional()
      .describe(
        'Current Focus status. Present for action=get. "unknown" when the Focus state file could not be read or parsed.',
      ),
    mode: z
      .string()
      .nullable()
      .optional()
      .describe(
        'For action=get: the active Focus mode, or null when inactive or unknown. For action=set: the requested mode, as sent to the shortcut.',
      ),
    reason: z
      .string()
      .optional()
      .describe('Explanation when status is "unknown". Present for action=get.'),
    // set
    enabled: z
      .boolean()
      .optional()
      .describe(
        'The requested state sent to the shortcut: true to turn the mode on, false to turn it off. Present for action=set.',
      ),
    success: z
      .boolean()
      .optional()
      .describe(
        'True when the "Set Focus" shortcut finished without error. The Focus state is not read back. Present for action=set.',
      ),
  }),
  errors: [
    {
      reason: 'shortcuts_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The shortcuts CLI is missing, or the Shortcuts library has no shortcut named "Set Focus".',
      recovery:
        'Create a shortcut named "Set Focus" in the Shortcuts app that reads its input with Get Dictionary from Input and applies the "mode" and "enabled" values with the Set Focus action.',
    },
    {
      reason: 'shortcut_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The "Set Focus" shortcut ran and exited with an error; the message carries its error text.',
      recovery:
        'Check that mode exactly matches a Focus name in System Settings > Focus, including case, and that the "Set Focus" shortcut reads its input as a dictionary with "mode" (text) and "enabled" (boolean) keys.',
    },
  ],

  async handler(input, ctx) {
    if (input.action === 'get') {
      const result = await getFocusStatus(ctx.signal);
      return { action: 'get', ...result };
    }

    // set
    const mode = suppliedArg(input.mode, 'mode');
    const enabled = input.enabled !== false; // default true

    // Before the spawn too: Bun can still run a child whose signal already fired.
    ctx.signal.throwIfAborted();
    try {
      await runSetFocusShortcut(JSON.stringify({ mode, enabled }), ctx.signal);
    } catch (err: unknown) {
      // The caller's cancellation, not a shortcut failure.
      if (ctx.signal.aborted) throw err;
      const e = err as { code?: unknown; killed?: boolean; stderr?: unknown };

      if (e.code === 'ENOENT') {
        throw ctx.fail(
          'shortcuts_unavailable',
          `shortcuts CLI not found at ${SYSTEM_BINARIES.shortcuts}`,
          undefined,
          { cause: err },
        );
      }
      if (typeof e.stderr === 'string' && e.stderr.includes(NO_SUCH_SHORTCUT)) {
        throw ctx.fail(
          'shortcuts_unavailable',
          `The Shortcuts library has no shortcut named "${SET_FOCUS_SHORTCUT}".`,
          undefined,
          { cause: err },
        );
      }
      if (e.killed) {
        throw timeout(
          `The "${SET_FOCUS_SHORTCUT}" shortcut did not finish within ${SET_TIMEOUT_MS}ms and was stopped; check that it does not wait for a prompt or for input.`,
          { timeoutMs: SET_TIMEOUT_MS },
          { cause: err },
        );
      }
      throw ctx.fail(
        'shortcut_failed',
        `The "${SET_FOCUS_SHORTCUT}" shortcut failed: ${execFailureDetail(err)}`,
        undefined,
        { cause: err },
      );
    }

    ctx.log.info('macos_manage_focus set', { mode, enabled });
    return { action: 'set', success: true, mode, enabled };
  },

  format: (result) => {
    const lines: string[] = [`**action:** ${result.action}`];
    if (result.status !== undefined) lines.push(`**status:** ${result.status}`);
    // A mode is the Focus state file's identifier or the caller's own text, so it renders as a literal.
    if (result.mode !== undefined) {
      lines.push(`**mode:** ${result.mode === null ? '(none)' : markdownLiteral(result.mode)}`);
    }
    // The reason is this server's own fixed sentence, which carries no markup.
    if (result.reason !== undefined) lines.push(`**reason:** ${result.reason}`);
    if (result.enabled !== undefined) lines.push(`**enabled:** ${result.enabled}`);
    if (result.success !== undefined) lines.push(`**success:** ${result.success}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
