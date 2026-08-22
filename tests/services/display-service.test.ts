/**
 * @fileoverview Unit tests for DisplayService.listDisplays — displayplacer output parsing.
 * @module tests/services/display-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplayService } from '@/services/display/display-service.js';

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

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

/**
 * Trimmed but structurally faithful `displayplacer list` output from a
 * three-display Mac. Two traits matter and are reproduced verbatim:
 * displayplacer annotates some field values with a ` - <note>` suffix, and it
 * prints an example rotation command — carrying its own quoted
 * `displayplacer "..."` string — ABOVE the real arrangement command, which is
 * emitted last, under "Execute the command below".
 */
const REAL_ARRANGEMENT =
  'displayplacer "id:9D0FFC6F-7EC1-4D0B-95F7-D30AB07A4EB2 res:3840x2160 hz:144 color_depth:8 enabled:true scaling:off origin:(0,0) degree:0" "id:37D8832A-2D66-02CA-B9F7-8F30A301B230 res:1512x982 hz:120 color_depth:8 enabled:true scaling:on origin:(3840,928) degree:0"';

const LIST_OUTPUT = [
  'Persistent screen id: 9D0FFC6F-7EC1-4D0B-95F7-D30AB07A4EB2',
  'Type: 32 inch external screen',
  'Resolution: 3840x2160',
  'Hertz: 144',
  'Color Depth: 8',
  'Scaling: off',
  'Origin: (0,0) - main display',
  'Rotation: 0',
  'Enabled: true',
  '',
  'Persistent screen id: 37D8832A-2D66-02CA-B9F7-8F30A301B230',
  'Type: MacBook built in screen',
  'Resolution: 1512x982',
  'Hertz: 120',
  'Color Depth: 8',
  'Scaling: on',
  'Origin: (3840,928)',
  'Rotation: 0 - rotate internal screen example (may crash computer, but will be rotated after rebooting): `displayplacer "id:37D8832A-2D66-02CA-B9F7-8F30A301B230 degree:90"`',
  'Enabled: true',
  '',
  'Execute the command below to set your screens to the current arrangement.',
  '',
  REAL_ARRANGEMENT,
].join('\n');

describe('DisplayService.listDisplays', () => {
  let svc: DisplayService;

  beforeEach(() => {
    svc = new DisplayService();
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: LIST_OUTPUT, stderr: '' });
      return { pid: 1 };
    });
  });

  it('captures the real arrangement command, not the rotation example', async () => {
    const ctx = createMockContext();
    const { current_config } = await svc.listDisplays(ctx);
    expect(current_config).toBe(REAL_ARRANGEMENT);
    expect(current_config).not.toContain('degree:90');
    expect(current_config).not.toContain('may crash computer');
  });

  it('strips displayplacer annotations from rotation and origin', async () => {
    const ctx = createMockContext();
    const { displays } = await svc.listDisplays(ctx);
    expect(displays).toHaveLength(2);
    expect(displays[0]?.origin).toBe('(0,0)');
    expect(displays[1]?.rotation).toBe('0');
  });

  it('preserves the unannotated field values verbatim', async () => {
    const ctx = createMockContext();
    const { displays } = await svc.listDisplays(ctx);
    expect(displays[0]).toMatchObject({
      id: '9D0FFC6F-7EC1-4D0B-95F7-D30AB07A4EB2',
      type: '32 inch external screen',
      resolution: '3840x2160',
      hz: '144',
      rotation: '0',
      scaling: 'off',
      enabled: true,
    });
    expect(displays[1]?.origin).toBe('(3840,928)');
  });
});
