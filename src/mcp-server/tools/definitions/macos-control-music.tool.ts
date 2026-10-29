/**
 * @fileoverview Music playback tool — play, pause, stop, skip, play a playlist, set shuffle or repeat, and read what the Music app is playing.
 * @module mcp-server/tools/definitions/macos-control-music
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { suppliedArg, withActionRequirements } from '@/mcp-server/tools/action-requirements.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';
import { parseJsonOutput } from '@/utils/parse-json-output.js';
import { quotedText } from '@/utils/quoted-text.js';

/** Music's `player state` enumeration (`ePlS`), as JXA returns it, mapped to this tool's value. */
const PLAYER_STATES = {
  stopped: 'stopped',
  playing: 'playing',
  paused: 'paused',
  'fast forwarding': 'fast_forwarding',
  rewinding: 'rewinding',
} as const;

const REPEAT_MODES = ['off', 'one', 'all'] as const;

/** The actions that may launch Music: the ones that start playback. */
const LAUNCHING = new Set<MusicInput['action']>(['play', 'play_playlist']);

/** The actions that fail `not_running` rather than report a closed Music. */
const NEED_RUNNING = new Set<MusicInput['action']>([
  'next',
  'previous',
  'set_shuffle',
  'set_repeat',
]);

/**
 * A cold Music launch, or the first-use Automation consent dialog osascript
 * waits on, can outlast the service's 10 s default.
 */
const LAUNCH_TIMEOUT_MS = 15_000;

/**
 * Reads player state, shuffle, and repeat, then the current track. Only
 * errAENoSuchObject (-1728) on the track read degrades to `track: null`: Music
 * raises it when nothing is loaded, and macOS 26 raises it for a track outside
 * the library (radio, catalog playback) while transport still works. Anything
 * else, an Automation denial (-1743) included, is rethrown for the service to
 * classify.
 */
const READ_STATE_JXA = `function readState(music) {
  const state = music.playerState();
  const shuffle = music.shuffleEnabled();
  const repeat = music.songRepeat();
  let track = null;
  try {
    const t = music.currentTrack;
    track = { name: t.name(), artist: t.artist(), album: t.album() };
  } catch (e) {
    if (e.errorNumber !== -1728) throw e;
  }
  return { running: true, state, shuffle, repeat, track };
}`;

/** What every Music script prints: Music not running, or the state read back after the command. */
const MusicStateSchema = z.union([
  z.object({ running: z.literal(false) }),
  z.object({
    running: z.literal(true),
    state: z.enum(Object.keys(PLAYER_STATES) as [keyof typeof PLAYER_STATES]),
    shuffle: z.boolean(),
    repeat: z.enum(REPEAT_MODES),
    track: z
      .object({ name: z.string(), artist: z.string().nullable(), album: z.string().nullable() })
      .nullable(),
  }),
]);

/** What the playlist lookup prints: the name Music reports for the first match, or null. */
const PlaylistLookupSchema = z.string().nullable();

const MusicInputSchema = withActionRequirements(
  z.object({
    action: z
      .enum([
        'play',
        'pause',
        'stop',
        'next',
        'previous',
        'play_playlist',
        'set_shuffle',
        'set_repeat',
        'get_current',
      ])
      .describe(
        'play resumes or starts playback; play_playlist plays the named playlist; pause and stop halt it; next and previous skip tracks; set_shuffle and set_repeat change the play order; get_current only reads.',
      ),
    playlist: z
      .string()
      .optional()
      .describe(
        'Exact name of the playlist to play, as Music shows it in its sidebar; the first playlist with that name plays. Required for action=play_playlist.',
      ),
    shuffle: z
      .boolean()
      .optional()
      .describe('true plays tracks in random order. Required for action=set_shuffle.'),
    repeat: z
      .enum(REPEAT_MODES)
      .optional()
      .describe(
        'off plays through once, one repeats the current track, all repeats the playlist. Required for action=set_repeat.',
      ),
  }),
  'action',
  { play_playlist: [['playlist']], set_shuffle: [['shuffle']], set_repeat: [['repeat']] },
);

type MusicInput = z.infer<typeof MusicInputSchema>;

