/**
 * @fileoverview System snapshot tool — battery, wifi, hostname, macOS version, uptime, display count.
 * @module mcp-server/tools/definitions/macos-get-info
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getSystemInfoService } from '@/services/system-info/system-info-service.js';

export const macosGetInfo = tool('macos_get_info', {
  title: 'Get macOS System Info',
  description:
    'Returns a snapshot of the current macOS system state: battery level and charging status, power source (AC/Battery), Wi-Fi SSID, hostname, macOS version, uptime in seconds, and connected display count. All fields reflect live system state at the time of the call.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({}),
  output: z.object({
    battery: z
      .object({
        level: z.number().describe('Battery charge level as a percentage (0–100).'),
        charging: z.boolean().describe('True when the battery is currently charging.'),
        power_source: z.enum(['AC', 'Battery', 'UPS']).describe('Current power source.'),
      })
      .nullable()
      .describe('Battery info, or null on desktops with no battery.'),
    wifi: z
      .object({
        ssid: z
          .string()
          .nullable()
          .describe('Connected Wi-Fi network name, or null when disconnected.'),
        connected: z.boolean().describe('True when connected to a Wi-Fi network.'),
      })
      .describe('Wi-Fi connection status.'),
    hostname: z.string().describe('Machine hostname.'),
    macos_version: z.string().describe('macOS product version string, e.g. "15.1.0".'),
    uptime_seconds: z.number().describe('Seconds since last boot.'),
    display_count: z.number().describe('Number of currently connected displays.'),
  }),

  async handler(_input, ctx) {
    const svc = getSystemInfoService();
    const info = await svc.getSystemInfo(ctx);
    ctx.log.info('macos_get_info', { version: info.macos_version, uptime: info.uptime_seconds });
    return info;
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push('## macOS System Info');
    lines.push(`**Hostname:** ${result.hostname}`);
    lines.push(`**macOS Version:** ${result.macos_version}`);
    lines.push(
      `**Uptime:** ${Math.floor(result.uptime_seconds / 3600)}h ${Math.floor((result.uptime_seconds % 3600) / 60)}m (${result.uptime_seconds}s)`,
    );
    lines.push(`**Displays:** ${result.display_count}`);

    lines.push('');
    lines.push('### Power');
    if (result.battery) {
      lines.push(
        `**Battery:** ${result.battery.level}% — ${result.battery.charging ? 'charging' : 'on battery'}`,
      );
      lines.push(`**Power Source:** ${result.battery.power_source}`);
    } else {
      lines.push('**Battery:** Not available (desktop or no battery)');
      lines.push('**Power Source:** AC');
    }

    lines.push('');
    lines.push('### Network');
    if (result.wifi.connected && result.wifi.ssid) {
      lines.push(`**Wi-Fi:** Connected to "${result.wifi.ssid}"`);
    } else {
      lines.push('**Wi-Fi:** Not connected');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
