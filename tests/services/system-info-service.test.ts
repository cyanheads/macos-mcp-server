/**
 * @fileoverview Unit tests for SystemInfoService over captured probe output:
 * every pmset battery state, the three Wi-Fi states, display counting, failed
 * and unreadable probes, cancellation, and the probes running by absolute path.
 * @module tests/services/system-info-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { SystemInfoService } from '@/services/system-info/system-info-service.js';

/**
 * Shape of the mocked `execFile`. The service wraps it in `promisify`, and the
 * module mock carries no `util.promisify.custom` hook, so promisify takes the
 * generic path and resolves with the callback's second argument. That is the
 * contract these mocks implement — not Node's own `execFile` overloads.
 */
type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal; timeout?: number },
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock, osMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMock>(),
  osMock: { hostname: vi.fn(() => 'studio.local'), uptime: vi.fn(() => 7_200.62) },
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  hostname: osMock.hostname,
  uptime: osMock.uptime,
}));

// --- Probe keys: the absolute path and arguments of each probe ---

function key(cmd: string, args: string[]): string {
  return [cmd, ...args].join(' ');
}

const PMSET = key(SYSTEM_BINARIES.pmset, ['-g', 'batt']);
const PORTS = key(SYSTEM_BINARIES.networksetup, ['-listallhardwareports']);
const IFCONFIG = key(SYSTEM_BINARIES.ifconfig, ['-v']);
const SW_VERS = key(SYSTEM_BINARIES.sw_vers, ['-productVersion']);
const DISPLAYS = key(SYSTEM_BINARIES.system_profiler, [
  '-json',
  'SPDisplaysDataType',
  '-detailLevel',
  'mini',
]);
const ssidProbe = (device: string) =>
  key(SYSTEM_BINARIES.networksetup, ['-getairportnetwork', device]);

// --- Captured output ---

/**
 * `pmset -g batt` lines. The AC-attached line is this repo's MacBook Pro on AC
 * with its battery held at a charge limit; the rest follow the print path of
 * `show_power_sources` in Apple's pmset.m (PowerManagement-1846.120.8.0.1):
 * ` -<name> (id=<n>)\t<pct>%; <state>`, then `; h:mm remaining` or
 * `; (no estimate)` (omitted for "AC attached; not charging"), then ` present: true`.
 */
const AC = "Now drawing from 'AC Power'";
const ON_BATTERY = "Now drawing from 'Battery Power'";
const batt = (rest: string) => ` -InternalBattery-0 (id=27328611)\t${rest} present: true`;
const pmset = (...lines: string[]) => `${lines.join('\n')}\n`;

/** `networksetup -listallhardwareports` on a MacBook Pro; Ethernet addresses replaced. */
const PORTS_MACBOOK = [
  '',
  'Hardware Port: Ethernet Adapter (en4)',
  'Device: en4',
  'Ethernet Address: 02:00:00:00:00:04',
  '',
  'Hardware Port: USB 10/100/1000 LAN',
  'Device: en8',
  'Ethernet Address: 02:00:00:00:00:08',
  '',
  'Hardware Port: Thunderbolt Bridge',
  'Device: bridge0',
  'Ethernet Address: 02:00:00:00:00:00',
  '',
  'Hardware Port: Wi-Fi',
  'Device: en0',
  'Ethernet Address: 02:00:00:00:00:01',
  '',
  'Hardware Port: Thunderbolt 1',
  'Device: en1',
  'Ethernet Address: 02:00:00:00:00:02',
  '',
  'VLAN Configurations',
  '===================',
  '',
].join('\n');

/**
 * `ifconfig -v` blocks from the same Mac, trimmed to the lines the service
 * reads plus neighbors. awdl0, llw0, and ap1 are also typed Wi-Fi but are no
 * hardware port; llw0 prints no status line. Each block's agent line carries a
 * `type:` of its own.
 */
function ifconfigBlock(name: string, type: string, status?: 'active' | 'inactive'): string {
  return [
    `${name}: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500 index 15`,
    '\tether 02:00:00:00:00:00',
    '\tnd6 options=201<PERFORMNUD,DAD>',
    '\tmedia: autoselect',
    ...(status ? [`\tstatus: ${status}`] : []),
    '\tmax mtu: 1500',
    '\tgeneration id: 26',
    `\ttype: ${type}`,
    '\tagent domain:WiFiManager type:CallInProgress flags:0x3d desc:"WiFi"',
    '\tlink quality: 100 (good)',
    '\tstate availability: 0 (true)',
  ].join('\n');
}

