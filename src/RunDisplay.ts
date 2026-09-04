/**
 * Display/logging helpers shared by every entry point that runs an agent
 * and reports on it: `run.ts`, `createSandbox.ts`, and `createWorktree.ts`.
 * Split out of `run.ts` so those sibling entry points depend on this file
 * instead of reaching into the `run` command's own module for shared
 * formatting logic.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { styleText } from "node:util";
import type { Severity } from "./Display.js";
import type { IterationResult } from "./Orchestrator.js";
import type { IterationUsage } from "./AgentProvider.js";
import type { AgentStreamEvent } from "./AgentStreamEmitter.js";
import type { StructuredOutputError } from "./Output.js";
import type { LoggingOption } from "./RunConfig.js";

/**
 * Build the token-efficient feedback prompt sent to the agent when retrying
 * structured output. The agent has already done the work in the resumed
 * session — the only ask is to re-emit a corrected tag.
 *
 * @internal
 */
export const buildStructuredOutputRetryFeedback = (
  error: StructuredOutputError,
  retriesRemaining: number,
): string => {
  const raw =
    error.rawMatched === undefined
      ? "(no matching tag was emitted)"
      : error.rawMatched;
  const cause =
    error.cause === undefined
      ? "(no parser detail)"
      : typeof error.cause === "string"
        ? error.cause
        : JSON.stringify(error.cause, null, 2);

  return `Your previous response did not produce valid structured output.

Retries remaining after this attempt: ${retriesRemaining}.

Problem:
${error.message}

Parser detail:
${cause}

Previous matched output:
${raw}

Emit only a corrected <${error.tag}> block. Do not change files or run commands.`;
};

/** Default maximum number of iterations for a run. */
export const DEFAULT_MAX_ITERATIONS = 1;

