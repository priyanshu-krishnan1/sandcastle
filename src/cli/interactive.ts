import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import * as clack from "@clack/prompts";
import { Effect } from "effect";
import type { AgentProvider } from "../AgentProvider.js";
import { ClackDisplay, Display } from "../engine/display/Display.js";
import { preprocessPrompt } from "../engine/prompts/PromptPreprocessor.js";
import { resolvePrompt } from "../engine/prompts/PromptResolver.js";
import {
  acquireSandbox,
  releaseSandbox,
  attachPreservedPath,
} from "../engine/sandbox/SandboxFactory.js";
import {
  withSandboxLifecycle,
  type SandboxHooks,
} from "../engine/sandbox/SandboxLifecycle.js";
import type { AnySandboxProvider, BranchStrategy } from "../SandboxProvider.js";
import { resolveEnv } from "../engine/sandbox/EnvResolver.js";
import { mergeProviderEnv } from "../utils/mergeProviderEnv.js";
import {
  generateTempBranchName,
  getCurrentBranch,
} from "../engine/sandbox/WorktreeManager.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
  validateNoBuiltInArgOverride,
  findMissingPromptArgKeys,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "../engine/prompts/PromptArgumentSubstitution.js";
import { noSandbox } from "../sandboxes/no-sandbox.js";
import { raceAbortSignal } from "../utils/raceAbortSignal.js";
import { resolveCwd } from "../utils/resolveCwd.js";
import type { Timeouts } from "../engine/run/RunConfig.js";

export interface InteractiveOptions {
  /** Agent provider to use (e.g. bob("default")) */
  readonly agent: AgentProvider;
  /** Sandbox provider (e.g. docker(), noSandbox()). */
  readonly sandbox?: AnySandboxProvider;
  /** Inline prompt string (mutually exclusive with promptFile). */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt). */
  readonly promptFile?: string;
  /** Optional name for the interactive session. */
  readonly name?: string;
  /** Branch strategy — controls how the agent's changes relate to branches.
   * Defaults to { type: "head" } for bind-mount providers and { type: "merge-to-head" } for isolated providers. */
  readonly branchStrategy?: BranchStrategy;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: SandboxHooks;
  /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
  readonly copyToWorktree?: string[];
  /** Key-value map for {{KEY}} placeholder substitution in prompts */
  readonly promptArgs?: PromptArgs;
  /** Environment variables to inject into the sandbox. */
  readonly env?: Record<string, string>;
  /**
   * Host repo directory to use instead of `process.cwd()`.
   *
   * Relative paths resolve against `process.cwd()`; absolute paths pass
   * through as-is. A {@link CwdError} is thrown if the path does not exist
   * or is not a directory.
   */
  readonly cwd?: string;
  /**
   * An `AbortSignal` that cancels the interactive session when aborted.
   *
   * - If `signal.aborted` is already `true` at entry, `interactive()` rejects
   *   immediately without doing any setup work.
   * - Aborting during an active session kills the agent subprocess.
   * - The rejected promise surfaces `signal.reason` via
   *   `signal.throwIfAborted()` — no Sandcastle-specific wrapping.
   * - The worktree is preserved on disk after abort (error-path behavior).
   */
  readonly signal?: AbortSignal;
  /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
  readonly timeouts?: Timeouts;
}

export interface InteractiveResult {
  /** List of commits made during the interactive session. */
  readonly commits: { sha: string }[];
  /** The branch name the agent worked on. */
  readonly branch: string;
  /** Host path to the preserved worktree, if worktree had uncommitted changes. */
  readonly preservedWorktreePath?: string;
  /** Exit code of the interactive process. */
  readonly exitCode: number;
}

/**
 * Launch an interactive agent session inside a sandbox.
 *
 * The user sees the agent's TUI directly. When the session ends,
 * Sandcastle collects commits and handles branch merging, just like run().
 *
 * Full prompt preprocessing pipeline: PromptResolver -> PromptArgumentSubstitution
 * -> PromptPreprocessor (shell expressions inside sandbox).
 *
 * All three branch strategies are supported: head, merge-to-head, branch.
 */
