/**
 * @fileoverview Server-specific environment configuration for macos-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  screenshotDir: z
    .string()
    .default('')
    .describe('Default directory for screenshot files. Defaults to ~/Desktop when empty.'),
  displayLayouts: z
    .string()
    .default('{}')
    .describe('JSON object mapping layout names to displayplacer argument strings.'),
});

let _config: ReturnType<typeof ServerConfigSchema.parse> | undefined;

export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    screenshotDir: 'MACOS_SCREENSHOT_DIR',
    displayLayouts: 'MACOS_DISPLAY_LAYOUTS',
  });
  return _config;
}
