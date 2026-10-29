/**
 * @fileoverview Pins the MCP annotations every registered tool advertises.
 * A write tool that omits destructiveHint reads as destructive (the MCP
 * default), so each one states it: true only where an action can lose data
 * the user can't restore.
 * @module tests/tools/tool-annotations.test
 */

import { describe, expect, it } from 'vitest';
import { macosCheckPermissions } from '@/mcp-server/tools/definitions/macos-check-permissions.tool.js';
import { macosControlAppearance } from '@/mcp-server/tools/definitions/macos-control-appearance.tool.js';
import { macosControlAudio } from '@/mcp-server/tools/definitions/macos-control-audio.tool.js';
import { macosControlMusic } from '@/mcp-server/tools/definitions/macos-control-music.tool.js';
import { macosControlSystem } from '@/mcp-server/tools/definitions/macos-control-system.tool.js';
import { macosControlVolume } from '@/mcp-server/tools/definitions/macos-control-volume.tool.js';
import { macosGetInfo } from '@/mcp-server/tools/definitions/macos-get-info.tool.js';
import { macosManageApps } from '@/mcp-server/tools/definitions/macos-manage-apps.tool.js';
import { macosManageDisplays } from '@/mcp-server/tools/definitions/macos-manage-displays.tool.js';
import { macosManageFinder } from '@/mcp-server/tools/definitions/macos-manage-finder.tool.js';
import { macosManageFocus } from '@/mcp-server/tools/definitions/macos-manage-focus.tool.js';
import { macosManageWindows } from '@/mcp-server/tools/definitions/macos-manage-windows.tool.js';
import { macosSendNotification } from '@/mcp-server/tools/definitions/macos-send-notification.tool.js';
import { macosTakeScreenshot } from '@/mcp-server/tools/definitions/macos-take-screenshot.tool.js';

const readOnly = { readOnlyHint: true, openWorldHint: false };
const benignWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const destructiveWrite = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const expected = [
  [macosGetInfo, readOnly],
  [macosCheckPermissions, readOnly],
  [macosManageApps, destructiveWrite], // force_quit discards unsaved work
  [macosManageWindows, destructiveWrite], // close
  [macosManageFinder, destructiveWrite], // trash
  [macosTakeScreenshot, destructiveWrite], // overwrite: true replaces a file
  [macosControlVolume, benignWrite],
  [macosControlAudio, benignWrite],
  [macosControlAppearance, benignWrite],
  [macosControlSystem, benignWrite],
  [macosControlMusic, benignWrite],
  [macosManageDisplays, benignWrite],
  [macosManageFocus, benignWrite],
  [macosSendNotification, { ...benignWrite, idempotentHint: false }],
] as const;

describe('tool annotations', () => {
  it.each(expected.map(([def, annotations]) => [def.name, def, annotations] as const))(
    '%s',
    (_name, def, annotations) => {
      expect(def.annotations).toStrictEqual(annotations);
    },
  );
});
