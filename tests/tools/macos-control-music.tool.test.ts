/**
 * @fileoverview Tests for macos_control_music, at two seams. The scripts the
 * tool builds run in a `node:vm` sandbox against a fake Music that records
 * every property read, command, and assignment it receives, so the JXA logic —
 * the running check before any event, the command, the read-back, the -1728
 * catch — runs as written; `osacompile` then confirms JXA itself accepts each
 * script, compiling without running it. The handler runs through the real
 * OsascriptService over a faked `execFile` that answers each script the way
 * osascript prints it, so a denial carries the reason the service gives it.
 * Nothing here sends Music an Apple event.
 * @module tests/tools/macos-control-music.tool.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shape of the mocked `execFile`. The service wraps it in `promisify`, and the
 * module mock carries no `util.promisify.custom` hook, so promisify takes the
 * generic path and resolves with the callback's second argument.
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

import {
  macosControlMusic,
  musicScript,
  playlistLookupScript,
} from '@/mcp-server/tools/definitions/macos-control-music.tool.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { initOsascriptService } from '@/services/osascript/osascript-service.js';
import { commonMarkBlocks } from '../helpers/commonmark.js';

type MusicInput = Parameters<typeof musicScript>[0];
type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

// --- The JXA sandbox ---

/** A track as the fake Music holds it; `throws` makes every read of it fail with that errorNumber. */
type FakeTrack =
  | { name: string; artist: string | null; album: string | null }
  | { throws: number }
  | null;

interface FakeMusicState {
  /** A property whose read fails with this errorNumber, as a denied Apple event does. */
  deny?: { property: string; errorNumber: number };
  /** Playlist names in Music's order; `byName` reaches the first exact match. */
  playlists?: string[];
  repeat?: string;
  running: boolean;
  shuffle?: boolean;
  state?: string;
  track?: FakeTrack;
}

/** An Error carrying the errorNumber JXA puts on a failed Apple event. */
const appleEventError = (errorNumber: number) =>
  Object.assign(new Error(`Apple event failed (${errorNumber})`), { errorNumber });

/**
 * A Music application object that records each Apple event a script would
 * send: a property read, a command, or an assignment. `running()` is recorded
 * too, though it is answered by Launch Services rather than an event to Music.
 */
function fakeMusic(initial: FakeMusicState) {
  const events: string[] = [];
  const state = { ...initial };
  const read = (property: string, value: unknown) => () => {
    events.push(property);
    if (state.deny?.property === property) throw appleEventError(state.deny.errorNumber);
    return value;
  };
  const playlist = (name: string) => {
    const match = state.playlists?.find((p) => p === name);
    return {
      requested: name,
      exists: read(`playlist(${name}).exists`, match !== undefined),
      name: read(`playlist(${name}).name`, match),
    };
  };
  const trackProperty = (property: 'name' | 'artist' | 'album') => () => {
    events.push(`currentTrack.${property}`);
    if (state.deny?.property === `currentTrack.${property}`) {
      throw appleEventError(state.deny.errorNumber);
    }
    const track = state.track ?? null;
    if (track === null) throw appleEventError(-1728);
    if ('throws' in track) throw appleEventError(track.throws);
    return track[property];
  };
  const target: Record<string, unknown> = {
    running: () => {
      events.push('running');
      return state.running;
    },
    play: (spec?: { requested: string }) => {
      events.push(spec ? `play(${spec.requested})` : 'play');
      state.running = true;
    },
    pause: () => events.push('pause'),
    stop: () => events.push('stop'),
    nextTrack: () => events.push('nextTrack'),
    previousTrack: () => events.push('previousTrack'),
    playlists: { byName: (name: string) => playlist(name) },
    currentTrack: {
      name: trackProperty('name'),
      artist: trackProperty('artist'),
      album: trackProperty('album'),
    },
  };
  const music = new Proxy(target, {
    get(t, property: string) {
      if (property === 'playerState') return read('playerState', state.state);
      if (property === 'shuffleEnabled') return read('shuffleEnabled', state.shuffle);
      if (property === 'songRepeat') return read('songRepeat', state.repeat);
      return t[property];
    },
    set(_t, property: string, value) {
      events.push(`set ${property} ${JSON.stringify(value)}`);
      return true;
    },
  });
  return { music, events };
}

/**
 * Runs a generated script as JXA would, against `fake`, and returns what
 * osascript would print: the script's completion value.
 */
