/**
 * @fileoverview Tests for macos_manage_displays tool, through the real
 * DisplayService over a faked `execFile`: displayplacer prints a one-display
 * listing for `list` and nothing for a layout, and osascript prints the
 * NSScreen numbers the test sets. PATH holds only a temporary directory with an
 * executable `displayplacer`, so the lookup never depends on this host.
 * MACOS_DISPLAY_LAYOUTS comes from a stubbed server config.
 * @module tests/tools/macos-manage-displays.tool.test
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shape of the mocked `execFile`. Callers wrap it in `promisify`, and the module
 * mock carries no `util.promisify.custom` hook, so promisify takes the generic
 * path and resolves with the callback's second argument.
 */
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
  getServerConfig: vi.fn(),
}));

import { getServerConfig } from '@/config/server-config.js';
import { macosManageDisplays } from '@/mcp-server/tools/definitions/macos-manage-displays.tool.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { initDisplayService } from '@/services/display/display-service.js';
import { commonMarkBlocks } from '../helpers/commonmark.js';

/** The one directory on PATH, holding an executable `displayplacer` the fake answers for. */
const BIN_DIR = mkdtempSync('/tmp/macos-mcp-displays-');
const DISPLAYPLACER = join(BIN_DIR, 'displayplacer');
writeFileSync(DISPLAYPLACER, '');
chmodSync(DISPLAYPLACER, 0o755);

const CURRENT_CONFIG =
  'displayplacer "id:abc123 res:2560x1600 hz:60 color_depth:8 enabled:true scaling:on origin:(0,0) degree:0"';

/** `displayplacer list` (v1.4.0 layout) for one built-in display, Contextual screen id 1. */
const LISTING = [
  [
    'Persistent screen id: abc123',
    'Contextual screen id: 1',
    'Serial screen id: s00000001',
    'Type: MacBook built in screen',
    'Resolution: 2560x1600',
    'Hertz: 60',
    'Color Depth: 8',
    'Scaling: on',
    'Origin: (0,0) - main display',
    'Rotation: 0',
    'Enabled: true',
  ].join('\n'),
  'Execute the command below to set your screens to the current arrangement.',
  CURRENT_CONFIG,
].join('\n\n');

/** The display LISTING describes, without the index the NSScreen read adds. */
const DISPLAY = {
  id: 'abc123',
  type: 'MacBook built in screen',
  resolution: '2560x1600',
  hz: '60',
  origin: '(0,0)',
  rotation: '0',
  scaling: 'on',
  enabled: true,
};

/** Two layouts, each value in the quoted per-screen form current_config prints. */
const TWO_LAYOUTS = JSON.stringify({
  desk: '"id:abc123 res:2560x1600 origin:(0,0) degree:0"',
  travel: '"id:abc123 res:1512x982 origin:(0,0) degree:0"',
});

/** Each MACOS_DISPLAY_LAYOUTS value that is not a JSON object of non-empty strings, and what is wrong with it. */
const INVALID_LAYOUTS = [
  ['{not json', 'it is not valid JSON'],
  ['null', 'it is not a JSON object'],
  ['[]', 'it is not a JSON object'],
  ['"desk"', 'it is not a JSON object'],
  ['{"desk": ""}', 'layout "desk" is not a non-empty string'],
  ['{"desk": "   "}', 'layout "desk" is not a non-empty string'],
  ['{"desk": 3}', 'layout "desk" is not a non-empty string'],
  ['{"desk": "\\"id:abc\\"", "travel": null}', 'layout "travel" is not a non-empty string'],
] as const;

const INDEX_NOTICE =
  "index is omitted from every display: the NSScreen read failed (its output was not a JSON list of screen numbers). Retry macos_manage_displays action=list to get each display's index.";

const invalidLayoutsNotice = (problem: string) =>
  `MACOS_DISPLAY_LAYOUTS is invalid (${problem}), so layouts is omitted. Set it to a JSON object mapping each layout name to its displayplacer argument string.`;

/** The declared recovery of `reason`, as a failure without its own hint carries it. */
const recoveryOf = (reason: string) =>
  macosManageDisplays.errors?.find((e) => e.reason === reason)?.recovery;

function useLayouts(displayLayouts: string): void {
  vi.mocked(getServerConfig).mockReturnValue({ screenshotDir: '', displayLayouts });
}

/** displayplacer prints LISTING for `list` and nothing for a layout; osascript prints `screens`. */
function answer(screens: string): void {
  execFileMock.mockImplementation((cmd, args, _opts, cb) => {
    const stdout =
      cmd === SYSTEM_BINARIES.osascript ? screens : args[0] === 'list' ? `${LISTING}\n` : '';
    cb(null, { stdout, stderr: '' });
    return { pid: 1 };
  });
}

