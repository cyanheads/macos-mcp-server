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
    const allLines = await this.run(['-a', '-f', 'dict'], ctx);
    const [currentOutput, currentInput] = await Promise.all([
      this.getCurrentDevice('output', ctx),
      this.getCurrentDevice('input', ctx),
    ]);

    /**
     * -f dict output format: { "name" : "MacBook Air Microphone", "type" : "input" } per line.
     * Falls back to plain list (-a only) if dict format returns nothing.
     */
    const devices: AudioDevice[] = [];
    for (const line of allLines.split('\n').filter(Boolean)) {
      try {
        // Try dict format: { "name" : "...", "type" : "input"|"output" }
        const nameMatch = line.match(/"name"\s*:\s*"([^"]+)"/);
        const typeMatch = line.match(/"type"\s*:\s*"(input|output)"/);
        if (nameMatch && typeMatch) {
          const name = nameMatch[1]!;
          const devType = typeMatch[1] as 'input' | 'output';
          if (type !== 'all' && devType !== type) continue;
          devices.push({
            id: name, // SwitchAudioSource uses name as the identifier
            name,
            type: devType,
            is_default: devType === 'output' ? name === currentOutput : name === currentInput,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }

    // If dict format returned nothing, fall back to plain text (-a only)
    if (devices.length === 0) {
      const plainOut = await this.run(['-a'], ctx);
      for (const line of plainOut.split('\n').filter(Boolean)) {
        const name = line.trim();
        if (!name) continue;
        // We can't tell type from plain list — add as output by convention
        if (type === 'input') continue; // Can't enumerate input-only in plain mode
        devices.push({
          id: name,
          name,
          type: 'output',
          is_default: name === currentOutput,
        });
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
