/**
 * @fileoverview System information service: battery and power source from
 * pmset, Wi-Fi association from networksetup and ifconfig, macOS version from
 * sw_vers, display count from system_profiler, and hostname and uptime from
 * `node:os`. A probe that fails, or prints output this service cannot read,
 * leaves its field null and names it in `unavailable`; nothing stands in for it.
 * @module services/system-info/system-info-service
 */

import { execFile as execFileCallback } from 'node:child_process';
import { hostname, uptime } from 'node:os';
import { promisify } from 'node:util';
import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { execFailureDetail } from '@/utils/exec-failure.js';
import { parseJsonOutput } from '@/utils/parse-json-output.js';

const execFile = promisify(execFileCallback);

/** Per-probe bound. The Wi-Fi name probe runs after the two Wi-Fi list probes, so a call settles within two of these. */
const PROBE_TIMEOUT_MS = 10_000;

/** Fields a failed or unreadable probe can leave null, as `unavailable` names them. */
const UNAVAILABLE_FIELDS = [
  'battery',
  'wifi',
  'wifi.ssid',
  'macos_version',
  'display_count',
] as const;

type UnavailableField = (typeof UNAVAILABLE_FIELDS)[number];

/** The snapshot `macos_get_info` and `macos://system/info` both return. */
export const SystemInfoSchema = z.object({
  battery: z
    .object({
      level: z.number().describe('Battery charge level as a percentage (0–100).'),
      charging: z
        .boolean()
        .describe(
          'True while charge is flowing into the battery (pmset reports "charging" or "finishing charge"). False when it reports "charged", "AC attached; not charging" (held at a charge limit or paused), or "discharging".',
        ),
      power_source: z
        .enum(['AC', 'Battery', 'UPS'])
        .describe('What the Mac is drawing power from, per pmset.'),
    })
    .nullable()
    .describe(
      'Battery state. null on a Mac that reports no battery, and null when the power probe failed; only the second case lists `battery` in `unavailable`.',
    ),
  wifi: z
    .object({
      connected: z
        .boolean()
        .describe(
          "True when the Wi-Fi device's link is active, i.e. it is associated with a network. False when it is not, or when the Mac has no Wi-Fi hardware port.",
        ),
      ssid: z
        .string()
        .nullable()
        .describe(
          'Name of the joined network. null when not connected. null while connected means macOS withheld the name: reading it requires Location Services access for the app hosting this server. When `unavailable` lists `wifi.ssid`, the name probe failed instead.',
        ),
    })
    .nullable()
    .describe('Wi-Fi association. null when its probe failed (`unavailable` lists `wifi`).'),
  hostname: z.string().describe('Machine hostname.'),
  macos_version: z
    .string()
    .nullable()
    .describe(
      'macOS product version, e.g. "15.1". null when its probe failed (`unavailable` lists `macos_version`).',
    ),
  uptime_seconds: z.number().describe('Whole seconds since the last boot.'),
  display_count: z
    .number()
    .nullable()
    .describe(
      'Number of connected displays; 0 on a headless Mac. null when its probe failed (`unavailable` lists `display_count`).',
    ),
  unavailable: z
    .array(z.enum(UNAVAILABLE_FIELDS))
    .describe(
      'Fields whose probe failed or printed output that could not be read; each one named is null. Empty when every probe succeeded.',
    ),
});

export type SystemInfo = z.infer<typeof SystemInfoSchema>;

type BatteryInfo = NonNullable<SystemInfo['battery']>;
type WifiInfo = NonNullable<SystemInfo['wifi']>;

/** What a probe's output said: a value (which can itself be null, e.g. no battery), or nothing readable. */
type Reading<T> = { kind: 'value'; value: T } | { kind: 'unreadable' };

const unreadable = { kind: 'unreadable' } as const;

/**
 * Stdout of a system binary, or undefined when it could not run, exited
 * non-zero, or timed out. A caller's cancellation is rethrown, never read as a
 * failed probe.
 */
async function probe(
  cmd: (typeof SYSTEM_BINARIES)[keyof typeof SYSTEM_BINARIES],
  args: string[],
  ctx: Context,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFile(cmd, args, {
      timeout: PROBE_TIMEOUT_MS,
      signal: ctx.signal,
    });
    return stdout;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log.debug('system info probe failed', { cmd, detail: execFailureDetail(err) });
    return;
  }
}

