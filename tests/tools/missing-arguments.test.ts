/**
 * @fileoverview Per-action argument requirements across the tool surface.
 *
 * A conditionally-required argument that is missing (or blank) must be rejected
 * at argument validation — `-32602` with the framework's `invalid_arguments`
 * reason and a hint naming every acceptable argument — before any subprocess
 * runs, and the requirement must be advertised in each tool's `inputSchema` as
 * a root `anyOf` keyed on the discriminator.
 *
 * Every service is the real implementation; only `node:child_process` is
 * faked, so "no subprocess ran" is an assertion on the one seam every tool
 * shares.
 * @module tests/tools/missing-arguments.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ screenshotDir: '/tmp', displayLayouts: '{}' }),
}));

import { macosControlAppearance } from '@/mcp-server/tools/definitions/macos-control-appearance.tool.js';
import { macosControlAudio } from '@/mcp-server/tools/definitions/macos-control-audio.tool.js';
import { macosControlVolume } from '@/mcp-server/tools/definitions/macos-control-volume.tool.js';
import { macosManageApps } from '@/mcp-server/tools/definitions/macos-manage-apps.tool.js';
import { macosManageDisplays } from '@/mcp-server/tools/definitions/macos-manage-displays.tool.js';
import { macosManageFinder } from '@/mcp-server/tools/definitions/macos-manage-finder.tool.js';
import { macosManageFocus } from '@/mcp-server/tools/definitions/macos-manage-focus.tool.js';
import { macosManageWindows } from '@/mcp-server/tools/definitions/macos-manage-windows.tool.js';
import { macosTakeScreenshot } from '@/mcp-server/tools/definitions/macos-take-screenshot.tool.js';
import { initAudioService } from '@/services/audio/audio-service.js';
import { initDisplayService } from '@/services/display/display-service.js';
import { initOsascriptService } from '@/services/osascript/osascript-service.js';
import { initScreencaptureService } from '@/services/screencapture/screencapture-service.js';

type AnyTool = Parameters<typeof runToolContract>[0];
type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

function contentText(result: ToolResult): string {
  return (result.content ?? []).map((b) => ('text' in b ? String(b.text) : '')).join('\n');
}

function errorOf(result: ToolResult): {
  code?: number;
  message?: string;
  data?: { reason?: string; recovery?: { hint?: string } };
} {
  return (result.structuredContent as { error?: never } | undefined)?.error ?? {};
}

async function call(tool: AnyTool, args: Record<string, unknown>): Promise<ToolResult> {
  return runToolContract(tool, args as never);
}

/** A tool's input schema as JSON Schema, typed to the shape a test inspects. */
function inputJsonSchema<T>(tool: AnyTool): T {
  return z.toJSONSchema(tool.input, { io: 'input' }) as unknown as T;
}

/** Asserts the rejection shape and that the hint names every listed argument. */
function expectInvalidArguments(result: ToolResult, names: string[]): void {
  const error = errorOf(result);
  expect(result.isError).toBe(true);
  expect(error.code).toBe(-32602);
  expect(error.data?.reason).toBe('invalid_arguments');
  const hint = error.data?.recovery?.hint ?? '';
  for (const name of names) expect(hint).toContain(name);
  expect(contentText(result)).toContain('(reason invalid_arguments)');
}

beforeAll(() => {
  initOsascriptService({} as never, {} as never);
  initAudioService({} as never, {} as never);
  initDisplayService({} as never, {} as never);
  initScreencaptureService({} as never, {} as never);
});

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(null, { stdout: '', stderr: '' });
    return { pid: 1 };
  });
});

