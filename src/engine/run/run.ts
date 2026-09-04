import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { resolveCwd } from "../../utils/resolveCwd.js";
import { assertResumeSessionExists } from "./resumePrecheck.js";
import type { AgentProvider } from "../../AgentProvider.js";
import { ClackDisplay, Display, FileDisplay } from "../display/Display.js";
import {
  orchestrate,
  type IterationResult,
  type OrchestrateResult,
} from "./Orchestrator.js";
import { resolvePrompt } from "../prompts/PromptResolver.js";
import {
  WorktreeDockerSandboxFactory,
  SandboxConfig,
} from "../sandbox/SandboxFactory.js";
import type { SandboxProvider, BranchStrategy } from "../../SandboxProvider.js";
import { resolveEnv } from "../sandbox/EnvResolver.js";
import { formatErrorMessage } from "../../errors/ErrorHandler.js";
import type { SandboxError } from "../../errors/errors.js";
import { agentStreamEmitterLayer } from "../display/AgentStreamEmitter.js";
import type { SandboxHooks } from "../sandbox/SandboxLifecycle.js";
import { mergeProviderEnv } from "../../utils/mergeProviderEnv.js";
import {
  generateTempBranchName,
  getCurrentBranch,
} from "../sandbox/WorktreeManager.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "../prompts/PromptArgumentSubstitution.js";
import type {
  OutputDefinition,
  OutputObjectDefinition,
  OutputStringDefinition,
} from "../prompts/Output.js";
import { StructuredOutputError } from "../prompts/Output.js";
import { extractStructuredOutput } from "../prompts/extractStructuredOutput.js";
import type { Timeouts, LoggingOption } from "./RunConfig.js";
import {
  buildStructuredOutputRetryFeedback,
  DEFAULT_MAX_ITERATIONS,
  printFileDisplayStartup,
  buildLogFilename,
  buildRunSummaryRows,
  buildCompletionMessage,
  buildContextWindowLines,
  buildAgentStreamHandler,
} from "./RunDisplay.js";

// `Timeouts`/`LoggingOption` (config types) and the display/logging helpers
// above live in `./RunConfig.js`/`./RunDisplay.js` so that `createSandbox.ts`,
// `createWorktree.ts`, `Orchestrator.ts`, `SandboxFactory.ts`,
// `SandboxLifecycle.ts`, and `interactive.ts` can depend on them without
// depending on the `run` command's own file. `index.ts` (the package's
// public entry point) imports `LoggingOption`/`Timeouts` directly from
// `./RunConfig.js` rather than through a re-export here — the helper
// functions were never part of the public API, only used internally by
// `run()` below, so nothing else needs to re-export any of this.