/** `Now drawing from '…'` names one of IOKit's three providing power source types. */
function powerSourceOf(name: string): BatteryInfo['power_source'] | undefined {
  switch (name) {
    case 'AC Power':
      return 'AC';
    case 'Battery Power':
      return 'Battery';
    case 'UPS Power':
      return 'UPS';
    default:
      return;
  }
}

/**
 * The two of pmset's five battery state tokens that mean charge is flowing in.
 * The other three, `charged`, `AC attached; not charging`, and `discharging`,
 * mean it is not.
 */
const CHARGING_STATES: ReadonlySet<string> = new Set(['charging', 'finishing charge']);

/**
 * `pmset -g batt`, as `show_power_sources` in Apple's pmset.m prints it: an
 * optional `* Battery Polling is Stopped` line, `Now drawing from '<source>'`,
 * then one ` -<name> (id=<n>)\t<pct>%; <state>…` line per battery or UPS. A Mac
 * drawing from AC with no such line has no battery (`null`).
 */
function readBattery(out: string | undefined): Reading<BatteryInfo | null> {
  if (out === undefined) return unreadable;
  const sourceName = /^Now drawing from '([^'\n]*)'$/m.exec(out)?.[1];
  const power_source = sourceName === undefined ? undefined : powerSourceOf(sourceName);
  if (!power_source) return unreadable;

  if (!/^ -[^\t\n]*\t/m.test(out)) {
    return power_source === 'AC' ? { kind: 'value', value: null } : unreadable;
  }
  const line =
    /^ -[^\t\n]*\t(\d+)%; (finishing charge|charging|charged|AC attached; not charging|discharging)(?=[; ]|$)/m.exec(
      out,
    );
  const level = line?.[1];
  const state = line?.[2];
  if (level === undefined || state === undefined) return unreadable;
  return {
    kind: 'value',
    value: { level: Number(level), charging: CHARGING_STATES.has(state), power_source },
  };
}

