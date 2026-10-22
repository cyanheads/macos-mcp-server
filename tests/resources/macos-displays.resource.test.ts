/**
 * @fileoverview Tests for the macos://displays resource — what its output
 * contract keeps of the display listing.
 * @module tests/resources/macos-displays.resource.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/display/display-service.js', () => ({
  getDisplayService: vi.fn(),
  initDisplayService: vi.fn(),
}));

import { macosDisplaysResource } from '@/mcp-server/resources/definitions/macos-displays.resource.js';
import { getDisplayService } from '@/services/display/display-service.js';

const builtIn = {
  index: 1,
  id: '22222222-2222-4222-8222-222222222222',
  type: 'MacBook built in screen',
  resolution: '1512x982',
  hz: '120',
  origin: '(3840,928)',
  rotation: '0',
  scaling: 'on',
  enabled: true,
};

const CURRENT_CONFIG =
  'displayplacer "id:22222222-2222-4222-8222-222222222222 res:1512x982 hz:120 color_depth:8 enabled:true scaling:on origin:(3840,928) degree:0"';

/** The resource's output as a client reads it: the handler's value through its output schema. */
async function read(listing: Record<string, unknown>): Promise<unknown> {
  vi.mocked(getDisplayService).mockReturnValue({
    listDisplays: vi.fn().mockResolvedValue(listing),
  } as never);
  const ctx = createMockContext({ uri: new URL('macos://displays') });
  return macosDisplaysResource.output!.parse(await macosDisplaysResource.handler({}, ctx));
}

describe('macos://displays', () => {
  it('keeps each display’s index: a position, or null for a display with no NSScreen entry', async () => {
    const listing = {
      displays: [builtIn, { ...builtIn, id: 'off', index: null, enabled: false }],
      current_config: CURRENT_CONFIG,
    };
    expect(await read(listing)).toEqual(listing);
  });

  it('keeps the notice that says why index is absent when the NSScreen read failed', async () => {
    const { index: _, ...withoutIndex } = builtIn;
    const listing = {
      displays: [withoutIndex],
      current_config: CURRENT_CONFIG,
      notice:
        "index is omitted from every display: the NSScreen read failed (osascript failed: terminated by SIGTERM). Retry macos_manage_displays action=list to get each display's index.",
    };
    expect(await read(listing)).toEqual(listing);
  });

  it('describes type with the values displayplacer prints, and enabled as also true when mirroring', () => {
    const advertised = JSON.stringify(z.toJSONSchema(macosDisplaysResource.output!));
    for (const absent of ['Built-In', 'DisplayPort', 'HDMI'])
      expect(advertised).not.toContain(absent);
    expect(advertised).toContain('MacBook built in screen');
    expect(advertised).toContain('a display mirroring another reads true');
  });
});
