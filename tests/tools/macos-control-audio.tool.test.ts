/**
 * @fileoverview Tests for macos_control_audio tool.
 * @module tests/tools/macos-control-audio.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/audio/audio-service.js', () => ({
  getAudioService: vi.fn(),
  initAudioService: vi.fn(),
}));

import { macosControlAudio } from '@/mcp-server/tools/definitions/macos-control-audio.tool.js';
import { getAudioService } from '@/services/audio/audio-service.js';
import { commonMarkBlocks } from '../helpers/commonmark.js';

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

/** An AudioService stub that answers each type's current device as the service would. */
function makeAudioService() {
  return {
    listDevices: vi.fn(async (_ctx: unknown, type: string) =>
      mockDevices.filter((d) => type === 'all' || d.type === type),
    ),
    getCurrentDevice: vi.fn(
      async (type: string): Promise<string> =>
        type === 'input' ? 'MacBook Pro Microphone' : 'MacBook Pro Speakers',
    ),
    switchDevice: vi.fn().mockResolvedValue(undefined),
  };
}

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');

const LINE = {
  speakers:
    '- name: `MacBook Pro Speakers` id: `MacBook Pro Speakers` type: output is_default: true',
  microphone:
    '- name: `MacBook Pro Microphone` id: `MacBook Pro Microphone` type: input is_default: true',
  headphones:
    '- name: `External Headphones` id: `External Headphones` type: output is_default: false',
};

/** Values whose markdown would take effect, or whose line ending would change, if rendered raw. */
const MARKDOWN_VALUES = [
  'a`b`c',
  'x``y`z``w',
  '*not emphasis*',
  '[x](https://example.com)',
  '\\*kept\\*',
  'one\r\ntwo',
  'line\n# heading',
];

describe('macosControlAudio', () => {
  let svc: ReturnType<typeof makeAudioService>;

  beforeEach(() => {
    svc = makeAudioService();
    vi.mocked(getAudioService).mockReturnValue(svc as never);
  });

  it.each([
    [{}, 'all', mockDevices, [LINE.speakers, LINE.microphone, LINE.headphones]],
    [
      { type: 'output' },
      'output',
      [mockDevices[0], mockDevices[2]],
      [LINE.speakers, LINE.headphones],
    ],
  ] as const)(
    'list %j asks the service for type=%s and renders every device on both surfaces',
    async (args, type, devices, lines) => {
      const result = await runToolContract(macosControlAudio, { action: 'list', ...args });
      expect(svc.listDevices).toHaveBeenCalledWith(expect.anything(), type);
      expect(result.structuredContent).toEqual({ action: 'list', devices });
      expect(textOf(result)).toBe(
        [`**action:** list`, `## Audio Devices (${devices.length})`, ...lines].join('\n'),
      );
    },
  );

  it('current reports the default output and input on both surfaces', async () => {
    const result = await runToolContract(macosControlAudio, { action: 'current' });
    expect(result.structuredContent).toEqual({
      action: 'current',
      output: { id: 'MacBook Pro Speakers', name: 'MacBook Pro Speakers' },
      input: { id: 'MacBook Pro Microphone', name: 'MacBook Pro Microphone' },
    });
    expect(textOf(result)).toBe(
      '**action:** current\noutput: name: `MacBook Pro Speakers` id: `MacBook Pro Speakers`\ninput: name: `MacBook Pro Microphone` id: `MacBook Pro Microphone`',
    );
  });

  it.each(MARKDOWN_VALUES)(
    'list, current, and switch_output with a device named %j read it back from content[] exactly as structuredContent carries it',
    async (value) => {
      const devices = [
        { id: `id ${value}`, name: value, type: 'output' as const, is_default: true },
        { id: `mic ${value}`, name: `${value} mic`, type: 'input' as const, is_default: true },
      ];
      svc.listDevices.mockResolvedValue(devices);
      svc.getCurrentDevice.mockImplementation(async (type: string) =>
        type === 'input' ? `${value} mic` : value,
      );
      const listed = await runToolContract(macosControlAudio, { action: 'list' });
      expect(listed.structuredContent).toEqual({ action: 'list', devices });
      expect(commonMarkBlocks(textOf(listed))).toEqual([
        'action: list',
        'Audio Devices (2)',
        `name: ${value} id: id ${value} type: output is_default: true`,
        `name: ${value} mic id: mic ${value} type: input is_default: true`,
      ]);
      const current = await runToolContract(macosControlAudio, { action: 'current' });
      expect(current.structuredContent).toEqual({
        action: 'current',
        output: { id: value, name: value },
        input: { id: `${value} mic`, name: `${value} mic` },
      });
      expect(commonMarkBlocks(textOf(current))).toEqual([
        `action: current\noutput: name: ${value} id: ${value}\ninput: name: ${value} mic id: ${value} mic`,
      ]);
      const switched = await runToolContract(macosControlAudio, {
        action: 'switch_output',
        device: 'x',
      });
      expect(switched.structuredContent).toEqual({
        action: 'switch_output',
        success: true,
        device: { id: value, name: value },
      });
      expect(commonMarkBlocks(textOf(switched))).toEqual([
        `action: switch_output\ndevice: name: ${value} id: ${value}\nsuccess: true`,
      ]);
    },
  );

  it.each([
    ['switch_output', 'output', 'Headphones', 'External Headphones'],
    ['switch_input', 'input', 'micro', 'MacBook Pro Microphone'],
  ] as const)(
    '%s switches the %s device, then reports the new default on both surfaces',
    async (action, type, device, now) => {
      svc.getCurrentDevice.mockResolvedValue(now);
      const result = await runToolContract(macosControlAudio, { action, device });
      expect(svc.switchDevice).toHaveBeenCalledWith(device, type, expect.anything());
      expect(svc.getCurrentDevice).toHaveBeenCalledWith(type, expect.anything());
      expect(result.structuredContent).toEqual({
        action,
        success: true,
        device: { id: now, name: now },
      });
      expect(textOf(result)).toBe(
        `**action:** ${action}\ndevice: name: \`${now}\` id: \`${now}\`\nsuccess: true`,
      );
    },
  );

  it('switch_output forwards the service device_not_found for a present-but-unknown device', async () => {
    svc.switchDevice.mockRejectedValue(
      Object.assign(new Error('No output device matching "Zz" found.'), {
        code: -32001,
        data: { reason: 'device_not_found' },
      }),
    );
    const ctx = createMockContext({ errors: macosControlAudio.errors });
    await expect(
      macosControlAudio.handler(
        macosControlAudio.input.parse({ action: 'switch_output', device: 'Zz' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'device_not_found' } });
  });

  it('switch_input with a blank device is rejected by the input schema', () => {
    expect(() => macosControlAudio.input.parse({ action: 'switch_input', device: '' })).toThrow();
  });

  it('declares both reasons as service-thrown, switchaudio_unavailable naming every location searched', () => {
    expect(macosControlAudio.errors).toMatchObject([
      { reason: 'device_not_found', thrownBy: 'service' },
      {
        reason: 'switchaudio_unavailable',
        when: 'The SwitchAudioSource CLI is not on PATH or in either Homebrew bin directory (/opt/homebrew/bin, /usr/local/bin).',
        recovery: 'Install with: brew install switchaudio-osx',
        thrownBy: 'service',
      },
    ]);
  });
});