function ifconfig(en0Status: 'active' | 'inactive' | undefined): string {
  return `${[
    'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384 index 1\n\tinet 127.0.0.1 netmask 0xff000000\n\tnd6 options=201<PERFORMNUD,DAD>',
    ifconfigBlock('en4', 'USB Ethernet', 'inactive'),
    ifconfigBlock('en8', 'Ethernet', 'active'),
    ifconfigBlock('bridge0', '0xd1 family: 2 subfamily: 0', 'inactive'),
    ifconfigBlock('ap1', 'Wi-Fi', 'inactive'),
    ifconfigBlock('en0', 'Wi-Fi', en0Status),
    ifconfigBlock('awdl0', 'Wi-Fi', 'active'),
    ifconfigBlock('llw0', 'Wi-Fi'),
    ifconfigBlock('en1', 'IP over Thunderbolt', 'inactive'),
  ].join('\n')}\n`;
}

/** `networksetup -getairportnetwork <device>`: its two answers for a Wi-Fi device. */
const SSID_READABLE = 'Current Wi-Fi Network: Home\n';
const SSID_WITHHELD = 'You are not associated with an AirPort network.\n';

/** `system_profiler -json SPDisplaysDataType -detailLevel mini` with three displays; serials replaced. */
const DISPLAYS_THREE = JSON.stringify({
  SPDisplaysDataType: [
    {
      _name: 'Apple M2 Max',
      spdisplays_mtlgpufamilysupport: 'spdisplays_metal4',
      spdisplays_ndrvs: [
        {
          _name: 'Gigabyte M32U',
          _spdisplays_pixels: '3840 x 2160',
          _spdisplays_resolution: '3840 x 2160 @ 144.00Hz',
          spdisplays_main: 'spdisplays_yes',
          spdisplays_online: 'spdisplays_yes',
        },
        {
          _name: 'Color LCD',
          _spdisplays_pixels: '3024 x 1964',
          _spdisplays_resolution: '1512 x 982 @ 120.00Hz',
          spdisplays_connection_type: 'spdisplays_internal',
          spdisplays_online: 'spdisplays_yes',
        },
        {
          _name: 'ROG PG279Q',
          _spdisplays_pixels: '2880 x 5120',
          _spdisplays_resolution: '1440 x 2560 @ 60.00Hz',
          spdisplays_online: 'spdisplays_yes',
          spdisplays_rotation: 270,
        },
      ],
      spdisplays_vendor: 'sppci_vendor_Apple',
      sppci_bus: 'spdisplays_builtin',
      sppci_model: 'Apple M2 Max',
    },
  ],
});

/** The same report with nothing attached: the GPU entry carries no `spdisplays_ndrvs`. */
const DISPLAYS_HEADLESS = JSON.stringify({
  SPDisplaysDataType: [
    { _name: 'Apple M2 Max', sppci_bus: 'spdisplays_builtin', sppci_model: 'Apple M2 Max' },
  ],
});

/** Every probe answering as it does on the MacBook Pro, with the network name readable. */
const HEALTHY: Record<string, string> = {
  [PMSET]: pmset(AC, batt('80%; AC attached; not charging')),
  [PORTS]: PORTS_MACBOOK,
  [IFCONFIG]: ifconfig('active'),
  [ssidProbe('en0')]: SSID_READABLE,
  [SW_VERS]: '27.0.1\n',
  [DISPLAYS]: DISPLAYS_THREE,
};

type ProbeAnswer = string | NodeJS.ErrnoException;

const enoent = (cmd: string) =>
  Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }) as NodeJS.ErrnoException;

/**
 * Answer each probe from `table` by its absolute path and arguments. A probe
 * missing from the table fails as a missing binary would, so a bare program
 * name (PATH lookup) never resolves.
 */
function mockProbes(table: Record<string, ProbeAnswer | undefined>): void {
  execFileMock.mockReset();
  execFileMock.mockImplementation((cmd, args, opts, cb) => {
    if (opts.signal?.aborted) {
      cb(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        }),
      );
      return { pid: 1 };
    }
    const answer = table[key(cmd, args)];
    if (answer === undefined) cb(enoent(cmd));
    else if (typeof answer === 'string') cb(null, { stdout: answer, stderr: '' });
    else cb(answer);
    return { pid: 1 };
  });
}