/** Every subprocess the call ran, program and argv, in order. */
const runs = () => execFileMock.mock.calls.map((c) => [c[0], c[1]]);

/** The text of each content block, in order. */
const blocksOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.content ?? []).map((b) => ('text' in b ? String(b.text) : `<${b.type}>`));

/**
 * The content blocks of a listing of DISPLAY at `index`: format()'s block, then
 * the enrichment trailer carrying `notice` when there is one.
 */
function listingBlocks(index: string | undefined, layouts?: string, notice?: string): string[] {
  const listing = [
    '**action:** list',
    '## Connected Displays (1)',
    `${index === undefined ? '' : `index: ${index} `}id: abc123 type: \`MacBook built in screen\` resolution: 2560x1600 hz: 60`,
    'origin: (0,0) rotation: 0 scaling: on enabled: true',
    '**current_config:**',
    '```',
    CURRENT_CONFIG,
    '```',
    ...(layouts === undefined ? [] : [`**layouts:** ${layouts}`]),
  ].join('\n');
  // Each notice here holds no backtick, so its code span is one backtick on each side.
  return notice === undefined ? [listing] : [listing, `\n\n> \`${notice}\``];
}

/** Values whose markdown would take effect, or whose line ending would change, if rendered raw. */
const MARKDOWN_VALUES = [
  'a`b`c',
  'x``y`z``w',
  '*not emphasis*',
  '[x](https://example.com)',
  '\\*kept\\*',
  'one\r\ntwo',
  'line\n# heading',
];

beforeEach(() => {
  vi.stubEnv('PATH', BIN_DIR);
  execFileMock.mockReset();
  initDisplayService({} as never, {} as never);
  answer('[1]\n');
  useLayouts('{}');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(BIN_DIR, { recursive: true, force: true });
});

describe('macosManageDisplays list', () => {
  it.each([
    {
      label: 'two configured layouts',
      layouts: TWO_LAYOUTS,
      screens: '[1]\n',
      structured: {
        action: 'list',
        displays: [{ index: 0, ...DISPLAY }],
        current_config: CURRENT_CONFIG,
        layouts: ['desk', 'travel'],
      },
      blocks: listingBlocks('0', '`desk`, `travel`'),
    },
    {
      label: 'no configured layouts',
      layouts: '{}',
      screens: '[1]\n',
      structured: {
        action: 'list',
        displays: [{ index: 0, ...DISPLAY }],
        current_config: CURRENT_CONFIG,
        layouts: [],
      },
      blocks: listingBlocks('0', '[]'),
    },
    {
      label: 'a display with no NSScreen entry',
      layouts: '{}',
      screens: '[]\n',
      structured: {
        action: 'list',
        displays: [{ index: null, ...DISPLAY }],
        current_config: CURRENT_CONFIG,
        layouts: [],
      },
      blocks: listingBlocks('null', '[]'),
    },
    {
      label: 'an NSScreen read that fails',
      layouts: '{}',
      screens: 'not json\n',
      structured: {
        action: 'list',
        displays: [DISPLAY],
        current_config: CURRENT_CONFIG,
        layouts: [],
        notice: INDEX_NOTICE,
      },
      blocks: listingBlocks(undefined, '[]', INDEX_NOTICE),
    },
    {
      label: 'an NSScreen read that fails, with invalid layouts',
      layouts: 'null',
      screens: 'not json\n',
      structured: {
        action: 'list',
        displays: [DISPLAY],
        current_config: CURRENT_CONFIG,
        notice: `${INDEX_NOTICE} ${invalidLayoutsNotice('it is not a JSON object')}`,
      },
      blocks: listingBlocks(
        undefined,
        undefined,
        `${INDEX_NOTICE} ${invalidLayoutsNotice('it is not a JSON object')}`,
      ),
    },
  ])(
    'list with $label reports the displays, index, layouts, and notice on both surfaces',
    async ({ layouts, screens, structured, blocks }) => {
      useLayouts(layouts);
      answer(screens);
      const result = await runToolContract(macosManageDisplays, { action: 'list' });
      expect(result.structuredContent).toEqual(structured);
      expect(blocksOf(result)).toEqual(blocks);
      expect(runs().map(([cmd, args]) => [cmd, (args as string[])[0]])).toEqual([
        [DISPLAYPLACER, 'list'],
        [SYSTEM_BINARIES.osascript, '-l'],
      ]);
    },
  );

  it.each([-1, 1.5, '0'])('output rejects index %j', (index) => {
    expect(() =>
      macosManageDisplays.output.parse({
        action: 'list',
        displays: [{ ...DISPLAY, index }],
        current_config: CURRENT_CONFIG,
        layouts: [],
      }),
    ).toThrow();
  });
});

