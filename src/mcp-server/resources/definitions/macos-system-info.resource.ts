/**
 * @fileoverview System info resource — thin wrapper over the system info service.
 * @module mcp-server/resources/definitions/macos-system-info
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getSystemInfoService } from '@/services/system-info/system-info-service.js';

export const macosSystemInfoResource = resource('macos://system/info', {
  name: 'macos-system-info',
  description:
    'Current macOS system snapshot: battery, power source, Wi-Fi SSID, hostname, version, uptime, display count.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    battery: z
      .object({
        level: z.number().describe('Battery charge level (0–100).'),
        charging: z.boolean().describe('True when charging.'),
        power_source: z.enum(['AC', 'Battery', 'UPS']).describe('Current power source.'),
      })
      .nullable()
      .describe('Battery info, or null on desktops with no battery.'),
    wifi: z
      .object({
        ssid: z.string().nullable().describe('Wi-Fi network name, or null when disconnected.'),
        connected: z.boolean().describe('True when connected to Wi-Fi.'),
      })
      .describe('Wi-Fi status.'),
    hostname: z.string().describe('Machine hostname.'),
    macos_version: z.string().describe('macOS version string.'),
    uptime_seconds: z.number().describe('Seconds since last boot.'),
    display_count: z.number().describe('Number of connected displays.'),
  }),

  async handler(_params, ctx) {
    return getSystemInfoService().getSystemInfo(ctx);
  },
});
