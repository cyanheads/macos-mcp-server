/**
 * @fileoverview Tests for the macos_get_info tool and the macos://system/info
 * resource: format() over each power and Wi-Fi state, and the real service
 * over faked probes through the tool contract — failed probes, a desktop, a
 * withheld Wi-Fi network name, and cancellation.
 * @module tests/tools/macos-get-info.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  hostname: () => 'studio.local',
  uptime: () => 7_260.4,
}));

import { macosSystemInfoResource } from '@/mcp-server/resources/definitions/macos-system-info.resource.js';
import { macosGetInfo } from '@/mcp-server/tools/definitions/macos-get-info.tool.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import {
  initSystemInfoService,
  type SystemInfo,
} from '@/services/system-info/system-info-service.js';
import { commonMarkBlocks } from '../helpers/commonmark.js';

const mockSystemInfo: SystemInfo = {
  battery: { level: 85, charging: true, power_source: 'AC' },
  wifi: { ssid: 'HomeNetwork', connected: true },
  hostname: 'my-macbook.local',
  macos_version: '15.1.0',
  uptime_seconds: 3600,
  display_count: 1,
  unavailable: [],
};

function formatLines(info: SystemInfo): string[] {
  return macosGetInfo.format!(info).flatMap((b) => ('text' in b ? b.text.split('\n') : []));
}

function contentLines(result: { content?: Array<{ type: string; text?: string }> }): string[] {
  return (result.content ?? []).flatMap((b) => (b.text ? b.text.split('\n') : []));
}

describe('macosGetInfo format', () => {
  it('renders every field of a charging laptop on Wi-Fi, with an empty Unavailable list', () => {
    expect(formatLines(mockSystemInfo)).toEqual([
      '## macOS System Info',
      '**Hostname:** `my-macbook.local`',
      '**macOS Version:** 15.1.0',
      '**Uptime:** 1h 0m (3600s)',
      '**Displays:** 1',
      '',
      '### Power',
      '**Battery:** 85% — charging',
      '**Power Source:** AC',
      '',
      '### Network',
      '**Wi-Fi:** Connected to `HomeNetwork`',
      '',
      '**Unavailable:** []',
    ]);
  });

  /** Values whose markdown would take effect, or whose line ending would change, if rendered raw. */
  it.each([
    'a`b`c',
    'x``y`z``w',
    '*not emphasis*',
    '[x](https://example.com)',
    '\\*kept\\*',
    'one\r\ntwo',
    'line\n# heading',
  ])(
    'a hostname and network name holding %j read back exactly as the result carries them',
    (value) => {
      const info: SystemInfo = {
        ...mockSystemInfo,
        hostname: value,
        wifi: { connected: true, ssid: value },
      };
      const text = formatLines(info).join('\n');
      expect(commonMarkBlocks(text)).toEqual([
        'macOS System Info',
        `Hostname: ${value}\nmacOS Version: 15.1.0\nUptime: 1h 0m (3600s)\nDisplays: 1`,
        'Power',
        'Battery: 85% — charging\nPower Source: AC',
        'Network',
        `Wi-Fi: Connected to ${value}`,
        'Unavailable: []',
      ]);
    },
  );

  it.each<[string, Partial<SystemInfo>, string[]]>([
    [
      'a discharging battery as on battery',
      { battery: { level: 62, charging: false, power_source: 'Battery' } },
      ['**Battery:** 62% — on battery', '**Power Source:** Battery'],
    ],
    [
      'a failed network-name probe as unavailable, not withheld',
      { wifi: { connected: true, ssid: null }, unavailable: ['wifi.ssid'] },
      [
        '**Wi-Fi:** Connected (network name unavailable: probe failed)',
        '**Unavailable:** wifi.ssid',
      ],
    ],
    [
      'a disconnected Mac',
      { wifi: { connected: false, ssid: null } },
      ['**Wi-Fi:** Not connected'],
    ],
    ['a headless Mac as 0 displays', { display_count: 0 }, ['**Displays:** 0']],
  ])('renders %s', (_label, override, expected) => {
    const lines = formatLines({ ...mockSystemInfo, ...override });
    for (const line of expected) expect(lines).toContain(line);
  });
});

// --- The real service through the tool contract, over mocked probes ---

const key = (cmd: string, args: string[]) => [cmd, ...args].join(' ');

/** Probe output as the MacBook Pro this repo is tested on prints it, Ethernet addresses replaced. */
const PROBES: Record<string, string> = {
  [key(SYSTEM_BINARIES.pmset, ['-g', 'batt'])]:
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=27328611)\t80%; AC attached; not charging present: true\n",
  [key(SYSTEM_BINARIES.networksetup, ['-listallhardwareports'])]:
    '\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 02:00:00:00:00:01\n\nVLAN Configurations\n===================\n',
  [key(SYSTEM_BINARIES.ifconfig, ['-v'])]:
    'en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500 index 15\n\tmedia: autoselect\n\tstatus: active\n\ttype: Wi-Fi\n',
  [key(SYSTEM_BINARIES.networksetup, ['-getairportnetwork', 'en0'])]:
    'You are not associated with an AirPort network.\n',
  [key(SYSTEM_BINARIES.sw_vers, ['-productVersion'])]: '27.0.1\n',
  [key(SYSTEM_BINARIES.system_profiler, ['-json', 'SPDisplaysDataType', '-detailLevel', 'mini'])]:
    JSON.stringify({
      SPDisplaysDataType: [{ _name: 'Apple M2 Max', spdisplays_ndrvs: [{ _name: 'Color LCD' }] }],
    }),
};

