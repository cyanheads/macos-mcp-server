/**
 * @fileoverview Keeps the server's NSScreen reads and its System Events process
 * enumerations from overlapping. An osascript process that reads
 * `NSScreen.screens` and starts or exits while System Events evaluates its
 * process list makes that enumeration fail ("Invalid index", -1719;
 * "AppleEvent handler failed", -10000) or return a wrong list: a running app
 * left out and a background process in its place. Runs of one kind share the
 * exclusion; a run of the other kind waits until none is in flight.
 * @module services/osascript/osascript-exclusion
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/**
 * The side a script takes. `nsscreen-read` is every osascript that reads
 * NSScreen; `process-enumeration` is every script that enumerates System
 * Events processes (`processes.whose(...)`, a bulk read such as
 * `processes.unixId()`, `every process whose ...`). Other
 * osascript runs take no side: NSWorkspace, CoreGraphics, ApplicationServices,
 * and CoreServices reads, and System Events scripts that enumerate no
 * processes, were measured not to disturb a concurrent enumeration.
 */
export type OsascriptExclusion = 'nsscreen-read' | 'process-enumeration';

/** What a waiting run of each side waits for, for its timeout message. */
const WAITS_FOR: Record<OsascriptExclusion, string> = {
  'nsscreen-read': 'a System Events process enumeration',
  'process-enumeration': 'an NSScreen read',
};

interface Waiter {
  grant: () => void;
  side: OsascriptExclusion;
}

/** The side holding the exclusion and how many of its runs are in flight; side is unset while none is. */
const holder: { count: number; side: OsascriptExclusion | undefined } = {
  count: 0,
  side: undefined,
};

/** Runs waiting for the exclusion, oldest first. */
const queue: Waiter[] = [];

/** A run that waited its whole timeout without getting its side. */
function waitTimeout(side: OsascriptExclusion, timeoutMs: number): McpError {
  return new McpError(
    JsonRpcErrorCode.Timeout,
    `osascript timed out after ${timeoutMs}ms waiting for ${WAITS_FOR[side]} to finish`,
    { timeoutMs },
  );
}

function admitWaiter(waiter: Waiter): void {
  holder.side = waiter.side;
  holder.count++;
  waiter.grant();
}

/**
 * Admits waiters. Once nothing holds the exclusion, the oldest waiter's side
 * takes it and every waiter of that side is admitted together, since runs of
 * one side do not disturb each other. The sides therefore take turns: a waiter
 * starts after at most the group in flight and one group of the other side.
 * While a side holds the exclusion, waiters of that side at the head of the
 * queue join it, up to the first waiter of the other side.
 */
function admit(): void {
  if (holder.count === 0) {
    const side = queue[0]?.side;
    if (side === undefined) return;
    const group = queue.filter((w) => w.side === side);
    queue.splice(0, queue.length, ...queue.filter((w) => w.side !== side));
    for (const waiter of group) admitWaiter(waiter);
    return;
  }
  while (queue[0]?.side === holder.side) admitWaiter(queue.shift() as Waiter);
}

function release(): void {
  holder.count--;
  if (holder.count === 0) holder.side = undefined;
  admit();
}

/**
 * Takes `side` of the exclusion, resolving with how long it waited in
 * milliseconds (0 when it joined at once). Rejects with `signal`'s reason when
 * the caller cancels while it waits, and with a Timeout once it has waited
 * `timeoutMs`; either way it leaves the queue holding nothing.
 */
function acquire(
  side: OsascriptExclusion,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<number> {
  signal.throwIfAborted();
  if (queue.length === 0 && (holder.count === 0 || holder.side === side)) {
    holder.side = side;
    holder.count++;
    return Promise.resolve(0);
  }
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const stopWaiting = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const waiter: Waiter = {
      side,
      grant: () => {
        stopWaiting();
        resolve(performance.now() - startedAt);
      },
    };
    const leave = (reason: unknown) => {
      stopWaiting();
      queue.splice(queue.indexOf(waiter), 1);
      // The waiter that left may have been all that held the next ones back.
      admit();
      reject(reason);
    };
    const onAbort = () => leave(signal.reason);
    const timer = setTimeout(() => leave(waitTimeout(side, timeoutMs)), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    queue.push(waiter);
  });
}

/**
 * Runs `task` holding `side` of the exclusion and releases it when `task`
 * settles. The wait counts against the run's own `timeoutMs`: `task` receives
 * what is left of it to bound the osascript process with, so a run never
 * outlasts the timeout it was given. A caller that cancels while the run waits
 * gets its signal's reason, and `task` never starts.
 */
export async function runExclusive<T>(
  side: OsascriptExclusion,
  signal: AbortSignal,
  timeoutMs: number,
  task: (remainingMs: number) => Promise<T>,
): Promise<T> {
  const waitedMs = await acquire(side, signal, timeoutMs);
  try {
    const remainingMs = Math.floor(timeoutMs - waitedMs);
    if (remainingMs <= 0) throw waitTimeout(side, timeoutMs);
    return await task(remainingMs);
  } finally {
    release();
  }
}
