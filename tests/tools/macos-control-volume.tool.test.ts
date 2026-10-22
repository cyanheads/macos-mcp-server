/**
 * @fileoverview Tests for macos_control_volume tool, through the real
 * OsascriptService over a faked `execFile`. osascript answers each script the
 * way it does for a default output in a given state, and system_profiler with
 * an audio profile; a run whose signal has fired rejects with an AbortError, as
 * Node's execFile does.
 * @module tests/tools/macos-control-volume.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shape of the mocked `execFile`. Callers wrap it in `promisify`, and the module
 * mock carries no `util.promisify.custom` hook, so promisify takes the generic
 * path and resolves with the callback's second argument.
 */
type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { macosControlVolume } from '@/mcp-server/tools/definitions/macos-control-volume.tool.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { initOsascriptService } from '@/services/osascript/osascript-service.js';
import { commonMarkBlocks } from '../helpers/commonmark.js';

/** The read-back script the tool sends, which coerces each field to text. */
const READ_BACK =
  'set vs to get volume settings\nreturn (output volume of vs as text) & "," & (output muted of vs as text)';

type Field<T> = T | 'missing value';

interface OutputState {
  level: Field<number>;
  muted: Field<boolean>;
}

const NO_VOLUME: OutputState = { level: 'missing value', muted: 'missing value' };

/**
 * `system_profiler SPAudioDataType -json` as measured live, with the default
 * output moved to an HDMI display (the state the server cannot produce in a
 * test without switching the output).
 */
const SP_AUDIO_HDMI_DEFAULT = JSON.stringify({
  SPAudioDataType: [
    {
      _items: [
        {
          _name: 'ROG PG279Q',
          coreaudio_device_manufacturer: 'ACI',
          coreaudio_device_output: 2,
          coreaudio_device_srate: 48000,
          coreaudio_device_transport: 'coreaudio_device_type_hdmi',
          coreaudio_output_source: 'spaudio_default',
        },
        {
          _name: 'Gigabyte M32U',
          coreaudio_default_audio_output_device: 'spaudio_yes',
          coreaudio_device_manufacturer: 'GBT',
          coreaudio_device_output: 2,
          coreaudio_device_srate: 48000,
          coreaudio_device_transport: 'coreaudio_device_type_hdmi',
          coreaudio_output_source: 'spaudio_default',
        },
        {
          _name: 'HD Pro Webcam C920',
          coreaudio_default_audio_input_device: 'spaudio_yes',
          coreaudio_device_input: 2,
          coreaudio_device_manufacturer: 'Unknown Manufacturer',
          coreaudio_device_srate: 32000,
          coreaudio_device_transport: 'coreaudio_device_type_usb',
          coreaudio_input_source: 'spaudio_default',
        },
        {
          _name: 'MacBook Pro Speakers',
          _properties: 'coreaudio_default_audio_system_device',
          coreaudio_default_audio_system_device: 'spaudio_yes',
          coreaudio_device_manufacturer: 'Apple Inc.',
          coreaudio_device_output: 2,
          coreaudio_device_srate: 48000,
          coreaudio_device_transport: 'coreaudio_device_type_builtin',
          coreaudio_output_source: 'MacBook Pro Speakers',
        },
      ],
      _name: 'coreaudio_device',
    },
  ],
});

/** A profile in which no device carries the default-output flag. */
const SP_AUDIO_NO_DEFAULT_OUTPUT = JSON.stringify({
  SPAudioDataType: [
    {
      _items: [
        {
          _name: 'HD Pro Webcam C920',
          coreaudio_default_audio_input_device: 'spaudio_yes',
          coreaudio_device_input: 2,
        },
      ],
      _name: 'coreaudio_device',
    },
  ],
});

/** A profile whose one device, the default output, is named `name`. */
const spAudioDefaultOutput = (name: string) =>
  JSON.stringify({
    SPAudioDataType: [
      {
        _items: [
          {
            _name: name,
            coreaudio_default_audio_output_device: 'spaudio_yes',
            coreaudio_device_output: 2,
          },
        ],
        _name: 'coreaudio_device',
      },
    ],
  });

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

/** Node's execFile rejection for a run whose signal fired. */
const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