function runJxaScript(script: string, fake: ReturnType<typeof fakeMusic>): unknown {
  const applications: string[] = [];
  const result = runInNewContext(script, {
    Application: (name: string) => {
      applications.push(name);
      return fake.music;
    },
  });
  expect(applications.every((name) => name === 'Music')).toBe(true);
  return result;
}

const PLAYING_TRACK = {
  name: 'Clair de Lune',
  artist: 'Claude Debussy',
  album: 'Suite bergamasque',
};

/** A running Music in a typical state, for the cases that only vary one field. */
const RUNNING: FakeMusicState = {
  running: true,
  state: 'playing',
  shuffle: false,
  repeat: 'off',
  track: PLAYING_TRACK,
};

describe('the generated JXA', () => {
  describe.each<[MusicInput['action'], MusicInput]>([
    ['get_current', { action: 'get_current' }],
    ['pause', { action: 'pause' }],
    ['stop', { action: 'stop' }],
    ['next', { action: 'next' }],
    ['previous', { action: 'previous' }],
    ['set_shuffle', { action: 'set_shuffle', shuffle: true }],
    ['set_repeat', { action: 'set_repeat', repeat: 'all' }],
  ])('%s', (_label, input) => {
    it('with Music closed, checks running() and sends Music nothing else', () => {
      const fake = fakeMusic({ running: false });
      expect(runJxaScript(musicScript(input), fake)).toBe('{"running":false}');
      expect(fake.events).toEqual(['running']);
    });
  });

  it.each<[MusicInput, string]>([
    [{ action: 'pause' }, 'pause'],
    [{ action: 'stop' }, 'stop'],
    [{ action: 'next' }, 'nextTrack'],
    [{ action: 'previous' }, 'previousTrack'],
    [{ action: 'set_shuffle', shuffle: true }, 'set shuffleEnabled true'],
    [{ action: 'set_shuffle', shuffle: false }, 'set shuffleEnabled false'],
    [{ action: 'set_repeat', repeat: 'one' }, 'set songRepeat "one"'],
  ])(
    '%j with Music running sends %s, then reads state, shuffle, repeat, and the track',
    (input, command) => {
      const fake = fakeMusic(RUNNING);
      expect(JSON.parse(String(runJxaScript(musicScript(input), fake)))).toEqual({
        running: true,
        state: 'playing',
        shuffle: false,
        repeat: 'off',
        track: PLAYING_TRACK,
      });
      expect(fake.events).toEqual([
        'running',
        command,
        'playerState',
        'shuffleEnabled',
        'songRepeat',
        'currentTrack.name',
        'currentTrack.artist',
        'currentTrack.album',
      ]);
    },
  );

  it('get_current with Music running reads without sending a command', () => {
    const fake = fakeMusic({ ...RUNNING, state: 'paused', shuffle: true, repeat: 'all' });
    runJxaScript(musicScript({ action: 'get_current' }), fake);
    expect(fake.events).toEqual([
      'running',
      'playerState',
      'shuffleEnabled',
      'songRepeat',
      'currentTrack.name',
      'currentTrack.artist',
      'currentTrack.album',
    ]);
  });

  it.each<[MusicInput, string]>([
    [{ action: 'play' }, 'play'],
    [{ action: 'play_playlist', playlist: 'Focus' }, 'play(Focus)'],
  ])(
    '%j skips the running check, so it reaches a closed Music and launches it',
    (input, command) => {
      const fake = fakeMusic({ ...RUNNING, running: false });
      expect(JSON.parse(String(runJxaScript(musicScript(input), fake)))).toMatchObject({
        running: true,
        state: 'playing',
      });
      expect(fake.events[0]).toBe(command);
      expect(fake.events).not.toContain('running');
    },
  );

  it('a -1728 on the current-track read degrades to track null, after state, shuffle, and repeat were read', () => {
    const fake = fakeMusic({ ...RUNNING, shuffle: true, repeat: 'one', track: { throws: -1728 } });
    expect(JSON.parse(String(runJxaScript(musicScript({ action: 'get_current' }), fake)))).toEqual({
      running: true,
      state: 'playing',
      shuffle: true,
      repeat: 'one',
      track: null,
    });
  });

  it.each([
    ['current-track read', { property: 'currentTrack.name', errorNumber: -1743 }],
    ['player-state read', { property: 'playerState', errorNumber: -1743 }],
    ['current-track read, another error', { property: 'currentTrack.artist', errorNumber: -1708 }],
  ])('a failure other than -1728 on the %s propagates with its errorNumber', (_label, deny) => {
    const fake = fakeMusic({ ...RUNNING, deny });
    expect(() => runJxaScript(musicScript({ action: 'get_current' }), fake)).toThrow(
      expect.objectContaining({ errorNumber: deny.errorNumber }),
    );
  });

  describe('play_playlist lookup', () => {
    it('prints the name Music reports for an existing playlist and sends no play', () => {
      const fake = fakeMusic({ running: true, playlists: ['Focus'] });
      expect(runJxaScript(playlistLookupScript('Focus'), fake)).toBe('"Focus"');
      expect(fake.events).toEqual(['playlist(Focus).exists', 'playlist(Focus).name']);
    });

    it('prints null for a playlist Music does not have, sending no play', () => {
      const fake = fakeMusic({ running: true, playlists: ['Focus'] });
      expect(runJxaScript(playlistLookupScript('Nope'), fake)).toBe('null');
      expect(fake.events).toEqual(['playlist(Nope).exists']);
    });
  });

  /** Caller text a JXA string literal must carry exactly, quotes and line breaks included. */
  const PLAYLIST_NAMES = [
    '"); Application("Finder").delete(); ("',
    "'); ObjC.import('Foundation'); //",
    '\\"; process.exit(); //',
    `line\nbreak\r\n\`tick\` \${x}`,
    `sep ${String.fromCharCode(0x2028, 0x2029)}`,
    `lone ${String.fromCharCode(0xd800)} surrogate`,
    '</script><b>',
  ];

  it.each(PLAYLIST_NAMES)(
    'playlist name %j reaches Music exactly as given, in both scripts',
    (name) => {
      const fake = fakeMusic({ ...RUNNING, playlists: [name] });
      expect(JSON.parse(String(runJxaScript(playlistLookupScript(name), fake)))).toBe(name);
      runJxaScript(musicScript({ action: 'play_playlist', playlist: name }), fake);
      expect(fake.events).toContain(`play(${name})`);
    },
  );

  describe('compiles as JXA', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macos-music-jxa-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const SCRIPTS: Array<[string, string]> = [
      ...(
        [
          { action: 'play' },
          { action: 'play_playlist', playlist: PLAYLIST_NAMES[0] ?? '' },
          { action: 'pause' },
          { action: 'stop' },
          { action: 'next' },
          { action: 'previous' },
          { action: 'set_shuffle', shuffle: false },
          { action: 'set_repeat', repeat: 'all' },
          { action: 'get_current' },
        ] satisfies MusicInput[]
      ).map((input): [string, string] => [input.action, musicScript(input)]),
      ...PLAYLIST_NAMES.map((name): [string, string] => [
        `lookup ${JSON.stringify(name)}`,
        playlistLookupScript(name),
      ]),
    ];

    /**
     * osacompile parses and compiles without running the script, so it sends
     * Music no event. It runs through the real execFile: the module mock above
     * stands in for every other subprocess.
     */
    it.each(SCRIPTS)('%s', async (label, script) => {
      const { execFile } =
        await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const out = join(dir, `${label.replace(/\W+/g, '_')}.scpt`);
      await expect(
        promisify(execFile)('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', out, '-e', script]),
      ).resolves.toBeDefined();
    });
  });
});

