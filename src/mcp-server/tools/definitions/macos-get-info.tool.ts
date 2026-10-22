/**
 * @fileoverview System snapshot tool — battery, wifi, hostname, macOS version, uptime, display count.
 * @module mcp-server/tools/definitions/macos-get-info
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  getSystemInfoService,
  type SystemInfo,
  SystemInfoSchema,
} from '@/services/system-info/system-info-service.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';

const PROBE_FAILED = 'unavailable (probe failed)';

function wifiLine({ wifi, unavailable }: SystemInfo): string {
  if (!wifi) return PROBE_FAILED;
  if (!wifi.connected) return 'Not connected';
  // A literal, so markdown in the network name reads back as the name itself.
  if (wifi.ssid !== null) return `Connected to ${markdownLiteral(wifi.ssid)}`;
  return unavailable.includes('wifi.ssid')
    ? 'Connected (network name unavailable: probe failed)'
    : 'Connected (network name withheld by macOS; reading it requires Location Services access for the host app)';
}

export const macosGetInfo = tool('macos_get_info', {
  title: 'Get macOS System Info',
  description:
    'Returns a snapshot of the current macOS system state: battery level, charging state, and power source (AC/Battery/UPS), Wi-Fi association and network name, hostname, macOS version, uptime in seconds, and connected display count. All fields reflect live system state at the time of the call. A field whose probe fails is null and named in `unavailable`, never filled with a guess. macOS withholds the Wi-Fi network name from an app without Location Services access; a connected Mac then reports `connected: true` with `ssid: null`.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({}),
  output: SystemInfoSchema,

  async handler(_input, ctx) {
    const svc = getSystemInfoService();
    const info = await svc.getSystemInfo(ctx);
    ctx.log.info('macos_get_info', {
      version: info.macos_version,
      uptime: info.uptime_seconds,
      unavailable: info.unavailable,
    });
    return info;
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push('## macOS System Info');
    lines.push(`**Hostname:** ${markdownLiteral(result.hostname)}`);
    lines.push(`**macOS Version:** ${result.macos_version ?? PROBE_FAILED}`);
    lines.push(
      `**Uptime:** ${Math.floor(result.uptime_seconds / 3600)}h ${Math.floor((result.uptime_seconds % 3600) / 60)}m (${result.uptime_seconds}s)`,
    );
    lines.push(`**Displays:** ${result.display_count ?? PROBE_FAILED}`);

    lines.push('');
    lines.push('### Power');
    if (result.battery) {
      /**
       * `charging` and `power_source` are independent facts: pmset reports
       * `charged` for a full battery on AC, which is neither charging nor
       * running on battery. Deriving the label from `charging` alone printed
       * "on battery" directly above "Power Source: AC".
       */
      const state = result.battery.charging
        ? 'charging'
        : result.battery.power_source === 'Battery'
          ? 'on battery'
          : 'not charging';
      lines.push(`**Battery:** ${result.battery.level}% — ${state}`);
      lines.push(`**Power Source:** ${result.battery.power_source}`);
    } else if (result.unavailable.includes('battery')) {
      lines.push(`**Battery:** ${PROBE_FAILED}`);
    } else {
      lines.push('**Battery:** None (this Mac reports no battery)');
    }

    lines.push('');
    lines.push('### Network');
    lines.push(`**Wi-Fi:** ${wifiLine(result)}`);

    // Field paths this server names, which carry no markup.
    lines.push('');
    lines.push(
      `**Unavailable:** ${result.unavailable.length > 0 ? result.unavailable.join(', ') : '[]'}`,
    );

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