describe('macosManageDisplays reads MACOS_DISPLAY_LAYOUTS', () => {
  it.each(INVALID_LAYOUTS)(
    'MACOS_DISPLAY_LAYOUTS=%s: apply_layout fails as layouts_invalid running nothing, and list omits layouts with a notice on both surfaces',
    async (raw, problem) => {
      useLayouts(raw);
      const applied = await runToolContract(macosManageDisplays, {
        action: 'apply_layout',
        layout_name: 'desk',
      });
      expect(applied.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ConfigurationError,
          message: `MACOS_DISPLAY_LAYOUTS is invalid (${problem}).`,
          data: { reason: 'layouts_invalid', recovery: { hint: recoveryOf('layouts_invalid') } },
        },
      });
      expect(execFileMock).not.toHaveBeenCalled();

      const listed = await runToolContract(macosManageDisplays, { action: 'list' });
      expect(listed.structuredContent).toEqual({
        action: 'list',
        displays: [{ index: 0, ...DISPLAY }],
        current_config: CURRENT_CONFIG,
        notice: invalidLayoutsNotice(problem),
      });
      expect(blocksOf(listed)).toEqual(
        listingBlocks('0', undefined, invalidLayoutsNotice(problem)),
      );
    },
  );

  it('apply_layout runs the named layout’s configured argument string as displayplacer’s argv and reports it on both surfaces', async () => {
    useLayouts(TWO_LAYOUTS);
    const result = await runToolContract(macosManageDisplays, {
      action: 'apply_layout',
      layout_name: 'travel',
    });
    expect(result.structuredContent).toEqual({
      action: 'apply_layout',
      success: true,
      layout_name: 'travel',
    });
    expect(blocksOf(result)).toEqual([
      '**action:** apply_layout\nlayout_name: `travel`\nsuccess: true',
    ]);
    expect(runs()).toEqual([[DISPLAYPLACER, ['id:abc123 res:1512x982 origin:(0,0) degree:0']]]);
  });

  const NAMED_HINT =
    'Configured layouts: "desk", "travel". Pass one as layout_name; macos_manage_displays action=list returns them as layouts.';
  it.each([
    ['two layouts', 'kitchen', TWO_LAYOUTS, NAMED_HINT],
    ['two layouts', 'toString', TWO_LAYOUTS, NAMED_HINT],
    ['two layouts', 'constructor', TWO_LAYOUTS, NAMED_HINT],
    ['two layouts', '__proto__', TWO_LAYOUTS, NAMED_HINT],
    ['two layouts', 'hasOwnProperty', TWO_LAYOUTS, NAMED_HINT],
    [
      'no layouts',
      'desk',
      '{}',
      'No layouts are configured: MACOS_DISPLAY_LAYOUTS defines none, and macos_manage_displays action=list returns layouts: [].',
    ],
  ])(
    'with %s configured, apply_layout "%s" is layout_not_found, names what is configured, and runs nothing',
    async (_label, name, layouts, hint) => {
      useLayouts(layouts);
      const result = await runToolContract(macosManageDisplays, {
        action: 'apply_layout',
        layout_name: name,
      });
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: `Layout "${name}" not found`,
          data: { reason: 'layout_not_found', recovery: { hint } },
        },
      });
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  /** A layout name holding a quote, a backslash, a line break, and a control character. */
  const ODD_NAME = 'de"s"k\\\n\u0001';

  it('layouts_invalid names a layout holding a quote, a backslash, or a control character as its JSON string', async () => {
    useLayouts(JSON.stringify({ [ODD_NAME]: '' }));
    const applied = await runToolContract(macosManageDisplays, {
      action: 'apply_layout',
      layout_name: 'desk',
    });
    expect(applied.structuredContent).toMatchObject({
      error: {
        message:
          'MACOS_DISPLAY_LAYOUTS is invalid (layout "de\\"s\\"k\\\\\\n\\u0001" is not a non-empty string).',
        data: { reason: 'layouts_invalid' },
      },
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('layout_not_found names the layout asked for and each configured one as its JSON string', async () => {
    useLayouts(JSON.stringify({ [ODD_NAME]: 'id:abc123' }));
    const result = await runToolContract(macosManageDisplays, {
      action: 'apply_layout',
      layout_name: 'kit"chen\u0007',
    });
    expect(result.structuredContent).toEqual({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: 'Layout "kit\\"chen\\u0007" not found',
        data: {
          reason: 'layout_not_found',
          recovery: {
            hint: 'Configured layouts: "de\\"s\\"k\\\\\\n\\u0001". Pass one as layout_name; macos_manage_displays action=list returns them as layouts.',
          },
        },
      },
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each(MARKDOWN_VALUES)(
    'list with layouts named %j reads the names, and a notice naming one, back from content[] exactly',
    async (value) => {
      useLayouts(JSON.stringify({ [value]: 'id:abc123', [`${value} 2`]: 'id:abc123' }));
      const listed = await runToolContract(macosManageDisplays, { action: 'list' });
      expect(listed.structuredContent).toMatchObject({ layouts: [value, `${value} 2`] });
      const blocks = commonMarkBlocks(blocksOf(listed).join('\n'));
      expect(blocks.at(-1)).toBe(`layouts: ${value}, ${value} 2`);

      const problem = `layout ${JSON.stringify(value)} is not a non-empty string`;
      useLayouts(JSON.stringify({ [value]: ' ' }));
      const invalid = await runToolContract(macosManageDisplays, { action: 'list' });
      expect(invalid.structuredContent).toMatchObject({ notice: invalidLayoutsNotice(problem) });
      expect(commonMarkBlocks(blocksOf(invalid).join('\n')).at(-1)).toBe(
        invalidLayoutsNotice(problem),
      );
    },
  );
});

describe('macosManageDisplays format renders upstream and configured text as literals', () => {
  it.each(MARKDOWN_VALUES)(
    'a display type, layout names, and an applied layout name holding %j read back exactly',
    (value) => {
      const text = (result: Parameters<NonNullable<typeof macosManageDisplays.format>>[0]) =>
        macosManageDisplays.format!(result)
          .map((b) => ('text' in b ? b.text : ''))
          .join('\n');
      const listed = text({
        action: 'list',
        displays: [{ index: 0, ...DISPLAY, type: value }],
        current_config: CURRENT_CONFIG,
        layouts: [value, `${value} 2`],
      });
      expect(commonMarkBlocks(listed)).toEqual([
        'action: list',
        'Connected Displays (1)',
        `index: 0 id: abc123 type: ${value} resolution: 2560x1600 hz: 60\norigin: (0,0) rotation: 0 scaling: on enabled: true\ncurrent_config:`,
        CURRENT_CONFIG,
        `layouts: ${value}, ${value} 2`,
      ]);
      const applied = text({ action: 'apply_layout', success: true, layout_name: value });
      expect(commonMarkBlocks(applied)).toEqual([
        `action: apply_layout\nlayout_name: ${value}\nsuccess: true`,
      ]);
    },
  );
});

describe('macosManageDisplays descriptions', () => {
  const display = macosManageDisplays.output.shape.displays.unwrap().element.shape;

  it.each([
    [
      'type',
      display.type.description,
      'How displayplacer describes the display: "MacBook built in screen" for a built-in panel, "<N> inch external screen" (the diagonal) for any other.',
    ],
    [
      'enabled',
      display.enabled.description,
      'True when the display is active or part of a mirroring set, so a display mirroring another reads true; false when it is disabled.',
    ],
    [
      'layout_name',
      macosManageDisplays.input.shape.layout_name.description,
      'Name of the display layout to apply for action=apply_layout: one of the names action=list returns as layouts.',
    ],
  ])('describes %s', (_field, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('names no connection type anywhere in the advertised output schema', () => {
    const advertised = JSON.stringify(z.toJSONSchema(macosManageDisplays.output));
    for (const absent of ['Built-In', 'DisplayPort', 'HDMI'])
      expect(advertised).not.toContain(absent);
  });

  it('declares displayplacer_not_found for every location searched, installing from homebrew/core', () => {
    expect(macosManageDisplays.errors?.find((e) => e.reason === 'displayplacer_not_found')).toEqual(
      {
        reason: 'displayplacer_not_found',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'The displayplacer CLI is not on PATH or in either Homebrew bin directory (/opt/homebrew/bin, /usr/local/bin).',
        recovery: 'Install with: brew install displayplacer',
        thrownBy: 'service',
      },
    );
    expect(macosManageDisplays.description).toBe(
      "List connected displays with their current layout (resolution, position, rotation, scaling) and each display's index, the display_index macos_take_screenshot and macos_manage_windows use, or apply a pre-configured display layout by name. Requires displayplacer CLI (brew install displayplacer). Layouts are pre-configured in the MACOS_DISPLAY_LAYOUTS environment variable as a JSON object mapping names to displayplacer argument strings; action=list returns their names as layouts. Layout application only accepts named presets — raw displayplacer args are never accepted from the user.",
    );
  });
});
