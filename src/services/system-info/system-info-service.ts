/**
 * @fileoverview System information service wrapping pmset, networksetup, sw_vers, hostname, uptime CLIs.
 * @module services/system-info/system-info-service
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';

const execFile = promisify(execFileCallback);

export interface BatteryInfo {
  charging: boolean;
  level: number;
  power_source: 'AC' | 'Battery' | 'UPS';
}

export interface SystemInfo {
  battery: BatteryInfo | null;
  display_count: number;
  hostname: string;
  macos_version: string;
  uptime_seconds: number;
  wifi: { ssid: string | null; connected: boolean };
}

async function runSafe(cmd: string, args: string[]): Promise<string> {
  try {
    const r = await execFile(cmd, args, { timeout: 10_000 });
    return (r.stdout ?? '').trim();
  } catch {
    return '';
  }
}

export class SystemInfoService {
  async getSystemInfo(ctx: Context): Promise<SystemInfo> {
    ctx.log.debug('getSystemInfo');

    const [pmsetOut, networkOut, hostnameOut, swVersOut, uptimeOut, displayOut] = await Promise.all(
      [
        runSafe('pmset', ['-g', 'batt']),
        runSafe('networksetup', ['-getairportnetwork', 'en0']),
        runSafe('hostname', []),
        runSafe('sw_vers', ['-productVersion']),
        runSafe('sysctl', ['-n', 'kern.boottime']),
        runSafe('system_profiler', ['SPDisplaysDataType', '-detailLevel', 'mini']),
      ],
    );

    return {
      battery: this.parseBattery(pmsetOut),
      wifi: this.parseWifi(networkOut),
      hostname: hostnameOut || 'unknown',
      macos_version: swVersOut || 'unknown',
      uptime_seconds: this.parseUptime(uptimeOut),
      display_count: this.parseDisplayCount(displayOut),
    };
  }

  private parseBattery(pmsetOut: string): BatteryInfo | null {
    if (!pmsetOut) return null;

    /**
     * pmset -g batt output varies:
     *   "Now drawing from 'AC Power'" or "'Battery Power'"
     *   "InternalBattery-0 (id=xxx) 85%; charging; 1:23 remaining present: true"
     */
    const powerLine = pmsetOut.split('\n')[0] ?? '';
    const battLine = pmsetOut.split('\n').find((l) => l.includes('%')) ?? '';

    if (!battLine) {
      // Desktop Mac — no battery
      if (powerLine.includes('AC Power')) {
        return null;
      }
      return null;
    }

    const levelMatch = battLine.match(/(\d+)%/);
    const level = levelMatch ? parseInt(levelMatch[1]!, 10) : 0;
    const charging = battLine.includes('charging') || battLine.includes('AC attached');
    let power_source: 'AC' | 'Battery' | 'UPS' = 'Battery';
    if (powerLine.includes('AC Power')) power_source = 'AC';
    else if (powerLine.includes('UPS')) power_source = 'UPS';

    return { level, charging, power_source };
  }

  private parseWifi(networkOut: string): { ssid: string | null; connected: boolean } {
    if (!networkOut) return { ssid: null, connected: false };
    // "Current Wi-Fi Network: MyNetwork" or "You are not associated with an AirPort network."
    if (networkOut.includes('not associated')) return { ssid: null, connected: false };
    const match = networkOut.match(/Current Wi-Fi Network:\s*(.+)/);
    if (!match) return { ssid: null, connected: false };
    return { ssid: match[1]?.trim() ?? null, connected: true };
  }

  private parseUptime(uptimeOut: string): number {
    if (!uptimeOut) return 0;
    // kern.boottime: { sec = 1748300000, usec = 0 } Mon...
    const match = uptimeOut.match(/sec\s*=\s*(\d+)/);
    if (match) {
      const bootSec = parseInt(match[1]!, 10);
      return Math.floor(Date.now() / 1000) - bootSec;
    }
    return 0;
  }

  private parseDisplayCount(profileOut: string): number {
    if (!profileOut) return 1;
    // Count occurrences of "Resolution:" — each display has one in system_profiler output
    const resolutionCount = (profileOut.match(/Resolution:/g) ?? []).length;
    return resolutionCount || 1;
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
