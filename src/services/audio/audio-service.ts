/**
 * @fileoverview Audio device routing service using SwitchAudioSource CLI.
 * @module services/audio/audio-service
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { findThirdPartyBinary, HOMEBREW_BIN_DIRS } from '@/services/binaries/binary-paths.js';
import { execFailure } from '@/utils/exec-failure.js';
import { parseJsonOutput } from '@/utils/parse-json-output.js';
import { quotedText } from '@/utils/quoted-text.js';

const execFile = promisify(execFileCallback);

/**
 * The fields read from one line of `SwitchAudioSource -a -f json`:
 * {"name": "MacBook Pro Speakers", "type": "output", "id": "76", "uid": "..."}.
 */
const DeviceLineSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['input', 'output']),
});

/** No location the lookup searches has SwitchAudioSource. */
function switchAudioSourceNotFound(): McpError {
  return new McpError(
    JsonRpcErrorCode.ServiceUnavailable,
    `SwitchAudioSource was not found on PATH or in ${HOMEBREW_BIN_DIRS.join(' or ')}.`,
    {
      reason: 'switchaudio_unavailable',
      recovery: { hint: 'Install with: brew install switchaudio-osx' },
    },
  );
}

export interface AudioDevice {
  id: string;
  is_default: boolean;
  name: string;
  type: 'input' | 'output';
}

/**
 * The device names `device` could mean, from the names of one type in list
 * order: a name identical to `device` when exactly one device holds it;
 * otherwise every name equal to `device` ignoring case, or, when there is none,
 * every name containing it ignoring case. More than one is ambiguous, and so
 * are identical names: SwitchAudioSource `-s` matches a name with `strcmp` and
 * reaches only the first device holding it.
 */
function candidateNames(names: string[], device: string): string[] {
  const identical = names.filter((name) => name === device);
  if (identical.length === 1) return identical;
  const wanted = device.toLowerCase();
  const equal = names.filter((name) => name.toLowerCase() === wanted);
  return equal.length > 0 ? equal : names.filter((name) => name.toLowerCase().includes(wanted));
}

export class AudioService {
  private async run(args: string[], ctx: Context): Promise<string> {
    ctx.log.debug('SwitchAudioSource', { args });
    const switchAudioSource = await findThirdPartyBinary('SwitchAudioSource');
    if (!switchAudioSource) throw switchAudioSourceNotFound();
    // Before the spawn too: Bun can still run a child whose signal already fired.
    ctx.signal.throwIfAborted();
    try {
      const result = await execFile(switchAudioSource, args, {
        timeout: 10_000,
        signal: ctx.signal,
      });
      return (result.stdout ?? '').trim();
    } catch (err: unknown) {
      if (ctx.signal.aborted) throw err;
      // Removed between the lookup and the spawn.
      if ((err as { code?: unknown }).code === 'ENOENT') throw switchAudioSourceNotFound();
      throw execFailure('SwitchAudioSource', err);
    }
  }

  async listDevices(
    ctx: Context,
    type: 'input' | 'output' | 'all' = 'all',
  ): Promise<AudioDevice[]> {
    const [allLines, currentOutput, currentInput] = await Promise.all([
      this.run(['-a', '-f', 'json'], ctx),
      this.getCurrentDevice('output', ctx),
      this.getCurrentDevice('input', ctx),
    ]);

    // One JSON object per line; a line that is not one input or output device is skipped.
    const devices: AudioDevice[] = [];
    for (const line of allLines.split('\n').filter(Boolean)) {
      const entry = parseJsonOutput(DeviceLineSchema, line);
      if (!entry || (type !== 'all' && entry.type !== type)) continue;
      const { name, type: devType } = entry;
      devices.push({
        id: name, // SwitchAudioSource uses name as the identifier
        name,
        type: devType,
        is_default: devType === 'output' ? name === currentOutput : name === currentInput,
      });
    }

    return devices;
  }

  async getCurrentDevice(type: 'input' | 'output', ctx: Context): Promise<string> {
    const out = await this.run(['-c', '-t', type], ctx);
    return out.trim();
  }

  /**
   * Switches the default `type` device to the one `device` names (see
   * `candidateNames`). Throws `device_not_found` when no name of that type
   * contains `device`, and `device_ambiguous` when more than one could be
   * meant — both before any switch runs.
   */
  async switchDevice(device: string, type: 'input' | 'output', ctx: Context): Promise<void> {
    const devices = await this.listDevices(ctx, type);
    const names = candidateNames(
      devices.map((d) => d.name),
      device,
    );
    const [match] = names;
    if (match === undefined) {
      throw new McpError(
        JsonRpcErrorCode.NotFound,
        `No ${type} device matching ${quotedText(device)} found.`,
        {
          reason: 'device_not_found',
          recovery: {
            hint: 'Call macos_control_audio with action=list to see every device and its exact name.',
          },
        },
      );
    }
    if (names.length > 1) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `${quotedText(device)} matches ${names.length} ${type} devices: ${names.map(quotedText).join(', ')}. The default ${type} device is unchanged.`,
        {
          reason: 'device_ambiguous',
          recovery: {
            hint: 'Call again with the full name of one device, exactly as macos_control_audio action=list returns it. Devices that share one name cannot be told apart by name; choose between them in System Settings > Sound.',
          },
        },
      );
    }
    // The listed name, never the caller's text, reaches SwitchAudioSource.
    await this.run(['-s', match, '-t', type], ctx);
  }
}

// --- Init/accessor pattern ---

let _service: AudioService | undefined;

export function initAudioService(_config: AppConfig, _storage: StorageService): void {
  _service = new AudioService();
}

export function getAudioService(): AudioService {
  if (!_service)
    throw new Error('AudioService not initialized — call initAudioService() in setup()');
  return _service;
}