/** [tool, tool name, arguments, argument names the hint must carry] */
const MISSING: Array<[AnyTool, string, Record<string, unknown>, string[]]> = [
  [macosControlVolume, 'macos_control_volume', { action: 'set' }, ['level', 'muted']],
  [macosManageApps, 'macos_manage_apps', { action: 'launch' }, ['app_name', 'bundle_id']],
  [macosManageApps, 'macos_manage_apps', { action: 'quit' }, ['app_name']],
  [macosManageApps, 'macos_manage_apps', { action: 'force_quit' }, ['app_name']],
  [macosManageApps, 'macos_manage_apps', { action: 'hide' }, ['app_name']],
  [macosManageApps, 'macos_manage_apps', { action: 'show' }, ['app_name']],
  [macosManageWindows, 'macos_manage_windows', { action: 'focus' }, ['app_name', 'window_title']],
  [
    macosManageWindows,
    'macos_manage_windows',
    { action: 'move' },
    ['app_name', 'window_title', 'x', 'y'],
  ],
  [
    macosManageWindows,
    'macos_manage_windows',
    { action: 'resize' },
    ['app_name', 'window_title', 'width', 'height'],
  ],
  [
    macosManageWindows,
    'macos_manage_windows',
    { action: 'move_resize' },
    ['app_name', 'window_title', 'x', 'y', 'width', 'height'],
  ],
  [
    macosManageWindows,
    'macos_manage_windows',
    { action: 'minimize' },
    ['app_name', 'window_title'],
  ],
  [
    macosManageWindows,
    'macos_manage_windows',
    { action: 'fullscreen' },
    ['app_name', 'window_title'],
  ],
  [macosManageWindows, 'macos_manage_windows', { action: 'close' }, ['app_name', 'window_title']],
  [macosManageWindows, 'macos_manage_windows', { action: 'move', app_name: 'Finder' }, ['x', 'y']],
  [
    macosManageWindows,
    'macos_manage_windows',
    { action: 'resize', app_name: 'Finder' },
    ['width', 'height'],
  ],
  [
    macosManageWindows,
    'macos_manage_windows',
    { action: 'move_resize', app_name: 'Finder' },
    ['x', 'y', 'width', 'height'],
  ],
  [macosControlAudio, 'macos_control_audio', { action: 'switch_output' }, ['device']],
  [macosControlAudio, 'macos_control_audio', { action: 'switch_input' }, ['device']],
  [macosManageFinder, 'macos_manage_finder', { action: 'reveal' }, ['path']],
  [macosManageFinder, 'macos_manage_finder', { action: 'open_with' }, ['path']],
  [macosManageFinder, 'macos_manage_finder', { action: 'trash' }, ['path']],
  [macosManageDisplays, 'macos_manage_displays', { action: 'apply_layout' }, ['layout_name']],
  [macosManageFocus, 'macos_manage_focus', { action: 'set' }, ['mode']],
  [macosControlAppearance, 'macos_control_appearance', { action: 'set' }, ['mode']],
  [macosTakeScreenshot, 'macos_take_screenshot', { target: 'region' }, ['region']],
  [macosTakeScreenshot, 'macos_take_screenshot', { target: 'window' }, ['app_name']],
];