function getInfo() {
  return new SystemInfoService().getSystemInfo(createMockContext());
}

function probeKeys(): string[] {
  return execFileMock.mock.calls.map(([cmd, args]) => key(cmd, args));
}

describe('SystemInfoService battery', () => {
  const cases: Array<[string, string, { level: number; charging: boolean; power_source: string }]> =
    [
      [
        'charging',
        pmset(AC, batt('62%; charging; 1:05 remaining')),
        { level: 62, charging: true, power_source: 'AC' },
      ],
      [
        'finishing charge',
        pmset(AC, batt('97%; finishing charge; 0:12 remaining')),
        { level: 97, charging: true, power_source: 'AC' },
      ],
      [
        'charged',
        pmset(AC, batt('100%; charged; 0:00 remaining')),
        { level: 100, charging: false, power_source: 'AC' },
      ],
      [
        'AC attached; not charging',
        pmset(AC, batt('80%; AC attached; not charging')),
        { level: 80, charging: false, power_source: 'AC' },
      ],
      [
        'discharging',
        pmset(ON_BATTERY, batt('85%; discharging; 2:30 remaining')),
        { level: 85, charging: false, power_source: 'Battery' },
      ],
      [
        'discharging, with no time estimate,',
        pmset(ON_BATTERY, batt('31%; discharging; (no estimate)')),
        { level: 31, charging: false, power_source: 'Battery' },
      ],
      [
        'charging, after a "* Battery Polling is Stopped" line,',
        pmset('* Battery Polling is Stopped', AC, batt('62%; charging; 1:05 remaining')),
        { level: 62, charging: true, power_source: 'AC' },
      ],
      [
        'discharging, drawing from a UPS,',
        pmset(
          "Now drawing from 'UPS Power'",
          ' -Back-UPS ES 700 (id=2)\t96%; discharging; 0:41 remaining present: true',
        ),
        { level: 96, charging: false, power_source: 'UPS' },
      ],
    ];

  it.each(cases)('maps pmset’s "%s" state', async (_state, out, expected) => {
    mockProbes({ ...HEALTHY, [PMSET]: out });
    const info = await getInfo();
    expect(info.battery).toEqual(expected);
    expect(info.unavailable).toEqual([]);
  });

  it('reports a desktop on AC with no battery as battery: null, not unavailable', async () => {
    mockProbes({ ...HEALTHY, [PMSET]: pmset(AC) });
    const info = await getInfo();
    expect(info.battery).toBeNull();
    expect(info.unavailable).toEqual([]);
  });

  const unreadable: Array<[string, string | undefined]> = [
    ['pmset failing to run', undefined],
    ['empty output', ''],
    ['no power source info', 'No power source info available\n'],
    ['polling stopped with no source line', pmset('* Battery Polling is Stopped')],
    ['a battery line but no "Now drawing from" line', pmset(batt('80%; charging; 1:05 remaining'))],
    ['drawing from the battery with no battery line', pmset(ON_BATTERY)],
    ['a battery line with no state token', pmset(AC, batt('80%; ; 1:05 remaining'))],
  ];

  it.each(unreadable)(
    'reports battery unavailable for %s, never a default power source',
    async (_label, out) => {
      mockProbes({ ...HEALTHY, [PMSET]: out });
      const info = await getInfo();
      expect(info.battery).toBeNull();
      expect(info.unavailable).toEqual(['battery']);
    },
  );
});