/**
 * The JXA statement that carries out the action; get_current has none. Caller
 * text (the playlist name) enters only as a JSON string literal, and `shuffle`
 * and `repeat` are a boolean and an enum member by the time they get here.
 */
function commandFor(input: MusicInput): string {
  switch (input.action) {
    case 'play':
      return 'music.play();';
    case 'play_playlist':
      return `music.play(music.playlists.byName(${JSON.stringify(suppliedArg(input.playlist, 'playlist'))}));`;
    case 'pause':
      return 'music.pause();';
    case 'stop':
      return 'music.stop();';
    case 'next':
      return 'music.nextTrack();';
    case 'previous':
      return 'music.previousTrack();';
    case 'set_shuffle':
      return `music.shuffleEnabled = ${suppliedArg(input.shuffle, 'shuffle')};`;
    case 'set_repeat':
      return `music.songRepeat = ${JSON.stringify(suppliedArg(input.repeat, 'repeat'))};`;
    case 'get_current':
      return '';
  }
}

/**
 * The one script an action runs: the command, then the state read back. For
 * every action but play and play_playlist it first checks
 * `Application('Music').running()`, which asks Launch Services and sends Music
 * no Apple event, and prints `{ running: false }` without touching Music when
 * it is closed.
 */
export function musicScript(input: MusicInput): string {
  const command = commandFor(input);
  return [
    READ_STATE_JXA,
    '(() => {',
    "  const music = Application('Music');",
    ...(LAUNCHING.has(input.action)
      ? []
      : ['  if (!music.running()) return JSON.stringify({ running: false });']),
    ...(command ? [`  ${command}`] : []),
    '  return JSON.stringify(readState(music));',
    '})();',
  ].join('\n');
}

/** The play_playlist lookup, run before play: the first playlist with this name, or null. */
export function playlistLookupScript(name: string): string {
  return [
    '(() => {',
    `  const playlist = Application('Music').playlists.byName(${JSON.stringify(name)});`,
    '  return JSON.stringify(playlist.exists() ? playlist.name() : null);',
    '})();',
  ].join('\n');
}

