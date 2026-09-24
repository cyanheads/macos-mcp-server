/**
 * @fileoverview Unit tests for AudioService.listDevices — JSON parsing fix for SwitchAudioSource 1.2.2.
 * @module tests/services/audio-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioService } from '@/services/audio/audio-service.js';

/**
 * Shape of the mocked `execFile`. The service wraps it in `promisify`, and the
 * module mock carries no `util.promisify.custom` hook, so promisify takes the
 * generic path and resolves with the callback's second argument. That is the
 * contract these mocks implement — not Node's own `execFile` overloads.
 */
type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

// Mock execFile at the module level so we control SwitchAudioSource output
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

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
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
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
      return { pid: 1 };
    });

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
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args.includes('-f') && args.includes('json')) {
        cb(null, { stdout: JSON_LINES, stderr: '' });
      } else if (args.includes('-c')) {
        cb(null, { stdout: 'MacBook Pro Speakers\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return { pid: 1 };
    });

    const ctx = createMockContext();
    const devices = await svc.listDevices(ctx, 'output');
    expect(devices.every((d) => d.type === 'output')).toBe(true);
    expect(devices).toHaveLength(2);
  });

  it('throws switchaudio_unavailable when binary is missing (ENOENT)', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return { pid: 1 };
    });
    const ctx = createMockContext();
    await expect(svc.listDevices(ctx)).rejects.toMatchObject({
      data: { reason: 'switchaudio_unavailable' },
    });
  });

  it('keeps the command line and argv out of any other CLI failure', async () => {
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      cb(
        Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\ndevice busy`), {
          code: 1 as unknown as string,
          stderr: 'device busy',
        }),
      );
      return { pid: 1 };
    });
    const ctx = createMockContext();
    const err = (await svc.getCurrentDevice('output', ctx).catch((e: unknown) => e)) as Error & {
      data?: unknown;
    };
    expect(err.message).toContain('device busy');
    expect(err.message).not.toContain('Command failed');
    expect(err.message).not.toContain('/opt/homebrew/bin/SwitchAudioSource');
    expect(JSON.stringify(err.data ?? {})).not.toContain('-t');
  });
});
