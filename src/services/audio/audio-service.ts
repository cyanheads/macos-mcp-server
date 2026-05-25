/**
 * @fileoverview Audio device routing service using SwitchAudioSource CLI.
 * @module services/audio/audio-service
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';

const execFile = promisify(execFileCallback);

const SWITCH_AUDIO_SOURCE = '/opt/homebrew/bin/SwitchAudioSource';

export interface AudioDevice {
  id: string;
  is_default: boolean;
  name: string;
  type: 'input' | 'output';
}

export class AudioService {
  private async run(args: string[], ctx: Context): Promise<string> {
    ctx.log.debug('SwitchAudioSource', { args });
    try {
      const result = await execFile(SWITCH_AUDIO_SOURCE, args, { timeout: 10_000 });
      return (result.stdout ?? '').trim();
    } catch (err: unknown) {
      const e = err as { code?: string | number; message?: string };
      if (e.code === 'ENOENT') {
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'SwitchAudioSource is not installed.',
          {
            reason: 'switchaudio_unavailable',
            recovery: { hint: 'Install with: brew install switchaudio-osx' },
          },
        );
      }
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `SwitchAudioSource failed: ${e.message ?? 'unknown error'}`,
        { args },
      );
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

    /**
     * -f json output format: one JSON object per line.
     * {"name": "MacBook Pro Speakers", "type": "output", "id": "76", "uid": "..."}
     */
    const devices: AudioDevice[] = [];
    for (const line of allLines.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as { name?: string; type?: string };
        const name = entry.name;
        const devType = entry.type;
        if (!name || (devType !== 'input' && devType !== 'output')) continue;
        if (type !== 'all' && devType !== type) continue;
        devices.push({
          id: name, // SwitchAudioSource uses name as the identifier
          name,
          type: devType,
          is_default: devType === 'output' ? name === currentOutput : name === currentInput,
        });
      } catch {
        // Skip malformed lines
      }
    }

    return devices;
  }

  async getCurrentDevice(type: 'input' | 'output', ctx: Context): Promise<string> {
    const out = await this.run(['-c', '-t', type], ctx);
    return out.trim();
  }

  async switchDevice(name: string, type: 'input' | 'output', ctx: Context): Promise<void> {
    // Validate against known device list before passing to CLI
    const devices = await this.listDevices(ctx, type);
    const match = devices.find((d) => d.name.toLowerCase().includes(name.toLowerCase()));
    if (!match) {
      throw new McpError(JsonRpcErrorCode.NotFound, `No ${type} device matching "${name}" found.`, {
        reason: 'device_not_found',
        recovery: { hint: `Call macos_control_audio with action=list to see available devices.` },
      });
    }
    // Use exact matched name — never raw user input
    await this.run(['-s', match.name, '-t', type], ctx);
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