/**
 * Answer each probe from `table`; a probe missing from it fails as a missing
 * binary would, and a run whose signal has fired rejects with an AbortError.
 */
function mockProbes(table: Record<string, string>): void {
  execFileMock.mockReset();
  execFileMock.mockImplementation((cmd, args, opts, cb) => {
    const out = table[key(cmd, args)];
    if ((opts as { signal?: AbortSignal }).signal?.aborted) {
      cb(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    } else if (out === undefined) {
      cb(Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
    } else {
      cb(null, { stdout: out, stderr: '' });
    }
    return { pid: 1 };
  });
}

beforeEach(() => {
  initSystemInfoService({} as never, {} as never);
});

describe('macosGetInfo through the tool contract', () => {
  it('reports every failed probe as null and unavailable on both surfaces', async () => {
    mockProbes({});
    const result = await runToolContract(macosGetInfo, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      battery: null,
      wifi: null,
      hostname: 'studio.local',
      macos_version: null,
      uptime_seconds: 7_260,
      display_count: null,
      unavailable: ['battery', 'wifi', 'macos_version', 'display_count'],
    });
    const lines = contentLines(result);
    expect(lines).toEqual([
      '## macOS System Info',
      '**Hostname:** `studio.local`',
      '**macOS Version:** unavailable (probe failed)',
      '**Uptime:** 2h 1m (7260s)',
      '**Displays:** unavailable (probe failed)',
      '',
      '### Power',
      '**Battery:** unavailable (probe failed)',
      '',
      '### Network',
      '**Wi-Fi:** unavailable (probe failed)',
      '',
      '**Unavailable:** battery, wifi, macos_version, display_count',
    ]);
    // The field paths' underscores stay literal: no emphasis takes effect.
    expect(commonMarkBlocks(lines.join('\n')).at(-1)).toBe(
      'Unavailable: battery, wifi, macos_version, display_count',
    );
  });

  it('reports a desktop as battery: null with battery absent from unavailable', async () => {
    mockProbes({
      ...PROBES,
      [key(SYSTEM_BINARIES.pmset, ['-g', 'batt'])]: "Now drawing from 'AC Power'\n",
    });
    const result = await runToolContract(macosGetInfo, {});
    expect(result.structuredContent).toMatchObject({ battery: null, unavailable: [] });
    const lines = contentLines(result);
    expect(lines).toContain('**Battery:** None (this Mac reports no battery)');
    expect(lines.some((l) => l.startsWith('**Power Source:**'))).toBe(false);
    expect(lines.filter((l) => l.startsWith('**Unavailable:**'))).toEqual(['**Unavailable:** []']);
  });

  it('reports a battery held on AC as not charging, and a withheld network name as connected', async () => {
    mockProbes(PROBES);
    const result = await runToolContract(macosGetInfo, {});
    expect(result.structuredContent).toEqual({
      battery: { level: 80, charging: false, power_source: 'AC' },
      wifi: { connected: true, ssid: null },
      hostname: 'studio.local',
      macos_version: '27.0.1',
      uptime_seconds: 7_260,
      display_count: 1,
      unavailable: [],
    });
    const lines = contentLines(result);
    expect(lines).toContain('**Battery:** 80% — not charging');
    expect(lines).toContain('**Power Source:** AC');
    expect(lines).toContain(
      '**Wi-Fi:** Connected (network name withheld by macOS; reading it requires Location Services access for the host app)',
    );
  });

  /**
   * Each line is the network name in a CommonMark code span, whose content a
   * parser reads back as written: the backtick fence is one longer than the
   * name's longest backtick run, and padded with a space when a backtick
   * touches either end.
   */
  it.each([
    [
      '#1 *Café* _Net_ `x` [a](b) <i> &amp; \\',
      '**Wi-Fi:** Connected to ``#1 *Café* _Net_ `x` [a](b) <i> &amp; \\``',
    ],
    ['`edge` ', '**Wi-Fi:** Connected to `` `edge`  ``'],
  ])('renders the network name %j as a code span holding it verbatim', async (ssid, line) => {
    mockProbes({
      ...PROBES,
      [key(SYSTEM_BINARIES.networksetup, [
        '-getairportnetwork',
        'en0',
      ])]: `Current Wi-Fi Network: ${ssid}\n`,
    });
    const result = await runToolContract(macosGetInfo, {});
    expect(result.structuredContent).toMatchObject({ wifi: { connected: true, ssid } });
    const lines = contentLines(result);
    expect(lines.filter((l) => l.startsWith('**Wi-Fi:**'))).toEqual([line]);
  });

  it('settles a request already cancelled as RequestCancelled, never a snapshot', async () => {
    mockProbes(PROBES);
    const controller = new AbortController();
    controller.abort();
    const result = await runToolContract(
      macosGetInfo,
      {},
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(result.structuredContent).not.toHaveProperty('unavailable');
  });
});

describe('macos://system/info resource', () => {
  it('declares the same output schema as macos_get_info', () => {
    expect(macosSystemInfoResource.output).toBeDefined();
    expect(z.toJSONSchema(macosSystemInfoResource.output!)).toEqual(
      z.toJSONSchema(macosGetInfo.output),
    );
  });

  it('returns what macos_get_info returns for the same probes', async () => {
    mockProbes({});
    const tool = await runToolContract(macosGetInfo, {});
    const read = await macosSystemInfoResource.handler({}, createMockContext());
    expect(read).toEqual(tool.structuredContent);
    expect(macosSystemInfoResource.output!.parse(read)).toEqual(read);
  });
});