// --- The handler, through the real OsascriptService ---

/** What a faked osascript run does: print a string, or exit non-zero printing `stderr`. */
type Outcome = string | { stderr: string };

/** Real JXA stderr for an Automation > Music denial. */
const MUSIC_DENIED =
  'execution error: Error: Error: Not authorized to send Apple events to Music. (-1743)';

/** Abort error as Node's execFile rejects a run whose signal fired. */
const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

/**
 * Answers the playlist lookup with `lookup` and every other script with
 * `main`. With `cancel`, starting the run of that script aborts its controller
 * first, and a run whose signal has fired rejects as Node's execFile does.
 */
function answer({
  lookup = 'null',
  main,
  cancel,
}: {
  lookup?: Outcome;
  main: Outcome;
  cancel?: { controller: AbortController; on: 'lookup' | 'main' };
}): void {
  execFileMock.mockImplementation((_cmd, args, opts, cb) => {
    const script = args.at(-1) ?? '';
    const which = script.includes('readState') ? 'main' : 'lookup';
    if (cancel?.on === which) cancel.controller.abort();
    if ((opts as { signal?: AbortSignal }).signal?.aborted) {
      cb(abortError());
      return { pid: 1 };
    }
    const outcome = which === 'main' ? main : lookup;
    if (typeof outcome === 'string') cb(null, { stdout: `${outcome}\n`, stderr: '' });
    else {
      cb(
        Object.assign(new Error('Command failed'), {
          code: 1,
          killed: false,
          stdout: '',
          stderr: outcome.stderr,
        }) as never,
      );
    }
    return { pid: 1 };
  });
}

