/**
 * @fileoverview Tests for ScreencaptureService failure messages at the
 * `execFile` seam: a failed capture reports the CLI's own error text, never the
 * command line Node prepends to the rejection.
 * @module tests/services/screencapture-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { ScreencaptureService } from '@/services/screencapture/screencapture-service.js';

const OUT = '/tmp/zz-nonexistent-dir-qx/shot.png';

function failScreencaptureWith(stderr: string): void {
  execFileMock.mockImplementation((cmd, args, _opts, cb) => {
    cb(
      Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {
        code: 1 as unknown as string,
        stderr,
      }),
    );
    return { pid: 1 };
  });
}

describe('ScreencaptureService capture failures', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  for (const opts of [
    { target: 'screen' as const },
    { target: 'region' as const, region: { x: 0, y: 0, width: 10, height: 10 } },
    { target: 'display' as const, displayIndex: 0 },
  ]) {
    it(`${opts.target}: reports the screencapture error without the command line`, async () => {
      failScreencaptureWith('screencapture: cannot write file to intended destination');
      const err = (await new ScreencaptureService()
        .takeScreenshot({ ...opts, path: OUT, screenshotDir: '/tmp' }, createMockContext())
        .catch((e: unknown) => e)) as Error;
      expect(err.message).toContain('cannot write file to intended destination');
      expect(err.message).not.toContain('Command failed');
      expect(err.message).not.toContain('screencapture -x');
      expect(err.message).not.toContain(OUT);
    });
  }

  it('display: an invalid index still maps to display_not_found', async () => {
    failScreencaptureWith('Invalid display specified. Must be a number from 1-3');
    const err = await new ScreencaptureService()
      .takeScreenshot(
        { target: 'display', displayIndex: 9, path: OUT, screenshotDir: '/tmp' },
        createMockContext(),
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: -32001, data: { reason: 'display_not_found' } });
  });
});
