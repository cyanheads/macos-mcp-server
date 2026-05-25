/**
 * @fileoverview Unit tests for AudioService.listDevices — JSON parsing fix for SwitchAudioSource 1.2.2.
 * @module tests/services/audio-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioService } from '@/services/audio/audio-service.js';

// Mock execFile at the module level so we control SwitchAudioSource output
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile as execFileCb } from 'node:child_process';

const JSON_LINES = [
  '{"name": "MacBook Pro Speakers", "type": "output", "id": "76", "uid": "BuiltInSpeakerDevice"}',
  '{"name": "MacBook Pro Microphone", "type": "input", "id": "83", "uid": "BuiltInMicrophoneDevice"}',
  '{"name": "External Headphones", "type": "output", "id": "99", "uid": "ExternalHeadphones"}',
].join('\n');

describe('AudioService.listDevices', () => {
  let svc: AudioService;

  beforeEach(() => {
    svc = new AudioService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses -f json output and returns all devices', async () => {
    vi.mocked(execFileCb).mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        if (args.includes('-f') && args.includes('json')) {
          cb(null, { stdout: JSON_LINES, stderr: '' });
        } else if (args.includes('-c')) {
          const isInput = args.includes('input');
          cb(null, {
            stdout: isInput ? 'MacBook Pro Microphone\n' : 'MacBook Pro Speakers\n',
            stderr: '',
          });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
        return { pid: 1 } as never;
      },
    );

    const ctx = createMockContext();
    const devices = await svc.listDevices(ctx);
    expect(devices).toHaveLength(3);
    expect(devices.find((d) => d.type === 'output' && d.is_default)?.name).toBe(
      'MacBook Pro Speakers',
    );
    expect(devices.find((d) => d.type === 'input' && d.is_default)?.name).toBe(
      'MacBook Pro Microphone',
    );
  });

  it('filters by type=output', async () => {
    vi.mocked(execFileCb).mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        if (args.includes('-f') && args.includes('json')) {
          cb(null, { stdout: JSON_LINES, stderr: '' });
        } else if (args.includes('-c')) {
          cb(null, { stdout: 'MacBook Pro Speakers\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
        return { pid: 1 } as never;
      },
    );

    const ctx = createMockContext();
    const devices = await svc.listDevices(ctx, 'output');
    expect(devices.every((d) => d.type === 'output')).toBe(true);
    expect(devices).toHaveLength(2);
  });

  it('throws switchaudio_unavailable when binary is missing (ENOENT)', async () => {
    vi.mocked(execFileCb).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: NodeJS.ErrnoException) => void) => {
        cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        return { pid: 1 } as never;
      },
    );
    const ctx = createMockContext();
    await expect(svc.listDevices(ctx)).rejects.toMatchObject({
      data: { reason: 'switchaudio_unavailable' },
    });
  });
});