/** The `{ running: true, … }` line the main script prints. */
const running = (fields: {
  state: string;
  shuffle?: boolean;
  repeat?: string;
  track?: { name: string; artist: string | null; album: string | null } | null;
}) =>
  JSON.stringify({
    running: true,
    state: fields.state,
    shuffle: fields.shuffle ?? false,
    repeat: fields.repeat ?? 'off',
    track: fields.track === undefined ? PLAYING_TRACK : fields.track,
  });

const NOT_RUNNING = '{"running":false}';

/** The scripts osascript ran, in order. */
const scripts = () => execFileMock.mock.calls.map((c) => c[1].at(-1) ?? '');

function contentText(result: ToolResult): string {
  return (result.content ?? []).map((b) => ('text' in b ? String(b.text) : '')).join('\n');
}

/** The error envelope on `structuredContent`. */
function errorOf(result: ToolResult) {
  type Envelope = {
    error?: {
      code?: number;
      message?: string;
      data?: { reason?: string; recovery?: { hint?: string } };
    };
  };
  return (result.structuredContent as Envelope | undefined)?.error;
}

const declaredRecovery = (reason: string) =>
  macosControlMusic.errors?.find((e) => e.reason === reason)?.recovery;

const call = (args: Record<string, unknown>, signal?: AbortSignal) =>
  runToolContract(macosControlMusic, args as never, signal ? { context: { signal } } : undefined);

const TRACK_UNAVAILABLE = (state: string) =>
  `Music is ${state} but would not return the current track (error -1728); recent macOS releases refuse this read for tracks outside the library, such as Apple Music radio or catalog playback.`;

beforeEach(() => {
  execFileMock.mockReset();
  initOsascriptService({} as never, {} as never);
});