describe('SystemInfoService Wi-Fi', () => {
  it.each([
    ['the network name when it is readable', SSID_READABLE, 'Home'],
    ['ssid null when macOS withholds the name', SSID_WITHHELD, null],
  ])('reports an associated device as connected with %s', async (_label, answer, ssid) => {
    mockProbes({ ...HEALTHY, [ssidProbe('en0')]: answer });
    const info = await getInfo();
    expect(info.wifi).toEqual({ connected: true, ssid });
    expect(info.unavailable).toEqual([]);
  });

  it('reports not connected from an inactive link, without reading the name', async () => {
    // awdl0 stays active and typed Wi-Fi, but it is no hardware port.
    mockProbes({ ...HEALTHY, [IFCONFIG]: ifconfig('inactive') });
    const info = await getInfo();
    expect(info.wifi).toEqual({ connected: false, ssid: null });
    expect(info.unavailable).toEqual([]);
    expect(probeKeys()).not.toContain(ssidProbe('en0'));
  });

  it('probes the Wi-Fi hardware port device when it is not en0', async () => {
    /** The MacBook Pro output with the two devices swapped: Ethernet on en0, Wi-Fi on en1. */
    const ports = [
      '',
      'Hardware Port: Ethernet',
      'Device: en0',
      'Ethernet Address: 02:00:00:00:00:01',
      '',
      'Hardware Port: Wi-Fi',
      'Device: en1',
      'Ethernet Address: 02:00:00:00:00:02',
      '',
      'VLAN Configurations',
      '===================',
      '',
    ].join('\n');
    const interfaces = `${[
      ifconfigBlock('en0', 'Ethernet', 'active'),
      ifconfigBlock('en1', 'Wi-Fi', 'active'),
      ifconfigBlock('awdl0', 'Wi-Fi', 'active'),
    ].join('\n')}\n`;
    mockProbes({
      ...HEALTHY,
      [PORTS]: ports,
      [IFCONFIG]: interfaces,
      [ssidProbe('en0')]: undefined,
      [ssidProbe('en1')]: 'Current Wi-Fi Network: Studio 5G\n',
    });
    const info = await getInfo();
    expect(info.wifi).toEqual({ connected: true, ssid: 'Studio 5G' });
    const ssidCalls = probeKeys().filter((k) => k.includes('-getairportnetwork'));
    expect(ssidCalls).toEqual([ssidProbe('en1')]);
  });

  it('finds the Wi-Fi device when its hardware port name is localized', async () => {
    // "WLAN" is SystemConfiguration's German name for the Wi-Fi interface type.
    mockProbes({
      ...HEALTHY,
      [PORTS]: PORTS_MACBOOK.replace('Hardware Port: Wi-Fi', 'Hardware Port: WLAN'),
    });
    expect((await getInfo()).wifi).toEqual({ connected: true, ssid: 'Home' });
  });

  it('reads the associated device when two hardware ports are Wi-Fi', async () => {
    const ports = `${PORTS_MACBOOK}\nHardware Port: Wi-Fi 2\nDevice: en9\nEthernet Address: 02:00:00:00:00:09\n`;
    const interfaces = `${ifconfig('inactive')}${ifconfigBlock('en9', 'Wi-Fi', 'active')}\n`;
    mockProbes({
      ...HEALTHY,
      [PORTS]: ports,
      [IFCONFIG]: interfaces,
      [ssidProbe('en9')]: 'Current Wi-Fi Network: Dongle\n',
    });
    expect((await getInfo()).wifi).toEqual({ connected: true, ssid: 'Dongle' });
    expect(probeKeys().filter((k) => k.includes('-getairportnetwork'))).toEqual([ssidProbe('en9')]);
  });

  it('reports not connected on a Mac with no Wi-Fi hardware port', async () => {
    mockProbes({
      ...HEALTHY,
      [PORTS]: 'Hardware Port: Ethernet\nDevice: en0\nEthernet Address: 02:00:00:00:00:01\n',
      [IFCONFIG]: `${ifconfigBlock('en0', 'Ethernet', 'active')}\n`,
    });
    const info = await getInfo();
    expect(info.wifi).toEqual({ connected: false, ssid: null });
    expect(info.unavailable).toEqual([]);
    expect(probeKeys().some((k) => k.includes('-getairportnetwork'))).toBe(false);
  });

  it.each<[string, ProbeAnswer]>([
    [
      'fails',
      Object.assign(new Error('Command failed'), {
        killed: true,
        signal: 'SIGTERM',
      }) as NodeJS.ErrnoException,
    ],
    ['prints something unrecognized', 'Wi-Fi power is currently off.\n'],
  ])(
    'names wifi.ssid unavailable when the name probe on an associated device %s',
    async (_label, answer) => {
      mockProbes({ ...HEALTHY, [ssidProbe('en0')]: answer });
      const info = await getInfo();
      expect(info.wifi).toEqual({ connected: true, ssid: null });
      expect(info.unavailable).toEqual(['wifi.ssid']);
    },
  );

  const failed: Array<[string, Record<string, string | undefined>]> = [
    ['the hardware-port probe fails', { [PORTS]: undefined }],
    [
      'the hardware-port probe lists no device',
      { [PORTS]: '\nVLAN Configurations\n===================\n' },
    ],
    ['the ifconfig probe fails', { [IFCONFIG]: undefined }],
    ['ifconfig lists no interface', { [IFCONFIG]: '' }],
    ['the Wi-Fi device prints no link status', { [IFCONFIG]: ifconfig(undefined) }],
  ];

  it.each(failed)('reports wifi null and unavailable when %s', async (_label, override) => {
    mockProbes({ ...HEALTHY, ...override });
    const info = await getInfo();
    expect(info.wifi).toBeNull();
    expect(info.unavailable).toEqual(['wifi']);
  });
});