/**
 * What osascript prints for `script` on an output in `state`. Measured live:
 * the coerced read-back prints `40,false`, a read-back that joins the raw
 * values with `&` builds a list and prints `40, ,, false`, and an output with
 * no software volume reads `missing value` for a field. `set volume` updates
 * the state (on a field the output has) and prints nothing.
 */
function osascriptPrints(state: OutputState, script: string): string {
  if (script.includes('get volume settings')) {
    return script === READ_BACK
      ? `${state.level},${state.muted}\n`
      : `${state.level}, ,, ${state.muted}\n`;
  }
  const level = /^set volume output volume (\d+)/.exec(script)?.[1];
  if (level !== undefined && state.level !== 'missing value') state.level = Number(level);
  if (state.muted !== 'missing value') {
    if (script.endsWith('without output muted')) state.muted = false;
    else if (script.endsWith('with output muted')) state.muted = true;
  }
  return '';
}

/**
 * Answers osascript over a default output in `output`, and system_profiler with
 * `profile` (null: it exits 1). Starting `cancel.on` aborts `cancel.controller`
 * first, so the cancel lands while that program runs.
 */
function answer({
  output,
  profile = SP_AUDIO_HDMI_DEFAULT,
  cancel,
}: {
  output: OutputState;
  profile?: string | null;
  cancel?: { controller: AbortController; on: string };
}): void {
  const state = { ...output };
  execFileMock.mockImplementation((cmd, args, opts, cb) => {
    if (cmd === cancel?.on) cancel.controller.abort();
    if ((opts as { signal?: AbortSignal }).signal?.aborted) cb(abortError());
    else if (cmd !== SYSTEM_BINARIES.system_profiler) {
      cb(null, { stdout: osascriptPrints(state, args.at(-1) ?? ''), stderr: '' });
    } else if (profile === null) {
      cb(
        Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}`), {
          code: 1 as unknown as string,
          stderr: '',
        }),
      );
    } else cb(null, { stdout: profile, stderr: '' });
    return { pid: 1 };
  });
}

/** Every subprocess the call ran, program and argv, in order. */
const runs = () => execFileMock.mock.calls.map((c) => [c[0], c[1]]);

const readBack = [SYSTEM_BINARIES.osascript, ['-e', READ_BACK]];
const osascript = (script: string) => [SYSTEM_BINARIES.osascript, ['-e', script]];
const profiler = [SYSTEM_BINARIES.system_profiler, ['SPAudioDataType', '-json']];

const VOLUME_UNSUPPORTED_RECOVERY = macosControlVolume.errors?.find(
  (e) => e.reason === 'volume_unsupported',
)?.recovery;

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');

beforeEach(() => {
  execFileMock.mockReset();
  initOsascriptService({} as never, {} as never);
  answer({ output: { level: 50, muted: false } });
});

describe('macosControlVolume get', () => {
  it.each([
    {
      label: 'an unmuted output',
      output: { level: 75, muted: false },
      structured: { action: 'get', level: 75, muted: false },
      text: '**action:** get\n**Volume:** 75% — Unmuted',
      ran: [readBack],
    },
    {
      label: 'a muted output',
      output: { level: 40, muted: true },
      structured: { action: 'get', level: 40, muted: true },
      text: '**action:** get\n**Volume:** 40% — Muted',
      ran: [readBack],
    },
    {
      label: 'a muted output at level 0',
      output: { level: 0, muted: true },
      structured: { action: 'get', level: 0, muted: true },
      text: '**action:** get\n**Volume:** 0% — Muted',
      ran: [readBack],
    },
    {
      label: 'an output with a level but no mute control',
      output: { level: 40, muted: 'missing value' },
      structured: { action: 'get', level: 40, muted: null, output_device: 'Gigabyte M32U' },
      text: '**action:** get\n**Volume:** 40% — mute unavailable\n**Output device:** `Gigabyte M32U`',
      ran: [readBack, profiler],
    },
    {
      label: 'an output with a mute control but no level',
      output: { level: 'missing value', muted: false },
      structured: { action: 'get', level: null, muted: false, output_device: 'Gigabyte M32U' },
      text: '**action:** get\n**Volume:** level unavailable — Unmuted\n**Output device:** `Gigabyte M32U`',
      ran: [readBack, profiler],
    },
    {
      label: 'an output with no software volume',
      output: NO_VOLUME,
      structured: { action: 'get', level: null, muted: null, output_device: 'Gigabyte M32U' },
      text: '**action:** get\n**Volume:** unavailable — the default output has no software volume control\n**Output device:** `Gigabyte M32U`',
      ran: [readBack, profiler],
    },
    {
      label: 'an output with no software volume in a profile naming no default output',
      output: NO_VOLUME,
      profile: SP_AUDIO_NO_DEFAULT_OUTPUT,
      structured: { action: 'get', level: null, muted: null, output_device: null },
      text: '**action:** get\n**Volume:** unavailable — the default output has no software volume control\n**Output device:** (not identified)',
      ran: [readBack, profiler],
    },
    {
      label: 'an output with no software volume while system_profiler fails',
      output: NO_VOLUME,
      profile: null,
      structured: { action: 'get', level: null, muted: null, output_device: null },
      text: '**action:** get\n**Volume:** unavailable — the default output has no software volume control\n**Output device:** (not identified)',
      ran: [readBack, profiler],
    },
  ] as const)(
    'get on $label reads one coerced read-back onto both surfaces',
    async ({ output, profile, structured, text, ran }) => {
      answer({ output, ...(profile !== undefined && { profile }) });
      const result = await runToolContract(macosControlVolume, { action: 'get' });
      expect(result.structuredContent).toEqual(structured);
      expect(textOf(result)).toBe(text);
      expect(runs()).toEqual(ran);
    },
  );

  it.each(MARKDOWN_VALUES)(
    'get on an output named %j reads its name back from content[] exactly as structuredContent carries it',
    async (name) => {
      answer({ output: NO_VOLUME, profile: spAudioDefaultOutput(name) });
      const result = await runToolContract(macosControlVolume, { action: 'get' });
      expect(result.structuredContent).toEqual({
        action: 'get',
        level: null,
        muted: null,
        output_device: name,
      });
      expect(commonMarkBlocks(textOf(result))).toEqual([
        `action: get\nVolume: unavailable — the default output has no software volume control\nOutput device: ${name}`,
      ]);
    },
  );

  it('get accepts off-action level and muted arguments and writes nothing', async () => {
    const result = await runToolContract(macosControlVolume, {
      action: 'get',
      level: 10,
      muted: true,
    });
    expect(result.structuredContent).toEqual({ action: 'get', level: 50, muted: false });
    expect(runs()).toEqual([readBack]);
  });

  it('a read-back the parser does not recognize fails instead of inventing a level', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '40, ,, false\n', stderr: '' });
      return { pid: 1 };
    });
    await expect(
      macosControlVolume.handler(
        macosControlVolume.input.parse({ action: 'get' }),
        createMockContext({ errors: macosControlVolume.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Unexpected volume read-back from osascript: 40, ,, false',
    });
  });

  it('get passes the caller’s signal to system_profiler and settles a cancel during that lookup as RequestCancelled, never output_device null', async () => {
    const controller = new AbortController();
    answer({ output: NO_VOLUME, cancel: { controller, on: SYSTEM_BINARIES.system_profiler } });
    const result = await runToolContract(
      macosControlVolume,
      { action: 'get' },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(runs()).toEqual([readBack, profiler]);
    const opts = execFileMock.mock.calls[1]?.[2] as { timeout?: number; signal?: AbortSignal };
    expect(opts.timeout).toBe(10_000);
    expect(opts.signal).toBe(controller.signal);
  });
});

describe('macosControlVolume set', () => {
  it.each([
    {
      label: 'level',
      args: { level: 60 },
      output: { level: 40, muted: false },
      structured: { action: 'set', level: 60, muted: false },
      text: '**action:** set\n**Volume:** 60% — Unmuted',
      ran: [readBack, osascript('set volume output volume 60'), readBack],
    },
    {
      label: 'muted=true',
      args: { muted: true },
      output: { level: 50, muted: false },
      structured: { action: 'set', level: 50, muted: true },
      text: '**action:** set\n**Volume:** 50% — Muted',
      ran: [readBack, osascript('set volume with output muted'), readBack],
    },
    {
      label: 'level and muted together',
      args: { level: 30, muted: false },
      output: { level: 50, muted: true },
      structured: { action: 'set', level: 30, muted: false },
      text: '**action:** set\n**Volume:** 30% — Unmuted',
      ran: [readBack, osascript('set volume output volume 30 without output muted'), readBack],
    },
    {
      label: 'a fractional level, rounded',
      args: { level: 33.6, muted: true },
      output: { level: 50, muted: false },
      structured: { action: 'set', level: 34, muted: true },
      text: '**action:** set\n**Volume:** 34% — Muted',
      ran: [readBack, osascript('set volume output volume 34 with output muted'), readBack],
    },
    {
      label: 'level on an output with a level but no mute control',
      args: { level: 70 },
      output: { level: 40, muted: 'missing value' },
      structured: { action: 'set', level: 70, muted: null, output_device: 'Gigabyte M32U' },
      text: '**action:** set\n**Volume:** 70% — mute unavailable\n**Output device:** `Gigabyte M32U`',
      ran: [readBack, osascript('set volume output volume 70'), readBack, profiler],
    },
  ] as const)(
    'set with $label checks the output, sends one set volume, and reads the new state back onto both surfaces',
    async ({ args, output, structured, text, ran }) => {
      answer({ output });
      const result = await runToolContract(macosControlVolume, { action: 'set', ...args });
      expect(result.structuredContent).toEqual(structured);
      expect(textOf(result)).toBe(text);
      expect(runs()).toEqual(ran);
    },
  );

  it.each([
    {
      label: 'level on an output with no software volume',
      args: { level: 40 },
      output: NO_VOLUME,
      message: 'The default output "Gigabyte M32U" has no software volume control.',
    },
    {
      label: 'muted on an output with no software volume',
      args: { muted: true },
      output: NO_VOLUME,
      message: 'The default output "Gigabyte M32U" has no software volume control.',
    },
    {
      label: 'level and muted on an output with no software volume',
      args: { level: 40, muted: false },
      output: NO_VOLUME,
      message: 'The default output "Gigabyte M32U" has no software volume control.',
    },
    {
      label: 'muted on an output with a level but no mute control',
      args: { muted: true },
      output: { level: 40, muted: 'missing value' },
      message: 'The default output "Gigabyte M32U" has no software mute control.',
    },
    {
      label: 'level on an output with no software volume in a profile naming no default output',
      args: { level: 40 },
      output: NO_VOLUME,
      profile: SP_AUDIO_NO_DEFAULT_OUTPUT,
      message: 'The default output has no software volume control.',
    },
  ] as const)(
    'set with $label fails as volume_unsupported and sends no set volume',
    async ({ args, output, profile, message }) => {
      answer({ output, ...(profile !== undefined && { profile }) });
      const result = await runToolContract(macosControlVolume, { action: 'set', ...args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.Conflict,
          message,
          data: { reason: 'volume_unsupported', recovery: { hint: VOLUME_UNSUPPORTED_RECOVERY } },
        },
      });
      expect(runs()).toEqual([readBack, profiler]);
    },
  );

  it('set names an output holding a quote, a backslash, or a control character as its JSON string', async () => {
    const name = 'Desk "Mon" \\ itor\n2\u0007';
    answer({ output: NO_VOLUME, profile: spAudioDefaultOutput(name) });
    const result = await runToolContract(macosControlVolume, { action: 'set', level: 40 });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Conflict,
        message:
          'The default output "Desk \\"Mon\\" \\\\ itor\\n2\\u0007" has no software volume control.',
        data: { reason: 'volume_unsupported' },
      },
    });
    expect(runs()).toEqual([readBack, profiler]);
  });

  it('set on an output with no software volume rethrows a cancel during the device lookup, not volume_unsupported', async () => {
    const controller = new AbortController();
    answer({ output: NO_VOLUME, cancel: { controller, on: SYSTEM_BINARIES.system_profiler } });
    const err = await Promise.resolve(
      macosControlVolume.handler(
        macosControlVolume.input.parse({ action: 'set', level: 40 }),
        createMockContext({ errors: macosControlVolume.errors, signal: controller.signal }),
      ),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(err).not.toHaveProperty('data');
    expect(runs()).toEqual([readBack, profiler]);
  });
});