export const interactive = async (
  options: InteractiveOptions,
): Promise<InteractiveResult> => {
  // If signal is already aborted, reject immediately without any setup
  options.signal?.throwIfAborted();

  const { prompt, promptFile, hooks, agent: provider } = options;

  const resolvedSandbox = options.sandbox ?? noSandbox();

  // Derive branch strategy
  const branchStrategy: BranchStrategy =
    options.branchStrategy ??
    (resolvedSandbox.tag === "isolated"
      ? { type: "merge-to-head" }
      : { type: "head" }); // "bind-mount" and "none" both default to head

  // Validate: head strategy is not supported with isolated providers
  if (branchStrategy.type === "head" && resolvedSandbox.tag === "isolated") {
    throw new Error(
      "head branch strategy is not supported with isolated providers",
    );
  }

  // Validate: copyToWorktree is incompatible with head strategy
  if (
    branchStrategy.type === "head" &&
    options.copyToWorktree &&
    options.copyToWorktree.length > 0
  ) {
    throw new Error(
      "copyToWorktree is not supported with head branch strategy. " +
        "In head mode the host working directory is bind-mounted directly.",
    );
  }

  // Validate buildInteractiveArgs is available
  if (!provider.buildInteractiveArgs) {
    throw new Error(
      `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`,
    );
  }

  const branch: string | undefined =
    branchStrategy.type === "branch" ? branchStrategy.branch : undefined;

  const isHeadMode = branchStrategy.type === "head";
  const sandboxProvider = resolvedSandbox;

  const inner = Effect.gen(function* () {
    const hostRepoDir = yield* resolveCwd(options.cwd);
    const d = yield* Display;

    // 1. Resolve prompt (from string or file), or skip if neither provided
    const hasPromptSource = prompt !== undefined || promptFile !== undefined;
    const resolved = hasPromptSource
      ? yield* resolvePrompt({ prompt, promptFile })
      : undefined;
    const rawPrompt = resolved?.text ?? "";
    const isInlinePrompt = resolved?.source === "inline";

    // 2. Resolve env vars
    const resolvedEnv = yield* resolveEnv(hostRepoDir);
    const env = mergeProviderEnv({
      resolvedEnv,
      agentProviderEnv: provider.env,
      sandboxProviderEnv: sandboxProvider.env,
    });
    const effectiveEnv = { ...env, ...(options.env ?? {}) };

    // 3. Capture host's current branch
    const currentHostBranch = yield* getCurrentBranch(hostRepoDir);

    const resolvedBranch =
      branchStrategy.type === "head"
        ? currentHostBranch
        : (branch ?? generateTempBranchName(options.name));

    // 4. Validate prompt args and collect missing ones interactively (skip when no prompt).
    // Inline prompts pass through literally — skip scanning, substitution, and built-in args.
    let substitutedPrompt = rawPrompt;
    if (hasPromptSource && !isInlinePrompt) {
      const userArgs = options.promptArgs ?? {};
      yield* validateNoBuiltInArgOverride(userArgs);

      // Scan for missing keys and prompt the user for each one
      const missingKeys = findMissingPromptArgKeys(rawPrompt, userArgs);
      const collectedArgs: Record<string, string> = {};
      for (const key of missingKeys) {
        const value = yield* Effect.promise(() =>
          clack.text({
            message: `Enter value for {{${key}}}`,
            validate: (v) => {
              if (!v) return `A value is required for {{${key}}}`;
            },
          }),
        );
        if (clack.isCancel(value)) {
          clack.cancel("Prompt arg collection cancelled.");
          return yield* Effect.fail(
            new Error("User cancelled prompt arg collection"),
          );
        }
        collectedArgs[key] = value;
      }

      const mergedUserArgs = { ...userArgs, ...collectedArgs };
      const effectiveArgs = {
        SOURCE_BRANCH: resolvedBranch,
        TARGET_BRANCH: currentHostBranch,
        ...mergedUserArgs,
      };
      const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
      substitutedPrompt = yield* substitutePromptArgs(
        rawPrompt,
        effectiveArgs,
        builtInArgKeysSet,
      );
    } else if (isInlinePrompt) {
      const userArgs = options.promptArgs ?? {};
      yield* validateNoArgsWithInlinePrompt(userArgs);
    }

    // In head mode, pass the host branch so SandboxLifecycle skips the merge step.
    const lifecycleBranch = isHeadMode ? currentHostBranch : branch;

    // Display intro and summary
    yield* d.intro(options.name ?? "sandcastle interactive");
    yield* d.summary("Interactive Session", {
      Agent: options.name ?? provider.name,
      Sandbox: sandboxProvider.name,
      Branch: resolvedBranch,
    });

    // 5. Acquire the sandbox — worktree creation, copying, hooks, git
    // mounts, and sandbox start — via the same primitive run(),
    // createSandbox(), and createWorktree() all share (SandboxFactory.ts's
    // acquireSandbox). On a setup failure it cleans up any worktree it
    // created before propagating; on success, this function owns that
    // lifecycle until releaseSandbox() below — matching exactly what
    // withSandbox() does for run(), instead of interactive() hand-rolling
    // its own copy of the same ~90-line sequence.
    let preservedWorktreePath: string | undefined;
    const { lifecycleResult, exitCode } = yield* Effect.acquireUseRelease(
      acquireSandbox({
        env: effectiveEnv,
        hostRepoDir,
        copyToWorktree: options.copyToWorktree,
        name: options.name,
        sandboxProvider,
        branchStrategy,
        hooks,
        signal: options.signal,
        timeouts: options.timeouts,
      }),
      (acquired) =>
        Effect.gen(function* () {
          const { handle, sandbox, sandboxInfo } = acquired;

          // Check interactiveExec is available (no-sandbox always has it; bind-mount/isolated it's optional)
          if (!handle.interactiveExec) {
            throw new Error(
              `Sandbox provider does not support interactiveExec. ` +
                `The provider must implement the optional interactiveExec method to use interactive().`,
            );
          }
          const interactiveExecFn = handle.interactiveExec.bind(handle);
          const worktreePath = sandboxInfo.sandboxRepoPath;

          const lifecycleEffect = withSandboxLifecycle(
            {
              hostRepoDir,
              sandboxRepoDir: worktreePath,
              hooks,
              branch: lifecycleBranch,
              hostWorktreePath: sandboxInfo.hostWorktreePath,
              applyToHost: sandboxInfo.applyToHost ?? (() => Effect.void),
              nativeGitTarget: sandboxInfo.nativeGitTarget,
              timeouts: options.timeouts,
            },
            sandbox,
            (ctx) =>
              Effect.gen(function* () {
                // Preprocess prompt (expand !`command` shell expressions inside sandbox).
                // Skip when no prompt source was provided, or when inline (literal passthrough).
                const fullPrompt =
                  !hasPromptSource || isInlinePrompt
                    ? substitutedPrompt
                    : yield* preprocessPrompt(
                        substitutedPrompt,
                        ctx.sandbox,
                        ctx.sandboxRepoDir,
                      );

                // Build interactive args and run the session
                const interactiveArgs = provider.buildInteractiveArgs!({
                  prompt: fullPrompt,
                  dangerouslySkipPermissions: sandboxProvider.tag !== "none",
                });

                const result = yield* raceAbortSignal(
                  Effect.promise(() =>
                    interactiveExecFn(interactiveArgs, {
                      stdin: process.stdin,
                      stdout: process.stdout,
                      stderr: process.stderr,
                      cwd: worktreePath,
                    }),
                  ),
                  options.signal,
                );

                return result.exitCode;
              }),
          );

          const lifecycleResult = yield* lifecycleEffect;
          return { lifecycleResult, exitCode: lifecycleResult.result };
        }),
      (acquired, exit) =>
        releaseSandbox(acquired, exit).pipe(
          Effect.tap((r) => {
            preservedWorktreePath = r.preservedWorktreePath;
          }),
          Effect.asVoid,
        ),
    ).pipe(
      Effect.mapError((e) => attachPreservedPath(preservedWorktreePath, e)),
    );

    // Final summary
    yield* d.summary("Session Complete", {
      Commits: String(lifecycleResult.commits.length),
      Branch: lifecycleResult.branch,
      "Exit code": String(exitCode),
      ...(preservedWorktreePath
        ? { "Preserved worktree": preservedWorktreePath }
        : {}),
    });

    return {
      commits: lifecycleResult.commits,
      branch: lifecycleResult.branch,
      preservedWorktreePath,
      exitCode,
    };
  });

  let result: InteractiveResult;
  try {
    result = await Effect.runPromise(
      inner.pipe(
        Effect.provide(ClackDisplay.layer),
        Effect.provide(NodeContext.layer),
        Effect.provide(NodeFileSystem.layer),
      ),
    );
  } catch (error: unknown) {
    // If the signal was aborted, surface its reason verbatim (no wrapping)
    options.signal?.throwIfAborted();
    throw error;
  }

  return result;
};