describe('SystemInfoService version, displays, hostname, uptime', () => {
  it('reports every field from healthy probes, with whole-second uptime', async () => {
    mockProbes(HEALTHY);
    expect(await getInfo()).toEqual({
      battery: { level: 80, charging: false, power_source: 'AC' },
      wifi: { connected: true, ssid: 'Home' },
      hostname: 'studio.local',
      macos_version: '27.0.1',
      uptime_seconds: 7_200,
      display_count: 3,
      unavailable: [],
    });
  });

  it('reports 0 displays on a headless Mac, not unavailable', async () => {
    mockProbes({ ...HEALTHY, [DISPLAYS]: DISPLAYS_HEADLESS });
    const info = await getInfo();
    expect(info.display_count).toBe(0);
    expect(info.unavailable).toEqual([]);
  });

  it.each<[string, string, string, 'display_count' | 'macos_version']>([
    // The text report's labels are localized ("Auflösung" in German), so it is never counted.
    [
      'the displays report is not the JSON it asked for',
      DISPLAYS,
      'Graphics/Displays:\n\n    Apple M2 Max:\n\n      Displays:\n        Color LCD:\n          Auflösung: 3024 x 1964 Retina\n',
      'display_count',
    ],
    ['the displays JSON has no displays report', DISPLAYS, '{}', 'display_count'],
    ['sw_vers prints no version number', SW_VERS, '\n', 'macos_version'],
  ])('reports the field unavailable when %s', async (_label, probeKey, out, field) => {
    mockProbes({ ...HEALTHY, [probeKey]: out });
    const info = await getInfo();
    expect(info[field]).toBeNull();
    expect(info.unavailable).toEqual([field]);
  });
});

describe('SystemInfoService with every probe failing', () => {
  it('reports each probed field null and named in unavailable, with hostname and uptime intact', async () => {
    mockProbes({});
    expect(await getInfo()).toEqual({
      battery: null,
      wifi: null,
      hostname: 'studio.local',
      macos_version: null,
      uptime_seconds: 7_200,
      display_count: null,
      unavailable: ['battery', 'wifi', 'macos_version', 'display_count'],
    });
  });
});

describe('SystemInfoService cancellation', () => {
  it("rethrows the caller's cancellation instead of reporting the probes unavailable", async () => {
    mockProbes(HEALTHY);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new SystemInfoService().getSystemInfo(createMockContext({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes the caller signal and a timeout to every probe', async () => {
    mockProbes(HEALTHY);
    const controller = new AbortController();
    await new SystemInfoService().getSystemInfo(createMockContext({ signal: controller.signal }));
    expect(execFileMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, , opts] of execFileMock.mock.calls) {
      expect(opts).toEqual({ signal: controller.signal, timeout: 10_000 });
    }
  });
});

describe('SystemInfoService probes', () => {
  beforeEach(() => {
    mockProbes(HEALTHY);
  });

  it('runs six probes when associated, each from its absolute path, the name probe last', async () => {
    await getInfo();
    expect(probeKeys()).toEqual([PMSET, PORTS, IFCONFIG, SW_VERS, DISPLAYS, ssidProbe('en0')]);
  });

  it('runs no hostname or uptime subprocess', async () => {
    await getInfo();
    expect(osMock.hostname).toHaveBeenCalled();
    expect(osMock.uptime).toHaveBeenCalled();
    const programs = execFileMock.mock.calls.map(([cmd]) => cmd);
    expect(programs).not.toContain('/bin/hostname');
    expect(programs).not.toContain('/usr/sbin/sysctl');
  });
});