export interface RunOptions<A extends AgentProvider = AgentProvider> {
  /** Agent provider to use (e.g. bob("default")) */
  readonly agent: A;
  /** Sandbox provider (e.g. docker({ imageName: "sandcastle:myrepo" })). */
  readonly sandbox: SandboxProvider;
  /**
   * Host repo directory. Replaces `process.cwd()` as the anchor for
   * `.sandcastle/worktrees/`, `.sandcastle/.env`, `.sandcastle/logs/`,
   * `.sandcastle/patches/`, and git operations.
   *
   * - Relative paths are resolved against `process.cwd()`.
   * - Absolute paths are used as-is.
   * - Defaults to `process.cwd()` when omitted.
   */
  readonly cwd?: string;
  /** Inline prompt string (mutually exclusive with promptFile) */
  readonly prompt?: string;
  /**
   * Path to a prompt file (mutually exclusive with prompt).
   *
   * **Note:** `promptFile` is always resolved against `process.cwd()`, not
   * against the `cwd` option. If you set a custom `cwd`, pass an absolute
   * `promptFile` to avoid ambiguity.
   */
  readonly promptFile?: string;
  /** Maximum iterations to run (default: 1) */
  readonly maxIterations?: number;
  /** Lifecycle hooks grouped by execution location (host or sandbox). */
  readonly hooks?: SandboxHooks;
  /** Key-value map for {{KEY}} placeholder substitution in prompts */
  readonly promptArgs?: PromptArgs;
  /** Logging mode (default: { type: 'file' } with auto-generated path under .sandcastle/logs/) */
  readonly logging?: LoggingOption;
  /** Substring(s) the agent emits to stop the iteration loop early. Matched via `includes` against agent output. (default: `"<promise>COMPLETE</promise>"`) */
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. If the agent produces no output for this long, it fails. Default: 600 (10 minutes) */
  readonly idleTimeoutSeconds?: number;
  /**
   * Grace window in seconds after a completion signal is observed in the
   * agent's output. The agent process is expected to exit shortly after
   * emitting the signal; if it does not (typically because a spawned child —
   * a `gh`/git subprocess or long-lived MCP server — keeps stdout open),
   * Sandcastle force-completes the iteration with a warning. Resets on every
   * subsequent output line so trailing data (token-usage events, terminal
   * `result` events, structured-output tags) is still captured. Independent
   * of `idleTimeoutSeconds`. Default: 60.
   */
  readonly completionTimeoutSeconds?: number;
  /** Optional name for the run, shown as a prefix in log output */
  readonly name?: string;
  /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
  readonly copyToWorktree?: string[];
  /** Branch strategy — controls how the agent's changes relate to branches.
   * Defaults to { type: "head" } for bind-mount providers and { type: "merge-to-head" } for isolated providers. */
  readonly branchStrategy?: BranchStrategy;
  /** Resume a prior Claude Code session by ID. The session JSONL must exist on the host. Incompatible with maxIterations > 1. */
  readonly resumeSession?: string;
  /**
   * When true alongside `resumeSession`, fork the session instead of mutating
   * it. The parent session JSONL is left intact and the agent writes a new
   * session under a fresh id. Exposed as the public `.fork()` method on
   * `RunResult` rather than as a stand-alone caller option — see ADR 0018.
   *
   * @internal
   */
  readonly forkSession?: boolean;
  /**
   * An `AbortSignal` that cancels the run when aborted.
   *
   * - If `signal.aborted` is already `true` at entry, `run()` rejects
   *   immediately without doing any setup work.
   * - Aborting mid-iteration kills the in-flight agent subprocess.
   * - Phase boundaries (between iterations) also check the signal.
   * - The rejected promise surfaces `signal.reason` via
   *   `signal.throwIfAborted()` — no Sandcastle-specific wrapping.
   * - The worktree is preserved on disk after abort (error-path behavior).
   */
  readonly signal?: AbortSignal;
  /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
  readonly timeouts?: Timeouts;
  /**
   * Number of additional attempts per iteration when the agent fails with an
   * `AgentError` or `AgentIdleTimeoutError` (e.g. SSH disconnect, non-zero exit,
   * idle timeout). Each retry creates a completely fresh sandbox, so lifecycle
   * is unaffected. Default: `0` (no retries).
   */
  readonly iterationRetries?: number;
  /**
   * Structured output definition. When provided, the agent's stdout is
   * scanned for the configured XML tag after the iteration completes, and the
   * result is parsed/validated and returned on `RunResult.output`.
   *
   * Use `Output.object({ tag, schema })` for JSON+schema or
   * `Output.string({ tag })` for raw string extraction.
   *
   * Constraints:
   * - `maxIterations` must be `1` (the default).
   * - The resolved prompt must contain the configured opening tag literal.
   *
   * See ADR 0010 for design rationale.
   */
  readonly output?: OutputDefinition;
}

export type { IterationResult, IterationUsage } from "./Orchestrator.js";

export type ResumeRunResultOptions = Omit<
  RunOptions,
  | "agent"
  | "sandbox"
  | "prompt"
  | "promptFile"
  | "resumeSession"
  | "forkSession"
  | "maxIterations"
>;

export interface RunResult {
  /** Per-iteration results (use `iterations.length` for the count). */
  readonly iterations: IterationResult[];
  /** The matched completion signal string, or undefined if no signal fired before the iteration limit. */
  readonly completionSignal?: string;
  /** Combined stdout output from all agent iterations. */
  readonly stdout: string;
  /** List of commits made by the agent during the run, each identified by its SHA. */
  readonly commits: { sha: string }[];
  /** The branch name the agent worked on inside the sandbox. */
  readonly branch: string;
  /** Path to the log file, if logging was drained to a file. */
  readonly logFilePath?: string;
  /** Host path to the preserved worktree, set when the run succeeded but the worktree had uncommitted changes. */
  readonly preservedWorktreePath?: string;
  /** Continue the last captured agent session for exactly one iteration.
   *  Present only when the provider supports resume (`sessionStorage` populated). */
  readonly resume?: (
    prompt: string,
    options?: ResumeRunResultOptions,
  ) => Promise<RunResult>;
  /**
   * Fork the last captured agent session for exactly one iteration: the
   * parent session JSONL is left intact and the child run gets its own
   * session id, enabling fan-out patterns where multiple children diverge
   * from a single parent. Present only when the provider supports resume
   * (`sessionStorage` populated).
   *
   * Sessions only: fork isolates the agent session, not the branch or
   * sandbox. Safe concurrent fan-out (`Promise.all([r.fork(a), r.fork(b)])`)
   * requires the caller to give each fork a distinct `branch` — `head` and
   * `merge-to-head` are not safe for concurrent forks. See ADR 0018.
   */
  readonly fork?: (
    prompt: string,
    options?: ResumeRunResultOptions,
  ) => Promise<RunResult>;
}

