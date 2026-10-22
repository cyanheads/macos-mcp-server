/**
 * @fileoverview JXA that reads System Events' process list and addresses each
 * process uniquely, reading again when an app starting or quitting mid-read
 * changes the list.
 * @module services/osascript/foreground-processes
 */

/** Attempts the read gets before its error stands. */
const ATTEMPTS = 3;

/**
 * JXA defining three functions over System Events `se`.
 *
 * `processTable(se)` reads every process's unix id, name, and backgroundOnly
 * flag, one bulk read of each across `se.processes`, aligned by position. The
 * unix ids are read again after the other two; when they differ, or a read
 * fails with -1719 ("Invalid index") or -10000 ("AppleEvent handler failed") as
 * one does when the process list changes mid-read, the table is read again
 * 100 ms later, up to 3 attempts in all. Any other error, and the last
 * attempt's, is thrown.
 *
 * `processByPid(se, table, pid)` is the process with unix id `pid`, or
 * undefined when the table lists none. Every process System Events returns from
 * a query is a by-name specifier, which resolves to the first process of that
 * name, so a process whose name another process shares is addressed by its unix
 * id instead. A name no other process carries stays a by-name specifier, which
 * System Events resolves in about a third of the time.
 *
 * `foregroundProcesses(se)` is `{pid, name, proc}` for every process that is
 * not background-only, in System Events' order, `proc` from `processByPid`.
 *
 * The waits run inside the osascript process, bounded by its timeout and ended
 * by the caller's cancellation with it.
 */
export const FOREGROUND_PROCESSES_JXA = `const processTable = (se) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const pids = se.processes.unixId();
      const table = {pids, names: se.processes.name(), background: se.processes.backgroundOnly()};
      const again = se.processes.unixId();
      if (again.length === pids.length && again.every((pid, i) => pid === pids[i])) return table;
    } catch (e) {
      if (attempt === ${ATTEMPTS} || (e.errorNumber !== -1719 && e.errorNumber !== -10000)) throw e;
    }
    if (attempt === ${ATTEMPTS}) throw new Error("System Events' process list changed during each of ${ATTEMPTS} reads.");
    delay(0.1);
  }
};
const processByPid = (se, table, pid) => {
  const i = table.pids.indexOf(pid);
  if (i === -1) return undefined;
  const name = table.names[i];
  return table.names.indexOf(name) === table.names.lastIndexOf(name)
    ? se.processes.byName(name)
    : se.processes.whose({unixId: pid})[0];
};
const foregroundProcesses = (se) => {
  const table = processTable(se);
  return table.pids
    .filter((pid, i) => !table.background[i])
    .map((pid) => ({pid, name: table.names[table.pids.indexOf(pid)], proc: processByPid(se, table, pid)}));
};`;
