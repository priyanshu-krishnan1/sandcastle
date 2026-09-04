/**
 * Config types shared across every entry point (`run`, `createSandbox`,
 * `createWorktree`, `interactive`, and the orchestration/sandbox-lifecycle
 * layers underneath them). Kept separate from `run.ts` so those modules
 * don't have to depend on the `run` command's own file just to type a
 * `timeouts`/`logging` option — see ADR-0022's "what we chose not to build"
 * discussion of avoiding speculative coupling for the reasoning behind
 * keeping shared seams in their own file once a second consumer shows up.
 */

import type { AgentStreamEvent } from "./AgentStreamEmitter.js";

/** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
export interface Timeouts {
  /** Timeout (ms) for the host-side copy of `copyToWorktree` paths into the worktree. Default: 60_000. */
  readonly copyToWorktreeMs?: number;
  /** Timeout (ms) for each in-sandbox git setup command (safe.directory, user.name/email, branch discovery). Default: 10_000. */
  readonly gitSetupMs?: number;
  /** Timeout (ms) for collecting the commits produced during the run. Default: 30_000. */
  readonly commitCollectionMs?: number;
  /** Timeout (ms) for merging the temp branch back to the host branch (merge-to-head strategy). Default: 30_000. */
  readonly mergeToHostMs?: number;
}

/**
 * Controls where Sandcastle writes iteration progress and agent output.
 * Use `"file"` (log-to-file mode) to write to a log file on disk, or
 * `"stdout"` (terminal mode) to render an interactive UI in the terminal.
 */
export type LoggingOption =
  /** Write progress and agent output to a log file at the given path (log-to-file mode). */
  | {
      readonly type: "file";
      readonly path: string;
      /**
       * Optional callback invoked for each agent stream event (text chunk,
       * tool call, or raw stdout line) in addition to being written to the
       * log file. Intended for forwarding the agent's output stream to
       * external observability systems. Errors thrown by the callback are
       * swallowed.
       */
      readonly onAgentStreamEvent?: (event: AgentStreamEvent) => void;
      /**
       * When `true`, every raw stdout line the agent emits is appended
       * verbatim to the same log file at `path`, in real time. Includes
       * lines the provider's stream parser would otherwise drop (e.g.
       * tool-use blocks for unrecognised tools). Intended for debugging
       * stuck or unexpected agent behavior — note that the raw JSON is
       * interleaved with the human-readable log output. Default: `false`.
       */
      readonly verbose?: boolean;
    }
  /** Render progress and agent output as an interactive UI in the terminal (terminal mode). */
  | {
      readonly type: "stdout";
      /**
       * When `true`, every raw stdout line the agent emits is written
       * verbatim to `process.stdout`, in real time. Includes lines the
       * provider's stream parser would otherwise drop. Intended for
       * debugging stuck or unexpected agent behavior. Note: the raw output
       * is interleaved with the interactive terminal UI. Default: `false`.
       */
      readonly verbose?: boolean;
    };