/** Devices named by `networksetup -listallhardwareports`, in its order. */
function readHardwarePortDevices(out: string | undefined): string[] | undefined {
  if (out === undefined) return;
  const devices = [...out.matchAll(/^Device: (\S+)$/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
  // Every Mac has at least one hardware port; an empty list is output this parser does not know.
  return devices.length > 0 ? devices : undefined;
}

interface InterfaceState {
  /** `status:` from the interface's media, absent when ifconfig printed none. */
  active: boolean | undefined;
  wifi: boolean;
}

/** Each interface `ifconfig -v` lists: whether its type is Wi-Fi, and its link status. */
function readInterfaces(out: string | undefined): Map<string, InterfaceState> | undefined {
  if (out === undefined) return;
  const interfaces = new Map<string, InterfaceState>();
  for (const block of out.split(/^(?=[^\s:]+: flags=)/m)) {
    const name = /^([^\s:]+): flags=/.exec(block)?.[1];
    if (!name) continue;
    const status = /^\tstatus: (active|inactive)$/m.exec(block)?.[1];
    interfaces.set(name, {
      wifi: /^\ttype: Wi-Fi$/m.test(block),
      active: status === undefined ? undefined : status === 'active',
    });
  }
  return interfaces.size > 0 ? interfaces : undefined;
}

/**
 * The network name `networksetup -getairportnetwork` prints for an associated
 * device: the name, `null` when macOS withholds it (it then reports the device
 * as not associated), or unreadable.
 */
function readSsid(out: string | undefined): Reading<string | null> {
  if (out === undefined) return unreadable;
  const name = /^Current Wi-Fi Network: (.+)$/m.exec(out)?.[1];
  if (name !== undefined) return { kind: 'value', value: name };
  if (out.includes('You are not associated with an AirPort network.')) {
    return { kind: 'value', value: null };
  }
  return unreadable;
}

/** `sw_vers -productVersion`: a dotted version number. */
function readVersion(out: string | undefined): string | undefined {
  const version = out?.trim();
  return version && /^\d+(?:\.\d+)*$/.test(version) ? version : undefined;
}

/**
 * `system_profiler -json SPDisplaysDataType`: one entry per GPU, each listing
 * its displays under `spdisplays_ndrvs`. The JSON keys are not localized; the
 * text report's labels are.
 */
const DisplaysReportSchema = z.object({
  SPDisplaysDataType: z.array(z.object({ spdisplays_ndrvs: z.array(z.unknown()).optional() })),
});

function readDisplayCount(out: string | undefined): number | undefined {
  if (out === undefined) return;
  const report = parseJsonOutput(DisplaysReportSchema, out);
  if (!report) return;
  return report.SPDisplaysDataType.reduce(
    (count, gpu) => count + (gpu.spdisplays_ndrvs?.length ?? 0),
    0,
  );
}

export class SystemInfoService {
  async getSystemInfo(ctx: Context): Promise<SystemInfo> {
    ctx.log.debug('getSystemInfo');

    const [pmsetOut, wifi, swVersOut, displaysOut] = await Promise.all([
      probe(SYSTEM_BINARIES.pmset, ['-g', 'batt'], ctx),
      this.probeWifi(ctx),
      probe(SYSTEM_BINARIES.sw_vers, ['-productVersion'], ctx),
      probe(
        SYSTEM_BINARIES.system_profiler,
        ['-json', 'SPDisplaysDataType', '-detailLevel', 'mini'],
        ctx,
      ),
    ]);

    const unavailable: UnavailableField[] = [];
    const battery = readBattery(pmsetOut);
    if (battery.kind === 'unreadable') unavailable.push('battery');
    if (wifi.info === null) unavailable.push('wifi');
    if (wifi.ssidUnreadable) unavailable.push('wifi.ssid');
    const macos_version = readVersion(swVersOut) ?? null;
    if (macos_version === null) unavailable.push('macos_version');
    const display_count = readDisplayCount(displaysOut) ?? null;
    if (display_count === null) unavailable.push('display_count');

    return {
      battery: battery.kind === 'value' ? battery.value : null,
      wifi: wifi.info,
      hostname: hostname(),
      macos_version,
      uptime_seconds: Math.floor(uptime()),
      display_count,
      unavailable,
    };
  }

  /**
   * The Wi-Fi device is the hardware port whose interface ifconfig types as
   * Wi-Fi. The port's name is not used: SystemConfiguration localizes it
   * ("WLAN" in German), while ifconfig's type label is fixed. Association is
   * that device's link status; the network name is read only when associated.
   */
  private async probeWifi(
    ctx: Context,
  ): Promise<{ info: WifiInfo | null; ssidUnreadable: boolean }> {
    const [portsOut, ifconfigOut] = await Promise.all([
      probe(SYSTEM_BINARIES.networksetup, ['-listallhardwareports'], ctx),
      probe(SYSTEM_BINARIES.ifconfig, ['-v'], ctx),
    ]);
    const devices = readHardwarePortDevices(portsOut);
    const interfaces = readInterfaces(ifconfigOut);
    if (!devices || !interfaces) return { info: null, ssidUnreadable: false };

    const wifiDevices = devices.filter((d) => interfaces.get(d)?.wifi);
    const associated = wifiDevices.find((d) => interfaces.get(d)?.active === true);
    if (associated === undefined) {
      const statusKnown = wifiDevices.every((d) => interfaces.get(d)?.active !== undefined);
      return {
        info: statusKnown ? { connected: false, ssid: null } : null,
        ssidUnreadable: false,
      };
    }

    const ssid = readSsid(
      await probe(SYSTEM_BINARIES.networksetup, ['-getairportnetwork', associated], ctx),
    );
    return {
      info: { connected: true, ssid: ssid.kind === 'value' ? ssid.value : null },
      ssidUnreadable: ssid.kind === 'unreadable',
    };
  }
}

// --- Init/accessor pattern ---

let _service: SystemInfoService | undefined;

export function initSystemInfoService(_config: AppConfig, _storage: StorageService): void {
  _service = new SystemInfoService();
}

export function getSystemInfoService(): SystemInfoService {
  if (!_service)
    throw new Error('SystemInfoService not initialized — call initSystemInfoService() in setup()');
  return _service;
}