describe('missing per-action arguments are rejected at argument validation', () => {
  for (const [tool, name, args, names] of MISSING) {
    it(`${name} ${JSON.stringify(args)} → invalid_arguments naming ${names.join(', ')}, no subprocess`, async () => {
      const result = await call(tool, args);
      expectInvalidArguments(result, names);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }

  it('an either-of requirement is one pathless issue whose hint names both arguments', async () => {
    const result = await call(macosControlVolume, { action: 'set' });
    const hint = errorOf(result).data?.recovery?.hint ?? '';
    expect(hint).toMatch(/level/);
    expect(hint).toMatch(/muted/);
    expect(hint).not.toMatch(/^Provide level\.$/);
  });

  it('a single-field requirement names only that field', async () => {
    const result = await call(macosManageApps, { action: 'quit' });
    expect(errorOf(result).data?.recovery?.hint).toBe('Provide app_name.');
  });

  it('a blank string does not satisfy a requirement', async () => {
    const result = await call(macosManageApps, { action: 'quit', app_name: '' });
    expectInvalidArguments(result, ['app_name']);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a blank alternative does not satisfy an either-of requirement', async () => {
    const result = await call(macosManageApps, { action: 'launch', app_name: '', bundle_id: '' });
    expectInvalidArguments(result, ['app_name', 'bundle_id']);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('numeric bounds are enforced by the schema', () => {
  const REJECTED: Array<[AnyTool, string, Record<string, unknown>]> = [
    [macosTakeScreenshot, 'display_index -1', { target: 'display', display_index: -1 }],
    [macosTakeScreenshot, 'display_index 1.7', { target: 'display', display_index: 1.7 }],
    [
      macosTakeScreenshot,
      'region 0×0',
      { target: 'region', region: { x: 0, y: 0, width: 0, height: 0 } },
    ],
    [
      macosTakeScreenshot,
      'region -50×-50',
      { target: 'region', region: { x: 0, y: 0, width: -50, height: -50 } },
    ],
    [
      macosManageWindows,
      'windows resize width 0',
      { action: 'resize', app_name: 'Finder', width: 0, height: 600 },
    ],
    [
      macosManageWindows,
      'windows move_resize height -10',
      { action: 'move_resize', app_name: 'Finder', x: 0, y: 0, width: 800, height: -10 },
    ],
  ];

  for (const [tool, label, args] of REJECTED) {
    it(`${label} → invalid_arguments, no subprocess, no command line in the error`, async () => {
      const result = await call(tool, args);
      expectInvalidArguments(result, []);
      expect(execFileMock).not.toHaveBeenCalled();
      expect(contentText(result)).not.toContain('screencapture');
      expect(contentText(result)).not.toContain('Command failed');
    });
  }
});

describe('calls that were valid before stay valid', () => {
  it('volume get accepts an off-action level argument', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '40,false', stderr: '' });
      return { pid: 1 };
    });
    const result = await call(macosControlVolume, { action: 'get', level: 40 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ level: 40, muted: false });
  });

  it('volume set with only muted is accepted', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '40,true', stderr: '' });
      return { pid: 1 };
    });
    const result = await call(macosControlVolume, { action: 'set', muted: true });
    expect(result.isError).toBeFalsy();
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(['-e', 'set volume with output muted']);
  });

  it('apps list accepts an off-action app_name argument', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '[]', stderr: '' });
      return { pid: 1 };
    });
    const result = await call(macosManageApps, { action: 'list', app_name: 'Finder' });
    expect(result.isError).toBeFalsy();
  });

  it('screenshot target=display without display_index captures display 1 (index 0)', async () => {
    const result = await call(macosTakeScreenshot, {
      target: 'display',
      path: '/tmp/zz-nonexistent-dir-qx/shot.png',
    });
    const capture = execFileMock.mock.calls.find((c) => c[0] === 'screencapture');
    expect(capture?.[1]).toContain('-D1');
    // The fake screencapture writes nothing, so the post-capture check reports it.
    expect(errorOf(result).data?.reason).toBe('path_not_writable');
  });

  it('screenshot region keeps negative x/y (displays left of or above the primary)', async () => {
    const result = await call(macosTakeScreenshot, {
      target: 'region',
      region: { x: -1920, y: -200, width: 100, height: 50 },
      path: '/tmp/zz-nonexistent-dir-qx/shot.png',
    });
    const capture = execFileMock.mock.calls.find((c) => c[0] === 'screencapture');
    expect(capture?.[1]).toContain('-1920,-200,100,50');
    expect(errorOf(result).data?.reason).toBe('path_not_writable');
  });
});

