/**
 * @fileoverview System info resource — thin wrapper over the system info service.
 * @module mcp-server/resources/definitions/macos-system-info
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import {
  getSystemInfoService,
  SystemInfoSchema,
} from '@/services/system-info/system-info-service.js';

export const macosSystemInfoResource = resource('macos://system/info', {
  name: 'macos-system-info',
  description:
    'Current macOS system snapshot: battery, power source, Wi-Fi association and network name, hostname, version, uptime, display count. A field whose probe fails is null and named in `unavailable`.',
  mimeType: 'application/json',
  params: z.object({}),
  output: SystemInfoSchema,

  async handler(_params, ctx) {
    return await getSystemInfoService().getSystemInfo(ctx);
  },
});