/** Replace characters that are invalid or problematic in file paths with dashes. */
export const sanitizeBranchForFilename = (branch: string): string =>
  branch.replace(/[/\\:*?"<>|]/g, "-");

export interface FileDisplayStartupOptions {
  readonly logPath: string;
  readonly agentName?: string;
  readonly branch?: string;
  /** Resolved host repo directory. When it differs from `process.cwd()`, the
   *  log-file hint is printed as an absolute path so it can be pasted into any
   *  terminal. When it equals `process.cwd()` (or is omitted), a relative path
   *  is printed instead. */
  readonly hostRepoDir?: string;
}

/**
 * Print the startup message to the terminal when using file-based logging.
 * Uses styleText for lightweight bold/dim styling — does not use Clack.
 */
export const printFileDisplayStartup = (
  options: FileDisplayStartupOptions,
): void => {
  const name = options.agentName ?? "Agent";
  const label = styleText("bold", `[${name}]`);
  const branchPart = options.branch ? ` on branch ${options.branch}` : "";
  const hostRepoDir = options.hostRepoDir ?? process.cwd();
  const displayLogPath =
    hostRepoDir === process.cwd()
      ? path.relative(process.cwd(), options.logPath)
      : options.logPath;
  console.log(`${label} Started${branchPart}`);
  console.log(styleText("dim", `  tail -f ${displayLogPath}`));
};

/**
 * Build the log filename for a run.
 * When a targetBranch is provided (temp branch mode), prefixes the filename
 * with the sanitized target branch name so developers can identify which
 * branch the run was targeting: `<targetBranch>-<resolvedBranch>.log`
 * When no targetBranch, uses just the resolved branch: `<resolvedBranch>.log`
 * When a name is provided, appends it to avoid collisions in multi-agent workflows.
 */
export const buildLogFilename = (
  resolvedBranch: string,
  targetBranch?: string,
  name?: string,
): string => {
  const sanitized = sanitizeBranchForFilename(resolvedBranch);
  const nameSuffix = name
    ? `-${name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`
    : "";
  if (targetBranch) {
    return `${sanitizeBranchForFilename(targetBranch)}-${sanitized}${nameSuffix}.log`;
  }
  return `${sanitized}${nameSuffix}.log`;
};

export interface RunSummaryRowsOptions {
  readonly name?: string;
  readonly agentName: string;
  readonly sandboxName: string;
  readonly maxIterations: number;
  readonly branch: string;
}

/**
 * Build the summary rows for a run, used in both terminal mode and
 * log-to-file mode. When a custom name is provided it appears as the
 * Agent value instead of the internal provider name.
 */
export const buildRunSummaryRows = (
  options: RunSummaryRowsOptions,
): Record<string, string> => ({
  Agent: options.name ?? options.agentName,
  Sandbox: options.sandboxName,
  "Max iterations": String(options.maxIterations),
  Branch: options.branch,
});

/**
 * Build the completion status message for a run, used in both terminal mode
 * and log-to-file mode to record the final outcome.
 */
export const buildCompletionMessage = (
  completionSignal: string | undefined,
  iterationsRun: number,
): { readonly message: string; readonly severity: Severity } => {
  if (completionSignal !== undefined) {
    return {
      message: `Run complete: agent finished after ${iterationsRun} iteration(s).`,
      severity: "success",
    };
  }
  return {
    message: `Run complete: reached ${iterationsRun} iteration(s) without completion signal.`,
    severity: "warn",
  };
};

/**
 * Format the context window size from an iteration's usage data.
 * Returns a string like "103k" representing the total input-side tokens
 * (inputTokens + cacheCreationInputTokens + cacheReadInputTokens)
 * rounded up to the nearest 1000.
 */
export const formatContextWindowSize = (usage: IterationUsage): string => {
  const total =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  return `${Math.ceil(total / 1000)}k`;
};

/**
 * Build "Context window: NNNk" lines for iterations that have usage data.
 * Returns an empty array when no iterations carry usage.
 */
export const buildContextWindowLines = (
  iterations: readonly Pick<IterationResult, "usage">[],
): string[] =>
  iterations
    .filter((it): it is { usage: IterationUsage } => it.usage !== undefined)
    .map((it) => `Context window: ${formatContextWindowSize(it.usage)}`);

/**
 * Build the agent-stream event handler for a resolved logging option.
 *
 * Composes the user-provided `onAgentStreamEvent` callback (file mode only)
 * with the verbose raw-line sink: the log file at `path` for file mode, or
 * `process.stdout` for stdout mode. Returns `undefined` when neither
 * verbose mode nor a user callback is set.
 *
 * Raw lines are written synchronously to honor the `onLine` real-time
 * contract — the debugger needs each line as soon as the agent emits it.
 *
 * @internal
 */
export const buildAgentStreamHandler = (
  logging: LoggingOption,
): ((event: AgentStreamEvent) => void) | undefined => {
  const userHandler =
    logging.type === "file" ? logging.onAgentStreamEvent : undefined;
  const verboseSink = logging.verbose
    ? buildVerboseRawLineSink(logging)
    : undefined;
  if (!userHandler && !verboseSink) return undefined;
  return (event) => {
    if (userHandler) {
      try {
        userHandler(event);
      } catch {
        // Swallow — a broken forwarder must not stop the verbose sink.
      }
    }
    if (verboseSink && event.type === "raw") {
      verboseSink(event.line);
    }
  };
};

const buildVerboseRawLineSink = (
  logging: LoggingOption,
): ((line: string) => void) => {
  if (logging.type === "file") {
    const logPath = logging.path;
    // Ensure the directory exists; the FileDisplay layer creates it for the
    // primary log file but it hasn't necessarily run by the time the first
    // raw line is flushed.
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
    } catch {
      // Swallow — appendFileSync below will surface any real I/O error.
    }
    return (line) => {
      try {
        appendFileSync(logPath, line + "\n");
      } catch {
        // Swallow — verbose-mode I/O errors must not kill the run.
      }
    };
  }
  return (line) => {
    process.stdout.write(line + "\n");
  };
};