describe('inputSchema advertises the per-action requirement', () => {
  /** Root property lists as they were before the requirement was added — must not change. */
  const ROOT_PROPERTIES: Array<[AnyTool, string, string, string[]]> = [
    [macosManageApps, 'macos_manage_apps', 'action', ['action', 'app_name', 'bundle_id', 'hidden']],
    [
      macosManageWindows,
      'macos_manage_windows',
      'action',
      [
        'action',
        'app_name',
        'window_title',
        'x',
        'y',
        'width',
        'height',
        'minimized',
        'fullscreen',
      ],
    ],
    [macosManageFinder, 'macos_manage_finder', 'action', ['action', 'path', 'app_name']],
    [macosControlAudio, 'macos_control_audio', 'action', ['action', 'device', 'type']],
    [macosControlVolume, 'macos_control_volume', 'action', ['action', 'level', 'muted']],
    [macosControlAppearance, 'macos_control_appearance', 'action', ['action', 'mode']],
    [macosManageFocus, 'macos_manage_focus', 'action', ['action', 'mode', 'enabled']],
    [macosManageDisplays, 'macos_manage_displays', 'action', ['action', 'layout_name']],
    [
      macosTakeScreenshot,
      'macos_take_screenshot',
      'target',
      ['target', 'app_name', 'display_index', 'region', 'path', 'include_data'],
    ],
  ];

  for (const [tool, name, key, properties] of ROOT_PROPERTIES) {
    it(`${name}: root properties unchanged, anyOf of typed object branches keyed on ${key}`, () => {
      const schema = z.toJSONSchema(tool.input, { io: 'input' }) as {
        type?: string;
        properties?: Record<string, unknown>;
        additionalProperties?: unknown;
        anyOf?: Array<{ type?: string; properties?: Record<string, unknown>; anyOf?: unknown[] }>;
      };
      expect(schema.type).toBe('object');
      expect(Object.keys(schema.properties ?? {})).toEqual(properties);
      expect(schema.additionalProperties).toBe(false);
      expect(schema.anyOf?.length).toBeGreaterThan(0);
      for (const branch of schema.anyOf ?? []) {
        expect(branch.type).toBe('object');
        expect(Object.keys(branch.properties ?? {})[0]).toBe(key);
        for (const alt of (branch.anyOf ?? []) as Array<{ type?: string }>) {
          expect(alt.type).toBe('object');
        }
      }
    });

    it(`${name}: a blank string fails the advertised requirement exactly where the refine rejects it`, () => {
      type Holder = { required?: string[]; properties?: Record<string, { minLength?: number }> };
      type Branch = Holder & { anyOf?: Holder[]; allOf?: Array<{ anyOf?: Holder[] }> };
      const schema = z.toJSONSchema(tool.input, { io: 'input' }) as {
        properties: Record<string, { type?: string; enum?: unknown[] }>;
        anyOf: Branch[];
      };
      /** Every place a branch requires an argument, paired with the object that requires it. */
      const requirements = schema.anyOf.flatMap((branch) =>
        [branch, ...(branch.anyOf ?? []), ...(branch.allOf ?? []).flatMap((a) => a.anyOf ?? [])]
          .flatMap((holder) => (holder.required ?? []).map((field) => ({ field, holder })))
          .filter(({ field }) => field !== key),
      );
      expect(requirements.length).toBeGreaterThan(0);
      for (const { field, holder } of requirements) {
        const root = schema.properties[field];
        const branchRejectsBlank = (holder.properties?.[field]?.minLength ?? 0) >= 1;
        if (root?.type !== 'string') {
          expect(branchRejectsBlank, `${field} is not a string`).toBe(false);
        } else if (root.enum) {
          expect(root.enum, `${field} enum`).not.toContain('');
        } else {
          expect(branchRejectsBlank, `${field} advertises minLength 1`).toBe(true);
        }
      }
    });
  }

  it('the volume set branch requires level or muted', () => {
    const schema = inputJsonSchema<{
      anyOf: Array<{ properties: { action: { const?: string } }; anyOf?: unknown[] }>;
    }>(macosControlVolume);
    const set = schema.anyOf.find((b) => b.properties.action.const === 'set');
    expect(set?.anyOf).toEqual([
      { type: 'object', required: ['level'] },
      { type: 'object', required: ['muted'] },
    ]);
  });

  it('the windows move branch requires a target plus x and y', () => {
    const schema = inputJsonSchema<{
      anyOf: Array<{
        properties: { action: { const?: string } };
        required?: string[];
        anyOf?: unknown[];
      }>;
    }>(macosManageWindows);
    const move = schema.anyOf.find((b) => b.properties.action.const === 'move');
    expect(move?.required).toEqual(['action', 'x', 'y']);
    expect(move?.anyOf).toEqual([
      { type: 'object', required: ['app_name'], properties: { app_name: { minLength: 1 } } },
      {
        type: 'object',
        required: ['window_title'],
        properties: { window_title: { minLength: 1 } },
      },
    ]);
  });

  it('display_index advertises a non-negative integer and says it defaults to 0', () => {
    const schema = inputJsonSchema<{
      properties: { display_index: { type?: string; minimum?: number; description?: string } };
    }>(macosTakeScreenshot);
    expect(schema.properties.display_index.type).toBe('integer');
    expect(schema.properties.display_index.minimum).toBe(0);
    expect(schema.properties.display_index.description).toMatch(/[Dd]efaults to 0/);
  });
});
