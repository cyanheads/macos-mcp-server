/**
 * @fileoverview Notification tool — post a macOS notification via Notification Center.
 * @module mcp-server/tools/definitions/macos-send-notification
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

export const macosSendNotification = tool('macos_send_notification', {
  title: 'Send macOS Notification',
  description:
    "Post a notification to macOS Notification Center via osascript. The notification appears immediately and uses the calling process's notification settings. Title is required; body, subtitle, and sound are optional. Each call creates a new notification (not idempotent). Do Not Disturb does not suppress notifications sent via osascript.",
  annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false },
  input: z.object({
    title: z.string().min(1).describe('Notification title (required).'),
    body: z.string().optional().describe('Notification body text.'),
    subtitle: z.string().optional().describe('Notification subtitle (appears below the title).'),
    sound: z
      .boolean()
      .optional()
      .describe('When true, plays the default notification sound. Defaults to false.'),
  }),
  output: z.object({
    success: z.boolean().describe('True when the notification was posted successfully.'),
  }),

  async handler(input, ctx) {
    const osascript = getOsascriptService();

    const bodyStr = JSON.stringify(input.body ?? '');
    const titleStr = JSON.stringify(input.title);
    const parts = [`display notification ${bodyStr} with title ${titleStr}`];
    if (input.subtitle) parts.push(`subtitle ${JSON.stringify(input.subtitle)}`);
    if (input.sound) parts.push('sound name "default"');

    await osascript.runAppleScript(parts.join(' '), ctx);

    ctx.log.info('macos_send_notification', { title: input.title });
    return { success: true };
  },

  format: (result) => [
    {
      type: 'text',
      text: `**Notification success:** ${result.success ? 'true — Posted to Notification Center' : 'false — Failed to post'}`,
    },
  ],
});
