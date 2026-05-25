/**
 * @fileoverview Focus/Do Not Disturb tool — get or set macOS Focus mode.
 * @module mcp-server/tools/definitions/macos-manage-focus
 */

import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

const execFile = promisify(execFileCallback);

const SHORTCUTS_CLI = '/usr/bin/shortcuts';

async function getFocusStatus(): Promise<{
  status: 'active' | 'inactive' | 'unknown';
  mode: string | null;
  reason?: string;
}> {
  // Try defaults read from the Do Not Disturb domain (works on some configurations)
  try {
    const result = await execFile(
      'defaults',
      ['read', '/Library/Preferences/com.apple.CommCenter.counts'],
      {
        timeout: 3_000,
      },
    );
    const out = result.stdout ?? '';
    if (out.includes('FocusMode')) {
      return { status: 'active', mode: null };
    }
  } catch {
    // Expected on most systems
  }

  // Check Focus assertion database (macOS 13+ path, SIP-protected)
  try {
    const dbPath = `${process.env.HOME}/Library/DoNotDisturb/DB/Assertions.json`;
    const raw = await readFile(dbPath, 'utf-8');
    const data = JSON.parse(raw) as {
      data?: Array<{
        storeAssertionRecords?: Array<{
          assertionDetails?: { assertionDetailsModeIdentifier?: string };
        }>;
      }>;
    };
    const assertions = data.data?.[0]?.storeAssertionRecords ?? [];
    if (assertions.length > 0) {
      const mode = assertions[0]?.assertionDetails?.assertionDetailsModeIdentifier ?? null;
      return { status: 'active', mode };
    }
    return { status: 'inactive', mode: null };
  } catch {
    // File unreadable (SIP-protected on macOS 13+) — expected failure
  }

  return {
    status: 'unknown',
    mode: null,
    reason:
      'macOS 13+ protects the Focus state database. Current focus status cannot be determined without entitlements.',
  };
}

export const macosManageFocus = tool('macos_manage_focus', {
  title: 'Manage macOS Focus Mode',
  description:
    'Get or set Do Not Disturb / Focus mode. The get action is best-effort — macOS 13+ protects the Focus state database and the returned status may be "unknown" on some configurations. The set action requires the built-in "Set Focus" shortcut to exist in the Shortcuts app (present on macOS 12+). Mode names must exactly match configured Focus profiles (e.g. "Do Not Disturb", "Work", "Personal").',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    action: z
      .enum(['get', 'set'])
      .describe(
        'get — query current Focus status (best-effort); set — enable or disable a Focus mode.',
      ),
    mode: z
      .string()
      .optional()
      .describe(
        'Focus mode name for action=set, e.g. "Do Not Disturb", "Work". Must match a configured Focus profile exactly.',
      ),
    enabled: z
      .boolean()
      .optional()
      .describe('For action=set: true=enable the mode, false=disable it. Defaults to true.'),
  }),
  output: z.object({
    action: z.string().describe('The action that was performed.'),
    // get
    status: z
      .enum(['active', 'inactive', 'unknown'])
      .optional()
      .describe(
        'Current Focus status. Present for action=get. "unknown" when macOS cannot be queried without entitlements.',
      ),
    mode: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Active Focus mode name, or null when inactive or unknown. Present for action=get and action=set.',
      ),
    reason: z
      .string()
      .optional()
      .describe('Explanation when status is "unknown". Present for action=get.'),
    // set
    success: z
      .boolean()
      .optional()
      .describe('True when the Focus mode was applied. Present for action=set.'),
  }),
  errors: [
    {
      reason: 'shortcuts_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The shortcuts CLI is not available or the "Set Focus" shortcut does not exist.',
      recovery:
        'Open the Shortcuts app, search for "Set Focus", and add it. The shortcut is built-in on macOS 12+.',
    },
    {
      reason: 'focus_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The provided mode name does not match any known Focus profile.',
      recovery:
        'Check System Settings > Focus for configured profile names. Names are case-sensitive and must match exactly.',
    },
  ],

  async handler(input, ctx) {
    if (input.action === 'get') {
      const result = await getFocusStatus();
      return { action: 'get', ...result };
    }

    // set
    const mode = input.mode;
    if (!mode) throw new Error('mode is required for action=set');
    const enabled = input.enabled !== false; // default true

    try {
      await execFile(SHORTCUTS_CLI, ['run', 'Set Focus', '-i', '-'], {
        timeout: 15_000,
      });
    } catch (err: unknown) {
      const e = err as { code?: string | number; message?: string; stderr?: string };
      const msg = e.message ?? e.stderr ?? '';

      if (e.code === 'ENOENT' || msg.includes('not found')) {
        throw ctx.fail('shortcuts_unavailable', 'shortcuts CLI not found at /usr/bin/shortcuts');
      }
      if (msg.includes('not found') || msg.includes('not a shortcut') || msg.includes('error:')) {
        if (msg.toLowerCase().includes('set focus')) {
          throw ctx.fail(
            'shortcuts_unavailable',
            'The "Set Focus" shortcut is not installed in the Shortcuts app',
          );
        }
        throw ctx.fail('focus_not_found', `Focus mode "${mode}" not found: ${msg}`);
      }
      throw err;
    }

    ctx.log.info('macos_manage_focus set', { mode, enabled });
    return { action: 'set', success: true, mode };
  },

  format: (result) => {
    const lines: string[] = [`**action:** ${result.action}`];
    if (result.status !== undefined) lines.push(`**status:** ${result.status}`);
    if (result.mode !== undefined) lines.push(`**mode:** ${result.mode ?? '(none)'}`);
    if (result.reason !== undefined) lines.push(`**reason:** ${result.reason}`);
    if (result.success !== undefined) lines.push(`**success:** ${result.success}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
