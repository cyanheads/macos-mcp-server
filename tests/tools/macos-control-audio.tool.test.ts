/**
 * @fileoverview Tests for macos_control_audio tool.
 * @module tests/tools/macos-control-audio.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/audio/audio-service.js', () => ({
  getAudioService: vi.fn(),
  initAudioService: vi.fn(),
}));

import { macosControlAudio } from '@/mcp-server/tools/definitions/macos-control-audio.tool.js';
import { getAudioService } from '@/services/audio/audio-service.js';

const mockDevices = [
  {
    id: 'MacBook Pro Speakers',
    name: 'MacBook Pro Speakers',
    type: 'output' as const,
    is_default: true,
  },
  {
    id: 'MacBook Pro Microphone',
    name: 'MacBook Pro Microphone',
    type: 'input' as const,
    is_default: true,
  },
  {
    id: 'External Headphones',
    name: 'External Headphones',
    type: 'output' as const,
    is_default: false,
  },
];

function makeAudioService() {
  return {
    listDevices: vi.fn().mockResolvedValue(mockDevices),
    getCurrentDevice: vi.fn().mockResolvedValue('MacBook Pro Speakers'),
    switchDevice: vi.fn().mockResolvedValue(undefined),
  };
}

describe('macosControlAudio', () => {
  beforeEach(() => {
    vi.mocked(getAudioService).mockReturnValue(makeAudioService() as never);
  });

  it('list returns all devices', async () => {
    const ctx = createMockContext();
    const result = await macosControlAudio.handler(
      macosControlAudio.input.parse({ action: 'list' }),
      ctx,
    );
    expect(result.action).toBe('list');
    expect(result.devices).toHaveLength(3);
  });

  it('list filters by type=output', async () => {
    const svc = makeAudioService();
    svc.listDevices.mockResolvedValue(mockDevices.filter((d) => d.type === 'output'));
    vi.mocked(getAudioService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    const result = await macosControlAudio.handler(
      macosControlAudio.input.parse({ action: 'list', type: 'output' }),
      ctx,
    );
    expect(result.devices?.every((d) => d.type === 'output')).toBe(true);
  });

  it('current returns default input and output', async () => {
    const svc = makeAudioService();
    svc.getCurrentDevice
      .mockResolvedValueOnce('MacBook Pro Speakers') // output
      .mockResolvedValueOnce('MacBook Pro Microphone'); // input
    vi.mocked(getAudioService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    const result = await macosControlAudio.handler(
      macosControlAudio.input.parse({ action: 'current' }),
      ctx,
    );
    expect(result.output?.name).toBe('MacBook Pro Speakers');
    expect(result.input?.name).toBe('MacBook Pro Microphone');
  });

  it('switch_output requires device param', async () => {
    const ctx = createMockContext({ errors: macosControlAudio.errors });
    await expect(
      macosControlAudio.handler(macosControlAudio.input.parse({ action: 'switch_output' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'device_not_found' } });
  });

  it('switch_output calls switchDevice and returns new default', async () => {
    const svc = makeAudioService();
    svc.getCurrentDevice.mockResolvedValue('External Headphones');
    vi.mocked(getAudioService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    const result = await macosControlAudio.handler(
      macosControlAudio.input.parse({ action: 'switch_output', device: 'Headphones' }),
      ctx,
    );
    expect(svc.switchDevice).toHaveBeenCalledWith('Headphones', 'output', ctx);
    expect(result.device?.name).toBe('External Headphones');
  });

  it('switch_input requires device param', async () => {
    const ctx = createMockContext({ errors: macosControlAudio.errors });
    await expect(
      macosControlAudio.handler(macosControlAudio.input.parse({ action: 'switch_input' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'device_not_found' } });
  });

  it('formats list output with device details', () => {
    const blocks = macosControlAudio.format!({
      action: 'list',
      devices: mockDevices,
    } as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('MacBook Pro Speakers');
    expect(text).toContain('MacBook Pro Microphone');
    expect(text).toContain('output');
    expect(text).toContain('input');
  });

  it('formats current output with names and ids', () => {
    const blocks = macosControlAudio.format!({
      action: 'current',
      output: { id: 'speakers', name: 'Speakers' },
      input: { id: 'mic', name: 'Microphone' },
    } as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Speakers');
    expect(text).toContain('Microphone');
  });
});
