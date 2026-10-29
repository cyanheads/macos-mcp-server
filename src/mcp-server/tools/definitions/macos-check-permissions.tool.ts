/**
 * @fileoverview Permission check tool — reports Accessibility, Screen Recording, Automation > Finder, Automation > Music, and Notification status from Apple's prompt-free checks.
 * @module mcp-server/tools/definitions/macos-check-permissions
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import {
  checkAccessibility,
  checkAutomation,
  checkScreenRecording,
  type PermissionCheck,
} from '@/services/permissions/permission-probes.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';

const execFile = promisify(execFileCallback);

/** Why `notifications` is always null. */
const NOTIFICATIONS_UNKNOWN =
  'macOS offers no prompt-free check for notification permission; System Settings > Notifications shows which apps may post';

/** The parent process's name, or `unknown` when ps cannot tell; the caller's cancellation is rethrown. */
async function getCallingProcess(signal: AbortSignal): Promise<string> {
  try {
    const result = await execFile(SYSTEM_BINARIES.ps, ['-o', 'comm=', '-p', String(process.ppid)], {
      timeout: 3_000,
      signal,
    });
    const comm = (result.stdout ?? '').trim();
    return comm.split('/').pop() ?? (comm || 'unknown');
  } catch (err: unknown) {
    if (signal.aborted) throw err;
    return 'unknown';
  }
}

/** A check's field value: true granted, false not granted, null unknown. */
const fieldValue = (check: PermissionCheck): boolean | null =>
  check.status === 'unknown' ? null : check.status === 'granted';

/** The check's reason under `key` when it is unknown, nothing otherwise. */
const reasonEntry = <K extends string>(key: K, check: PermissionCheck) =>
  check.status === 'unknown' ? ({ [key]: check.reason } as Record<K, string>) : {};

export const macosCheckPermissions = tool('macos_check_permissions', {
  title: 'Check macOS Permissions',
  description:
    "Reports which macOS permissions this server relies on are granted to the calling process, read from Apple's prompt-free checks: Accessibility (every macos_manage_windows action, list included; macos_manage_apps hide and show, and the window_title frontmost reads; the ⌃⌘Q keystroke macos_control_system lock sends before it falls back to the screen saver), Screen Recording (window screenshots), Automation > Finder (macos_manage_finder frontmost_path, get_selection, and trash), and Automation > Music (macos_control_music). No check sends an Apple event to another app, captures the screen, or can show a permission prompt. Each field is true when granted, false when not, and null when the check cannot tell, with the reason in unknown_reasons: Automation > Finder and Automation > Music read null until macOS has asked for consent and while that app is not running. Notifications is always null, since macOS offers no prompt-free check for it. Call this before operations that need these permissions.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({}),
  output: z.object({
    accessibility: z
      .boolean()
      .nullable()
      .describe(
        'True when Accessibility is granted, false when it is not (denied or never asked), null when the check could not run (see unknown_reasons.accessibility).',
      ),
    screen_recording: z
      .boolean()
      .nullable()
      .describe(
        'True when Screen Recording is granted, false when it is not (denied or never asked), null when the check could not run (see unknown_reasons.screen_recording).',
      ),
    automation_finder: z
      .boolean()
      .nullable()
      .describe(
        'True when Automation > Finder is granted, false when it was denied, null when macOS has not asked yet, Finder is not running, or the check could not run (see unknown_reasons.automation_finder).',
      ),
    automation_music: z
      .boolean()
      .nullable()
      .describe(
        'True when Automation > Music is granted, false when it was denied, null when macOS has not asked yet, Music is not running, or the check could not run (see unknown_reasons.automation_music).',
      ),
    notifications: z
      .boolean()
      .nullable()
      .describe(
        'Always null: macOS offers no prompt-free check for notification permission (see unknown_reasons.notifications).',
      ),
    unknown_reasons: z
      .object({
        accessibility: z.string().optional().describe('Why accessibility is null.'),
        screen_recording: z.string().optional().describe('Why screen_recording is null.'),
        automation_finder: z.string().optional().describe('Why automation_finder is null.'),
        automation_music: z.string().optional().describe('Why automation_music is null.'),
        notifications: z.string().optional().describe('Why notifications is null.'),
      })
      .describe(
        'Why each null permission field is unknown, keyed by field name. A key is present exactly when its field is null.',
      ),
    calling_process: z
      .string()
      .describe('Name of the process that launched this server (e.g. "ghostty", "node").'),
  }),

  async handler(_input, ctx) {
    ctx.log.info('macos_check_permissions');
    const [accessibility, screen_recording, automation_finder, automation_music, calling_process] =
      await Promise.all([
        checkAccessibility(ctx),
        checkScreenRecording(ctx),
        checkAutomation('Finder', ctx),
        checkAutomation('Music', ctx),
        getCallingProcess(ctx.signal),
      ]);

    return {
      accessibility: fieldValue(accessibility),
      screen_recording: fieldValue(screen_recording),
      automation_finder: fieldValue(automation_finder),
      automation_music: fieldValue(automation_music),
      notifications: null,
      unknown_reasons: {
        ...reasonEntry('accessibility', accessibility),
        ...reasonEntry('screen_recording', screen_recording),
        ...reasonEntry('automation_finder', automation_finder),
        ...reasonEntry('automation_music', automation_music),
        notifications: NOTIFICATIONS_UNKNOWN,
      },
      calling_process,
    };
  },

  format: (result) => {
    const reasons = result.unknown_reasons;
    // A reason can carry osascript's error text, and the process name is whatever ps reports.
    const show = (value: boolean | null, reason: string | undefined) => {
      const state = value === null ? 'Unknown' : value ? '✓ Granted' : '✗ Not granted';
      return reason === undefined ? state : `${state} — ${markdownLiteral(reason)}`;
    };
    const lines = [
      '## macOS Permission Status',
      `**Calling Process:** ${markdownLiteral(result.calling_process)}`,
      '',
      `**Accessibility:** ${show(result.accessibility, reasons.accessibility)}`,
      `**Screen Recording:** ${show(result.screen_recording, reasons.screen_recording)}`,
      `**Automation > Finder:** ${show(result.automation_finder, reasons.automation_finder)}`,
      `**Automation > Music:** ${show(result.automation_music, reasons.automation_music)}`,
      `**Notifications:** ${show(result.notifications, reasons.notifications)}`,
      '',
      '> To grant missing permissions: System Settings > Privacy & Security > [permission type]',
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
