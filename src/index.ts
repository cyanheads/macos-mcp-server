#!/usr/bin/env node
/**
 * @fileoverview macos-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
// Resources
import { macosAudioDevicesResource } from './mcp-server/resources/definitions/macos-audio-devices.resource.js';
import { macosDisplaysResource } from './mcp-server/resources/definitions/macos-displays.resource.js';
import { macosSystemInfoResource } from './mcp-server/resources/definitions/macos-system-info.resource.js';
// Tools
import { macosCheckPermissions } from './mcp-server/tools/definitions/macos-check-permissions.tool.js';
import { macosControlAppearance } from './mcp-server/tools/definitions/macos-control-appearance.tool.js';
import { macosControlAudio } from './mcp-server/tools/definitions/macos-control-audio.tool.js';
import { macosControlSystem } from './mcp-server/tools/definitions/macos-control-system.tool.js';
import { macosControlVolume } from './mcp-server/tools/definitions/macos-control-volume.tool.js';
import { macosGetInfo } from './mcp-server/tools/definitions/macos-get-info.tool.js';
import { macosManageApps } from './mcp-server/tools/definitions/macos-manage-apps.tool.js';
import { macosManageDisplays } from './mcp-server/tools/definitions/macos-manage-displays.tool.js';
import { macosManageFinder } from './mcp-server/tools/definitions/macos-manage-finder.tool.js';
import { macosManageFocus } from './mcp-server/tools/definitions/macos-manage-focus.tool.js';
import { macosManageWindows } from './mcp-server/tools/definitions/macos-manage-windows.tool.js';
import { macosSendNotification } from './mcp-server/tools/definitions/macos-send-notification.tool.js';
import { macosTakeScreenshot } from './mcp-server/tools/definitions/macos-take-screenshot.tool.js';
// Services
import { initAudioService } from './services/audio/audio-service.js';
import { initDisplayService } from './services/display/display-service.js';
import { initOsascriptService } from './services/osascript/osascript-service.js';
import { initScreencaptureService } from './services/screencapture/screencapture-service.js';
import { initSystemInfoService } from './services/system-info/system-info-service.js';

await createApp({
  name: 'macos-mcp-server',
  title: 'macos-mcp-server',
  tools: [
    macosGetInfo,
    macosCheckPermissions,
    macosManageApps,
    macosControlVolume,
    macosSendNotification,
    macosControlAppearance,
    macosControlSystem,
    macosManageWindows,
    macosControlAudio,
    macosManageDisplays,
    macosTakeScreenshot,
    macosManageFinder,
    macosManageFocus,
  ],
  resources: [macosSystemInfoResource, macosAudioDevicesResource, macosDisplaysResource],
  prompts: [],
  setup(core) {
    initOsascriptService(core.config, core.storage);
    initSystemInfoService(core.config, core.storage);
    initAudioService(core.config, core.storage);
    initDisplayService(core.config, core.storage);
    initScreencaptureService(core.config, core.storage);
  },
  instructions:
    'macOS system controls server (local-only, stdio transport). ' +
    'Provides app lifecycle, window management, audio routing, display management, screenshots, Finder integration, notifications, and Focus mode control. ' +
    'Use macos_check_permissions first to confirm which permissions are granted before attempting window manipulation, screenshots, or Finder selection.',
});
