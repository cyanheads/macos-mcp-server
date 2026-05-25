/**
 * @fileoverview Permission check tool — reports Accessibility, Screen Recording, Automation, and Notification status.
 * @module mcp-server/tools/definitions/macos-check-permissions
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tool, z } from '@cyanheads/mcp-ts-core';

const execFile = promisify(execFileCallback);

async function checkAccessibility(): Promise<boolean> {
  try {
    // Attempt to list processes via System Events — fails with permission error if denied
    await execFile(
      'osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        'Application("System Events").processes.whose({backgroundOnly: false}).name()',
      ],
      { timeout: 5_000 },
    );
    return true;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const msg = e.stderr ?? e.message ?? '';
    if (
      msg.includes('not allowed assistive access') ||
      msg.includes('-25211') ||
      msg.includes('-25212') ||
      msg.includes('Assistive access')
    ) {
      return false;
    }
    // Non-permission error — still accessible, just another issue
    return true;
  }
}

async function checkScreenRecording(): Promise<boolean> {
  try {
    // Use screencapture -x to /dev/null — non-zero exit with stderr about permissions when denied
    const result = await execFile('screencapture', ['-x', '-t', 'png', '/dev/null'], {
      timeout: 5_000,
    });
    // stderr mentions permissions if denied even on exit 0 (macOS 13+)
    const stderr = result.stderr ?? '';
    if (stderr.includes('permission') || stderr.includes('not granted')) return false;
    return true;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const msg = e.stderr ?? e.message ?? '';
    if (msg.includes('permission') || msg.includes('not granted')) return false;
    // Other failures don't indicate permission denial
    return true;
  }
}

async function checkAutomationFinder(): Promise<boolean> {
  try {
    await execFile('osascript', ['-e', 'tell application "Finder" to get name of desktop'], {
      timeout: 5_000,
    });
    return true;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const msg = e.stderr ?? e.message ?? '';
    if (
      msg.includes('not allowed to send Apple events') ||
      msg.includes('is not allowed') ||
      msg.includes('-1719') ||
      msg.includes('Not authorized')
    ) {
      return false;
    }
    return true;
  }
}

function checkNotifications(): boolean {
  // Notifications from osascript always work — macOS doesn't gate display notification
  return true;
}

async function getCallingProcess(): Promise<string> {
  try {
    const result = await execFile('ps', ['-o', 'comm=', '-p', String(process.ppid)], {
      timeout: 3_000,
    });
    const comm = (result.stdout ?? '').trim();
    return comm.split('/').pop() ?? (comm || 'unknown');
  } catch {
    return 'unknown';
  }
}

export const macosCheckPermissions = tool('macos_check_permissions', {
  title: 'Check macOS Permissions',
  description:
    'Reports which macOS permissions relevant to this server are currently granted for the calling process: Accessibility (required for window manipulation, app hide/show), Screen Recording (required for window screenshots), Automation > Finder (required for Finder selection), and Notifications. Use this tool before attempting operations that require elevated permissions to confirm prerequisites without triggering an OS permission prompt.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({}),
  output: z.object({
    accessibility: z.boolean().describe('True when Accessibility permission is granted.'),
    screen_recording: z.boolean().describe('True when Screen Recording permission is granted.'),
    automation_finder: z.boolean().describe('True when Automation > Finder permission is granted.'),
    notifications: z.boolean().describe('True when notifications can be posted via osascript.'),
    calling_process: z
      .string()
      .describe('Name of the process that launched this server (e.g. "ghostty", "node").'),
  }),

  async handler(_input, ctx) {
    ctx.log.info('macos_check_permissions');
    const [accessibility, screen_recording, automation_finder, notifications, calling_process] =
      await Promise.all([
        checkAccessibility(),
        checkScreenRecording(),
        checkAutomationFinder(),
        checkNotifications(),
        getCallingProcess(),
      ]);

    return { accessibility, screen_recording, automation_finder, notifications, calling_process };
  },

  format: (result) => {
    const check = (v: boolean) => (v ? '✓ Granted' : '✗ Denied');
    const lines = [
      '## macOS Permission Status',
      `**Calling Process:** ${result.calling_process}`,
      '',
      `**Accessibility:** ${check(result.accessibility)}`,
      `**Screen Recording:** ${check(result.screen_recording)}`,
      `**Automation > Finder:** ${check(result.automation_finder)}`,
      `**Notifications:** ${check(result.notifications)}`,
      '',
      '> To grant missing permissions: System Settings > Privacy & Security > [permission type]',
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