describe('macosControlMusic', () => {
  it('warns in its description about the first-use Automation consent dialog', () => {
    expect(macosControlMusic.description).toContain('Automation consent dialog');
  });

  describe.each(['get_current', 'pause', 'stop'])('%s with Music closed', (action) => {
    it('reports running false on both surfaces after one guarded script', async () => {
      answer({ main: NOT_RUNNING });
      const result = await call({ action });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        action,
        running: false,
        player_state: null,
        track: null,
        shuffle: null,
        repeat: null,
      });
      expect(contentText(result).split('\n')).toEqual([
        `**action:** ${action}`,
        '**Running:** no — Music is closed and was left closed',
        '**Player state:** (not running)',
        '**Track:** (none)',
        '**Shuffle:** (not running)',
        '**Repeat:** (not running)',
      ]);
      expect(scripts()).toHaveLength(1);
      expect(scripts()[0]).toContain(
        'if (!music.running()) return JSON.stringify({ running: false });',
      );
    });
  });

  describe.each([
    { action: 'next' },
    { action: 'previous' },
    { action: 'set_shuffle', shuffle: true },
    { action: 'set_repeat', repeat: 'all' },
  ])('$action with Music closed', (args) => {
    it('fails not_running with its declared recovery on both surfaces', async () => {
      answer({ main: NOT_RUNNING });
      const result = await call(args);
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: `Music is not running, so ${args.action} has nothing to act on.`,
        data: { reason: 'not_running', recovery: { hint: declaredRecovery('not_running') } },
      });
      expect(contentText(result).split('\n')).toContain(
        `Recovery: ${declaredRecovery('not_running')}`,
      );
      expect(scripts()).toHaveLength(1);
    });
  });

  it.each([
    ['playing', 'playing'],
    ['paused', 'paused'],
    ['stopped', 'stopped'],
    ['fast forwarding', 'fast_forwarding'],
    ['rewinding', 'rewinding'],
  ])('reads player state %j as %j', async (state, player_state) => {
    answer({ main: running({ state }) });
    const result = await call({ action: 'get_current' });
    expect(result.structuredContent).toMatchObject({ running: true, player_state });
    expect(contentText(result).split('\n')).toContain(`**Player state:** ${player_state}`);
  });

  it('an unrecognized player state is an internal error, not a guess', async () => {
    answer({ main: running({ state: 'buffering' }) });
    const result = await call({ action: 'get_current' });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'The Music script printed output in an unexpected shape.',
    });
  });

  it('reports the full state on both surfaces', async () => {
    answer({ main: running({ state: 'playing', shuffle: true, repeat: 'all' }) });
    const result = await call({ action: 'get_current' });
    expect(result.structuredContent).toEqual({
      action: 'get_current',
      running: true,
      player_state: 'playing',
      track: PLAYING_TRACK,
      shuffle: true,
      repeat: 'all',
    });
    expect(contentText(result).split('\n')).toEqual([
      '**action:** get_current',
      '**Running:** yes',
      '**Player state:** playing',
      '**Track:** `Clair de Lune`',
      '**Artist:** `Claude Debussy`',
      '**Album:** `Suite bergamasque`',
      '**Shuffle:** on',
      '**Repeat:** all',
    ]);
  });

  it.each([
    ['empty', ''],
    ['missing', null],
  ])('reads an %s artist or album as null', async (_label, blank) => {
    answer({
      main: running({ state: 'playing', track: { name: 'Untitled', artist: blank, album: blank } }),
    });
    const result = await call({ action: 'get_current' });
    expect(result.structuredContent).toMatchObject({
      track: { name: 'Untitled', artist: null, album: null },
    });
    const lines = contentText(result).split('\n');
    expect(lines).toContain('**Artist:** (none)');
    expect(lines).toContain('**Album:** (none)');
  });

  it.each(['playing', 'paused', 'fast forwarding'])(
    'a track Music would not return while %s is track null with track_unavailable',
    async (state) => {
      answer({ main: running({ state, track: null }) });
      const result = await call({ action: 'get_current' });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        track: null,
        track_unavailable: TRACK_UNAVAILABLE(state),
      });
      const lines = contentText(result).split('\n');
      expect(lines).toContain('**Track:** (none)');
      expect(lines).toContain(`**Track unavailable:** ${TRACK_UNAVAILABLE(state)}`);
    },
  );

  it('a stopped player with nothing loaded is track null without track_unavailable', async () => {
    answer({ main: running({ state: 'stopped', track: null }) });
    const result = await call({ action: 'stop' });
    expect(result.structuredContent).toEqual({
      action: 'stop',
      running: true,
      player_state: 'stopped',
      track: null,
      shuffle: false,
      repeat: 'off',
    });
    expect(contentText(result)).not.toContain('Track unavailable');
  });

  it('an Automation > Music denial (-1743) is the service’s accessibility_required, never a missing track', async () => {
    answer({ main: { stderr: MUSIC_DENIED } });
    const result = await call({ action: 'get_current' });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      message: `Automation permission denied for Music: ${MUSIC_DENIED}`,
      data: {
        reason: 'accessibility_required',
        recovery: { hint: declaredRecovery('accessibility_required') },
      },
    });
    expect(result.structuredContent).not.toHaveProperty('track');
  });

  it.each([
    ['set_shuffle', { shuffle: true }, { shuffle: false }, { shuffle: false }, '**Shuffle:** off'],
    ['set_repeat', { repeat: 'all' }, { repeat: 'one' }, { repeat: 'one' }, '**Repeat:** one'],
  ])(
    '%s reports the value read back after the write, not the one requested',
    async (action, args, readBack, expected, line) => {
      answer({ main: running({ state: 'playing', ...readBack }) });
      const result = await call({ action, ...args });
      expect(result.structuredContent).toMatchObject(expected);
      expect(contentText(result).split('\n')).toContain(line);
    },
  );

  it.each([
    [{ action: 'set_shuffle', shuffle: false }, 'music.shuffleEnabled = false;'],
    [{ action: 'set_repeat', repeat: 'one' }, 'music.songRepeat = "one";'],
    [{ action: 'next' }, 'music.nextTrack();'],
  ])('%j sends its command in the guarded script', async (args, command) => {
    answer({ main: running({ state: 'playing' }) });
    await call(args);
    expect(scripts()).toEqual([musicScript(args as MusicInput)]);
    expect(scripts()[0]?.split('\n')).toContain(`  ${command}`);
  });

  it.each([
    [{ action: 'play' }, 15_000],
    [{ action: 'pause' }, 10_000],
    [{ action: 'get_current' }, 10_000],
  ])(
    '%j runs one JXA process bounded at %i ms, with the caller’s signal',
    async (args, timeout) => {
      answer({ main: running({ state: 'playing' }) });
      const controller = new AbortController();
      await call(args, controller.signal);
      expect(execFileMock.mock.calls.map((c) => c.slice(0, 3))).toEqual([
        [
          SYSTEM_BINARIES.osascript,
          ['-l', 'JavaScript', '-e', musicScript(args as MusicInput)],
          { timeout, signal: controller.signal },
        ],
      ]);
    },
  );

  describe('play_playlist', () => {
    it('plays the named playlist after the lookup and reports the name Music gives it', async () => {
      answer({ lookup: '"Chill Mix"', main: running({ state: 'playing' }) });
      const result = await call({ action: 'play_playlist', playlist: 'chill mix' });
      expect(result.structuredContent).toEqual({
        action: 'play_playlist',
        running: true,
        player_state: 'playing',
        track: PLAYING_TRACK,
        shuffle: false,
        repeat: 'off',
        playlist: 'Chill Mix',
      });
      expect(contentText(result).split('\n')).toContain('**Playlist:** `Chill Mix`');
      expect(scripts()).toEqual([
        playlistLookupScript('chill mix'),
        musicScript({ action: 'play_playlist', playlist: 'chill mix' }),
      ]);
      for (const invocation of execFileMock.mock.calls) {
        expect((invocation[2] as { timeout: number }).timeout).toBe(15_000);
      }
    });

    it('an unknown name fails playlist_not_found before any play script runs', async () => {
      answer({ lookup: 'null', main: running({ state: 'playing' }) });
      const result = await call({ action: 'play_playlist', playlist: 'Nope "x"' });
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: 'Music has no playlist named "Nope \\"x\\"".',
        data: {
          reason: 'playlist_not_found',
          recovery: { hint: declaredRecovery('playlist_not_found') },
        },
      });
      expect(contentText(result).split('\n')).toContain(
        `Recovery: ${declaredRecovery('playlist_not_found')}`,
      );
      expect(scripts()).toEqual([playlistLookupScript('Nope "x"')]);
      expect(scripts().join('\n')).not.toContain('.play(');
    });

    it('a lookup that prints something else is an internal error, and nothing plays', async () => {
      answer({ lookup: '{"name":"Focus"}', main: running({ state: 'playing' }) });
      const result = await call({ action: 'play_playlist', playlist: 'Focus' });
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.InternalError,
        message: 'The Music playlist lookup printed output in an unexpected shape.',
      });
      expect(scripts()).toHaveLength(1);
    });

    it('a request cancelled during the lookup settles as cancelled and never plays', async () => {
      const controller = new AbortController();
      answer({
        lookup: '"Focus"',
        main: running({ state: 'playing' }),
        cancel: { controller, on: 'lookup' },
      });
      const result = await call({ action: 'play_playlist', playlist: 'Focus' }, controller.signal);
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(errorOf(result)?.message).toBe('The operation was aborted');
      expect(contentText(result).split('\n')[0]).toBe('Error: The operation was aborted');
      expect(result.structuredContent).not.toHaveProperty('playlist');
      expect(scripts()).toEqual([playlistLookupScript('Focus')]);
    });
  });

  describe('format renders text Music carries so a CommonMark parse reads it back exactly', () => {
    const FUZZ = [
      'line one\nline two',
      'cr\r\nlf',
      'a`b``c',
      'col | col',
      '*not emphasis* _nor this_',
      '[link](https://example.com)',
      '# not a heading',
      '- not a list',
      `lone ${String.fromCharCode(0xd83d)} surrogate`,
      '<b>html</b> &amp;',
    ];

    it.each(FUZZ)('%j', (value) => {
      const text = macosControlMusic.format!({
        action: 'play_playlist',
        running: true,
        player_state: 'playing',
        track: { name: value, artist: `by ${value}`, album: `on ${value}` },
        shuffle: true,
        repeat: 'one',
        playlist: `pl ${value}`,
      })
        .map((b) => ('text' in b ? b.text : ''))
        .join('\n');
      expect(commonMarkBlocks(text)).toEqual([
        [
          'action: play_playlist',
          'Running: yes',
          'Player state: playing',
          `Track: ${value}`,
          `Artist: by ${value}`,
          `Album: on ${value}`,
          'Shuffle: on',
          'Repeat: one',
          `Playlist: pl ${value}`,
        ].join('\n'),
      ]);
    });
  });
});