export const macosControlMusic = tool('macos_control_music', {
  title: 'Control macOS Music',
  description:
    "Control playback in the Music app and read what it is playing: play, pause, stop, skip to the next or previous track, play a playlist by its exact name, set shuffle or repeat, or get the current state. Every action returns the state Music reports afterward — player state, current track, shuffle, and repeat. play and play_playlist launch Music when it is closed; get_current, pause, and stop leave it closed and report running=false; next, previous, set_shuffle, and set_repeat fail with not_running. track is null when Music has nothing loaded, and also, with track_unavailable saying why, when Music refuses to name a track outside the library (radio or catalog playback on recent macOS). The first call shows macOS's Automation consent dialog for Music; if the call times out while it is open, answer the dialog and retry. macos_check_permissions reports the grant as automation_music. System output level belongs to macos_control_volume.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  input: MusicInputSchema,
  output: z.object({
    action: z.string().describe('The action that was performed.'),
    running: z
      .boolean()
      .describe(
        'True when Music is running. False only for get_current, pause, and stop on a closed Music, which leave it closed.',
      ),
    player_state: z
      .enum(['playing', 'paused', 'stopped', 'fast_forwarding', 'rewinding'])
      .nullable()
      .describe(
        'The player state Music reports after the action. Null exactly when running is false.',
      ),
    track: z
      .object({
        name: z.string().describe('Track name.'),
        artist: z.string().nullable().describe('Artist, or null when the track has none.'),
        album: z.string().nullable().describe('Album, or null when the track has none.'),
      })
      .nullable()
      .describe(
        'The current track. Null when Music is closed, has nothing loaded, or would not return the track (see track_unavailable).',
      ),
    track_unavailable: z
      .string()
      .optional()
      .describe(
        'Present when the player is not stopped but Music would not return the current track, saying why.',
      ),
    shuffle: z
      .boolean()
      .nullable()
      .describe(
        'True when shuffle is on, as read back from Music. Null exactly when running is false.',
      ),
    repeat: z
      .enum(REPEAT_MODES)
      .nullable()
      .describe('The repeat mode read back from Music. Null exactly when running is false.'),
    playlist: z
      .string()
      .optional()
      .describe('The playlist name as Music reports it. Present for action=play_playlist.'),
  }),
  errors: [
    {
      reason: 'not_running',
      code: JsonRpcErrorCode.NotFound,
      when: 'next, previous, set_shuffle, or set_repeat is called while Music is not running.',
      recovery:
        'Music is not running. Start playback with action=play or action=play_playlist, which launch it, then retry.',
    },
    {
      reason: 'playlist_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'play_playlist names a playlist Music does not have.',
      recovery:
        'Check the playlist name against the Music sidebar and retry with its exact name; nothing was played.',
    },
    {
      reason: 'accessibility_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The host app is denied Automation > Music permission.',
      recovery:
        'Grant Automation > Music permission in System Settings > Privacy & Security > Automation for your terminal or MCP host app.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const osascript = getOsascriptService();
    const runOptions = LAUNCHING.has(input.action) ? { timeoutMs: LAUNCH_TIMEOUT_MS } : {};

    let playlist: string | undefined;
    if (input.action === 'play_playlist') {
      const name = suppliedArg(input.playlist, 'playlist');
      const { stdout } = await osascript.runJxa(playlistLookupScript(name), ctx, runOptions);
      const found = parseJsonOutput(PlaylistLookupSchema, stdout);
      if (found === undefined) {
        throw internalError('The Music playlist lookup printed output in an unexpected shape.');
      }
      if (found === null) {
        throw ctx.fail('playlist_not_found', `Music has no playlist named ${quotedText(name)}.`);
      }
      playlist = found;
    }

    const { stdout } = await osascript.runJxa(musicScript(input), ctx, runOptions);
    const read = parseJsonOutput(MusicStateSchema, stdout);
    if (read === undefined) {
      throw internalError('The Music script printed output in an unexpected shape.');
    }

    if (!read.running) {
      if (NEED_RUNNING.has(input.action)) {
        throw ctx.fail(
          'not_running',
          `Music is not running, so ${input.action} has nothing to act on.`,
        );
      }
      ctx.log.info('macos_control_music', { action: input.action, running: false });
      return {
        action: input.action,
        running: false,
        player_state: null,
        track: null,
        shuffle: null,
        repeat: null,
      };
    }

    const player_state = PLAYER_STATES[read.state];
    const track = read.track && {
      name: read.track.name,
      artist: read.track.artist || null,
      album: read.track.album || null,
    };
    ctx.log.info('macos_control_music', { action: input.action, player_state });
    return {
      action: input.action,
      running: true,
      player_state,
      track,
      ...(track === null &&
        player_state !== 'stopped' && {
          track_unavailable: `Music is ${read.state} but would not return the current track (error -1728); recent macOS releases refuse this read for tracks outside the library, such as Apple Music radio or catalog playback.`,
        }),
      shuffle: read.shuffle,
      repeat: read.repeat,
      ...(playlist !== undefined && { playlist }),
    };
  },

  format: (result) => {
    const lines = [
      `**action:** ${result.action}`,
      result.running ? '**Running:** yes' : '**Running:** no — Music is closed and was left closed',
    ];
    lines.push(`**Player state:** ${result.player_state ?? '(not running)'}`);
    // Track, artist, album, and playlist names are text Music carries, so they render as literals.
    const optional = (value: string | null) => (value === null ? '(none)' : markdownLiteral(value));
    if (result.track === null) {
      lines.push('**Track:** (none)');
    } else {
      lines.push(`**Track:** ${markdownLiteral(result.track.name)}`);
      lines.push(`**Artist:** ${optional(result.track.artist)}`);
      lines.push(`**Album:** ${optional(result.track.album)}`);
    }
    if (result.track_unavailable !== undefined) {
      lines.push(`**Track unavailable:** ${result.track_unavailable}`);
    }
    lines.push(
      `**Shuffle:** ${result.shuffle === null ? '(not running)' : result.shuffle ? 'on' : 'off'}`,
    );
    lines.push(`**Repeat:** ${result.repeat ?? '(not running)'}`);
    if (result.playlist !== undefined)
      lines.push(`**Playlist:** ${markdownLiteral(result.playlist)}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