/** Overload: with `Output.object`, returns `RunResult` with typed `output: T`. */
export function run<T, A extends AgentProvider>(
  options: RunOptions<A> & { output: OutputObjectDefinition<T> },
): Promise<RunResult & { output: T }>;
/** Overload: with `Output.string`, returns `RunResult` with `output: string`. */
export function run<A extends AgentProvider>(
  options: RunOptions<A> & { output: OutputStringDefinition },
): Promise<RunResult & { output: string }>;
/** Overload: without `output`, returns the standard `RunResult`. */
export function run<A extends AgentProvider>(
  options: RunOptions<A>,
): Promise<RunResult>;
export async function run(
  options: RunOptions,
): Promise<RunResult & { output?: unknown }> {
  // If signal is already aborted, reject immediately without any setup
  options.signal?.throwIfAborted();

  const {
    prompt,
    promptFile,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    hooks,
    agent: provider,
  } = options;

  // Derive branch strategy: explicit option > default based on provider tag
  const branchStrategy: BranchStrategy =
    options.branchStrategy ??
    (options.sandbox.tag === "isolated"
      ? { type: "merge-to-head" }
      : { type: "head" });
  const effectiveBranchType = branchStrategy.type;

  // Validate: head strategy is not supported with isolated providers
  if (effectiveBranchType === "head" && options.sandbox.tag === "isolated") {
    throw new Error(
      "head branch strategy is not supported with isolated providers",
    );
  }

  // Validate: copyToWorktree is incompatible with head strategy
  if (
    effectiveBranchType === "head" &&
    options.copyToWorktree &&
    options.copyToWorktree.length > 0
  ) {
    throw new Error(
      "copyToWorktree is not supported with head branch strategy. " +
        "In head mode the host working directory is bind-mounted directly.",
    );
  }

  // Validate: resumeSession + maxIterations > 1 is not allowed
  if (options.resumeSession && maxIterations > 1) {
    throw new Error(
      "resumeSession cannot be combined with maxIterations > 1. " +
        "Resume applies to iteration 1 only; multi-iteration resume semantics are not supported.",
    );
  }

  // Validate: forkSession only makes sense alongside resumeSession.
  // It is wired internally by RunResult.fork() and never set on its own.
  if (options.forkSession && !options.resumeSession) {
    throw new Error(
      "forkSession requires resumeSession. " +
        "Use RunResult.fork(prompt) to fork the last captured session.",
    );
  }

  // Validate: output requires maxIterations === 1
  if (options.output && maxIterations !== 1) {
    throw new Error(
      "output requires maxIterations to be 1. " +
        "Structured output is only supported for single-iteration runs.",
    );
  }

  // Validate: output.maxRetries requires a provider that supports session
  // resumption. Fail at the earliest possible point — the issue is fully
  // determined by the inputs to run() and does not depend on the agent's
  // output. See issue #825.
  const outputMaxRetries = options.output?.maxRetries ?? 0;
  if (outputMaxRetries < 0 || !Number.isInteger(outputMaxRetries)) {
    throw new Error(
      "output.maxRetries must be a non-negative integer. " +
        `Received: ${outputMaxRetries}`,
    );
  }
  if (outputMaxRetries > 0 && !provider.sessionStorage) {
    throw new Error(
      `output.maxRetries requires an agent provider that supports session resumption. ` +
        `The "${provider.name}" provider does not. Set maxRetries to 0.`,
    );
  }

  // Extract explicit branch when in branch mode
  const branch: string | undefined =
    branchStrategy.type === "branch" ? branchStrategy.branch : undefined;

  const hostRepoDir = await Effect.runPromise(
    resolveCwd(options.cwd).pipe(Effect.provide(NodeContext.layer)),
  );

  // Validate: resumeSession file must exist on the host
  if (options.resumeSession) {
    await assertResumeSessionExists({
      provider,
      hostRepoDir,
      resumeSession: options.resumeSession,
    });
  }

  // Resolve prompt
  const resolved = await Effect.runPromise(
    resolvePrompt({ prompt, promptFile }).pipe(
      Effect.provide(NodeContext.layer),
    ),
  );
  const rawPrompt = resolved.text;
  const isInlinePrompt = resolved.source === "inline";

  // Validate: output tag must appear in the resolved prompt
  if (options.output) {
    const openTag = `<${options.output.tag}>`;
    if (!rawPrompt.includes(openTag)) {
      throw new Error(
        `output tag <${options.output.tag}> not found in the resolved prompt. ` +
          "The caller must instruct the agent to emit the configured tag.",
      );
    }
  }

  const agentName = provider.name;

  // Resolve env vars and merge with provider env
  const resolvedEnv = await Effect.runPromise(
    resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
  );
  const env = mergeProviderEnv({
    resolvedEnv,
    agentProviderEnv: provider.env,
    sandboxProviderEnv: options.sandbox.env,
  });

  // Always capture the host's current branch for the TARGET_BRANCH built-in
  // prompt argument. When using a temp branch, it also prefixes the log filename.
  const currentHostBranch = await Effect.runPromise(
    getCurrentBranch(hostRepoDir),
  );

  // When in merge-to-head mode, generate a temporary branch name.
  // In head mode, use the host's current branch directly (no worktree).
  const resolvedBranch =
    effectiveBranchType === "head"
      ? currentHostBranch
      : (branch ?? generateTempBranchName(options.name));

  // When using a temp branch, prefix the log filename with the target branch
  // (the host's current branch) so developers can tell which branch was targeted.
  const targetBranch =
    effectiveBranchType === "merge-to-head" ? currentHostBranch : undefined;

  // Resolve logging option
  const resolvedLogging: LoggingOption = options.logging ?? {
    type: "file",
    path: join(
      hostRepoDir,
      ".sandcastle",
      "logs",
      buildLogFilename(resolvedBranch, targetBranch, options.name),
    ),
  };
  const displayLayer =
    resolvedLogging.type === "file"
      ? (() => {
          printFileDisplayStartup({
            logPath: resolvedLogging.path,
            agentName: options.name,
            branch: resolvedBranch,
            hostRepoDir,
          });
          return Layer.provide(
            FileDisplay.layer(resolvedLogging.path),
            NodeFileSystem.layer,
          );
        })()
      : ClackDisplay.layer;

  const factoryLayer = Layer.provide(
    WorktreeDockerSandboxFactory.layer,
    Layer.mergeAll(
      Layer.succeed(SandboxConfig, {
        env,
        hostRepoDir,
        copyToWorktree: options.copyToWorktree,
        name: options.name,
        sandboxProvider: options.sandbox,
        branchStrategy,
        hooks,
        signal: options.signal,
        timeouts: options.timeouts,
      }),
      NodeFileSystem.layer,
      displayLayer,
    ),
  );

  const streamEmitterLayer = agentStreamEmitterLayer(
    buildAgentStreamHandler(resolvedLogging),
  );

  const runLayer = Layer.mergeAll(
    factoryLayer,
    displayLayer,
    streamEmitterLayer,
  );

  const baseEffect = Effect.gen(function* () {
    const d = yield* Display;
    yield* d.intro(options.name ?? "sandcastle");
    const rows = buildRunSummaryRows({
      name: options.name,
      agentName,
      sandboxName: options.sandbox.name,
      maxIterations,
      branch: resolvedBranch,
    });
    yield* d.summary("Sandcastle Run", rows);

    const userArgs = options.promptArgs ?? {};

    // Inline prompts pass through to the agent literally — no substitution,
    // no built-in arg injection. Guard against silently ignoring promptArgs.
    let resolvedPrompt: string;
    if (isInlinePrompt) {
      yield* validateNoArgsWithInlinePrompt(userArgs);
      resolvedPrompt = rawPrompt;
    } else {
      yield* validateNoBuiltInArgOverride(userArgs);
      const effectiveArgs = {
        SOURCE_BRANCH: resolvedBranch,
        TARGET_BRANCH: currentHostBranch,
        ...userArgs,
      };
      const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
      resolvedPrompt = yield* substitutePromptArgs(
        rawPrompt,
        effectiveArgs,
        builtInArgKeysSet,
      );
    }

    // In head mode, pass the host branch so SandboxLifecycle skips the merge step.
    // In merge-to-head mode, branch is undefined (triggers merge). In branch mode, it's the explicit branch.
    const orchestrateBranch =
      effectiveBranchType === "head" ? currentHostBranch : branch;

    const orchestrateResult = yield* orchestrate({
      hostRepoDir,
      iterations: maxIterations,
      hooks,
      prompt: resolvedPrompt,
      branch: orchestrateBranch,
      provider,
      completionSignal: options.completionSignal,
      idleTimeoutSeconds: options.idleTimeoutSeconds,
      completionTimeoutSeconds: options.completionTimeoutSeconds,
      name: options.name,
      resumeSession: options.resumeSession,
      forkSession: options.forkSession,
      signal: options.signal,
      skipPromptExpansion: isInlinePrompt,
      timeouts: options.timeouts,
      iterationRetries: options.iterationRetries,
    });

    const completion = buildCompletionMessage(
      orchestrateResult.completionSignal,
      orchestrateResult.iterations.length,
    );
    yield* d.status(completion.message, completion.severity);

    for (const line of buildContextWindowLines(orchestrateResult.iterations)) {
      yield* d.text(line);
    }

    return orchestrateResult;
  });

  // In file-logging mode, write errors to the log before they propagate.
  // In stdout mode (ClackDisplay), errors are already shown by withFriendlyErrors
  // in main.ts, so we skip to avoid duplicate terminal output.
  const withErrorLog =
    resolvedLogging.type === "file"
      ? baseEffect.pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              const d = yield* Display;
              yield* d.status(
                formatErrorMessage(error as SandboxError),
                "error",
              );
            }),
          ),
        )
      : baseEffect;

  let result: OrchestrateResult;
  try {
    result = await Effect.runPromise(
      withErrorLog.pipe(Effect.provide(runLayer)),
    );
  } catch (error: unknown) {
    // If the signal was aborted, surface its reason verbatim (no wrapping)
    options.signal?.throwIfAborted();
    throw error;
  }

  const baseResult = {
    ...result,
    logFilePath:
      resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
    resume: async (
      prompt: string,
      resumeOptions?: ResumeRunResultOptions,
    ): Promise<RunResult> => {
      const lastIteration = result.iterations.at(-1);
      if (!lastIteration?.sessionId) {
        throw new Error("Cannot resume: no sessionId was captured");
      }
      return run({
        ...options,
        ...resumeOptions,
        prompt,
        promptFile: undefined,
        maxIterations: 1,
        resumeSession: lastIteration.sessionId,
      });
    },
    fork: async (
      prompt: string,
      forkOptions?: ResumeRunResultOptions,
    ): Promise<RunResult> => {
      const lastIteration = result.iterations.at(-1);
      if (!lastIteration?.sessionId) {
        throw new Error("Cannot fork: no sessionId was captured");
      }
      return run({
        ...options,
        ...forkOptions,
        prompt,
        promptFile: undefined,
        maxIterations: 1,
        resumeSession: lastIteration.sessionId,
        forkSession: true,
      });
    },
  };

  // Extract structured output after the iteration completes (separate pass from completion signal)
  if (options.output) {
    // Structured output runs are single-iteration, so the last iteration is the
    // one that produced this stdout. Carry its session id onto the error so a
    // caller can resume the same session to re-emit corrected output.
    const lastIteration = baseResult.iterations.at(-1);
    try {
      const output = await extractStructuredOutput(
        baseResult.stdout,
        options.output,
        {
          commits: baseResult.commits,
          branch: baseResult.branch,
          preservedWorktreePath: baseResult.preservedWorktreePath,
          sessionId: lastIteration?.sessionId,
          sessionFilePath: lastIteration?.sessionFilePath,
        },
      );
      return { ...baseResult, output };
    } catch (error) {
      // Built-in retry: when maxRetries > 0 and the agent emitted a session id
      // we can resume, recurse with a token-efficient feedback prompt. Each
      // retry decrements maxRetries so the recursion terminates. See issue
      // #825.
      if (
        error instanceof StructuredOutputError &&
        outputMaxRetries > 0 &&
        error.sessionId !== undefined
      ) {
        const retriesRemainingAfter = outputMaxRetries - 1;
        const retryOutput = {
          ...options.output,
          maxRetries: retriesRemainingAfter,
        };
        return run({
          ...options,
          prompt: buildStructuredOutputRetryFeedback(
            error,
            retriesRemainingAfter,
          ),
          promptFile: undefined,
          promptArgs: undefined,
          resumeSession: error.sessionId,
          forkSession: false,
          output: retryOutput,
        } as RunOptions);
      }
      throw error;
    }
  }

  return baseResult;
}
