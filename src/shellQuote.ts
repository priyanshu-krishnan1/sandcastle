/**
 * Single-quote a string for safe inclusion in a POSIX shell command line.
 *
 * Shared by any code that builds a shell command string to hand to
 * `SandboxHandle.exec` (agent providers building `buildPrintCommand`,
 * remote sandbox providers building SSH command lines). Previously
 * reimplemented independently in `AgentProvider.ts` (`shellEscape`) and
 * `sandboxes/fyre.ts` (`shellQuote`) with identical logic.
 */
export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;
