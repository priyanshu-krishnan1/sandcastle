import { Context, Effect, Exit, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { join } from "node:path";
import type { PlatformError } from "@effect/platform/Error";
import {
  AgentError,
  AgentIdleTimeoutError,
  CopyError,
  ExecError,
  SyncError,
  WorktreeError,
  type DockerError,
  type SandboxError,
} from "./errors.js";
import type { Timeouts } from "./RunConfig.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToWorktree } from "./CopyToWorktree.js";
import { Display } from "./Display.js";
import type {
  SandboxProvider,
  BranchStrategy,
  SandboxHandle,
} from "./SandboxProvider.js";
import { runHostHooks, type SandboxHooks } from "./SandboxLifecycle.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import {
  patchGitMountsForWindows,
  parseGitdirPath,
  SANDBOX_REPO_DIR,
} from "./mountUtils.js";

/**
 * Exhaustiveness check for a `switch` over a closed union — calling this in
 * the `default` arm makes TypeScript flag any unhandled case at the call
 * site (a compile error, not a silent fallthrough) if the union ever grows.
 */
const assertNever = (x: never): never => {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
};

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SandboxService {
  readonly exec: (
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      stdin?: string;
    },
  ) => Effect.Effect<ExecResult, ExecError>;

  /** Copy a file or directory from the host into the sandbox. */
  readonly copyIn: (
    hostPath: string,
    sandboxPath: string,
  ) => Effect.Effect<void, CopyError>;

  /** Copy a single file from the sandbox to the host. */
  readonly copyFileOut: (
    sandboxPath: string,
    hostPath: string,
  ) => Effect.Effect<void, CopyError>;
}

/**
 * Wrap a Promise-based sandbox handle into an Effect-based SandboxService.
 * Delegates copyIn/copyFileOut to `handle.transfer` when present — absent
 * for bind-mount and no-sandbox handles, whose filesystem is already shared
 * with the host, so both resolve to a clear failure instead of duck-typing
 * on which methods happen to exist.
 */
export const makeSandboxFromHandle = (
  handle: SandboxHandle,
): SandboxService => ({
  exec: (command, options) =>
    Effect.tryPromise({
      try: () => handle.exec(command, options),
      catch: (e) =>
        new ExecError({
          command,
          message: `exec failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    }),
  copyIn: (hostPath, sandboxPath) =>
    handle.transfer
      ? Effect.tryPromise({
          try: () => handle.transfer!.copyIn(hostPath, sandboxPath),
          catch: (e) =>
            new CopyError({
              message: `copyIn failed: ${e instanceof Error ? e.message : String(e)}`,
            }),
        })
      : Effect.fail(
          new CopyError({
            message: "copyIn is not supported for this sandbox provider",
          }),
        ),
  copyFileOut: (sandboxPath, hostPath) =>
    handle.transfer
      ? Effect.tryPromise({
          try: () => handle.transfer!.copyFileOut(sandboxPath, hostPath),
          catch: (e) =>
            new CopyError({
              message: `copyFileOut failed: ${e instanceof Error ? e.message : String(e)}`,
            }),
        })
      : Effect.fail(
          new CopyError({
            message: "copyFileOut is not supported for this sandbox provider",
          }),
        ),
});

// `SANDBOX_REPO_DIR` is defined in `./mountUtils.js` — a low-level, leaf
// utility module — so that module doesn't have to import this much larger
// orchestration file just for the constant. Re-exported here since this is
// where most callers have historically imported it from.
export { SANDBOX_REPO_DIR };

export interface SandboxInfo {
  /** Host-side path to the worktree directory (worktree/branch mode only). */
  readonly hostWorktreePath?: string;
  /** Absolute path to the worktree inside the sandbox, as reported by the provider. */
  readonly sandboxRepoPath: string;
  /** Sync changes from the sandbox to the host worktree (isolated providers only). */
  readonly applyToHost?: () => Effect.Effect<void, SyncError>;
  /** The bind-mount sandbox handle, available when the provider is a bind-mount provider. Used for session capture. */
  readonly bindMountHandle?: SandboxHandle;
  /** Mirrors `NoSandboxProvider.nativeGitTarget` — set when this provider's
   *  repo isn't reachable via the host's local filesystem, so
   *  `SandboxLifecycle.ts` routes git operations through the sandbox's own
   *  `exec` instead of the local host's git. */
  readonly nativeGitTarget?: boolean;
}

export interface WithSandboxResult<A> {
  readonly value: A;
  /** Host path to the preserved worktree, set when the worktree was left behind due to uncommitted changes. */
  readonly preservedWorktreePath?: string;
}

export class SandboxFactory extends Context.Tag("SandboxFactory")<
  SandboxFactory,
  {
    readonly withSandbox: <A, E, R>(
      makeEffect: (
        info: SandboxInfo,
        sandbox: SandboxService,
      ) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<WithSandboxResult<A>, E | SandboxError, R>;
  }
>() {}

export class SandboxConfig extends Context.Tag("SandboxConfig")<
  SandboxConfig,
  {
    readonly env: Record<string, string>;
    readonly hostRepoDir: string;
    /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
    readonly copyToWorktree?: string[];
    /** When specified, the run name is included in the auto-generated branch and worktree names. */
    readonly name?: string;
    /** Sandbox provider — delegates sandbox lifecycle to the provider. */
    readonly sandboxProvider: SandboxProvider;
    /** Branch strategy — controls how the agent's changes relate to branches. */
    readonly branchStrategy: BranchStrategy;
    /** Lifecycle hooks grouped by execution location (host or sandbox). */
    readonly hooks?: SandboxHooks;
    /** AbortSignal threaded to lifecycle hooks so they can cooperatively cancel. */
    readonly signal?: AbortSignal;
    /** Override default timeouts for built-in lifecycle steps. */
    readonly timeouts?: Timeouts;
  }
>() {}

/**
 * Print a message to stderr about a preserved worktree, with review and
 * cleanup instructions. Exported so other close()/doClose() implementations
 * (createSandbox.ts, createWorktree.ts) give the user the same guidance
 * SandboxFactory's own worktree cleanup does, instead of preserving a
 * worktree on disk with no indication anything was left behind.
 */
export const printWorktreePreservedMessage = (
  worktreePath: string,
  reason: string,
): void => {
  console.error(`\n${reason}`);
  console.error(`  To review: cd ${worktreePath}`);
  console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
};

/**
 * Check for uncommitted changes and either preserve or remove the worktree.
 * Returns the preserved path if preserved, undefined if removed.
 */
const cleanupWorktree = (
  worktreePath: string,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<string | undefined, WorktreeError> =>
  WorktreeManager.hasUncommittedChanges(worktreePath).pipe(
    Effect.catchAll(() => Effect.succeed(false)),
    Effect.flatMap((isDirty) => {
      if (isDirty) {
        printWorktreePreservedMessage(
          worktreePath,
          Exit.isSuccess(exit)
            ? `Run succeeded but worktree has uncommitted changes at ${worktreePath}`
            : `Worktree preserved at ${worktreePath}`,
        );
        return Effect.succeed(worktreePath as string | undefined);
      }
      if (!Exit.isSuccess(exit)) {
        console.error(`\nWorktree removed (no uncommitted changes)`);
      }
      return WorktreeManager.remove(worktreePath).pipe(
        Effect.map(() => undefined as string | undefined),
      );
    }),
  );

/**
 * Attach the preserved worktree path to AgentIdleTimeoutError and AgentError so
 * programmatic callers can build on top of the preserved worktree. Exported
 * for reuse by other close()/error-path cleanup implementations
 * (createWorktree.ts, interactive.ts) so an error surfaced from any of them
 * carries the same information an error from run() does.
 */
export const attachPreservedPath = <E>(
  path: string | undefined,
  e: E | SandboxError,
): E | SandboxError => {
  if (path !== undefined) {
    if (e instanceof AgentIdleTimeoutError) {
      return new AgentIdleTimeoutError({
        message: e.message,
        timeoutMs: e.timeoutMs,
        preservedWorktreePath: path,
      }) as unknown as E | SandboxError;
    }
    if (e instanceof AgentError) {
      return new AgentError({
        message: e.message,
        preservedWorktreePath: path,
      }) as unknown as E | SandboxError;
    }
  }
  return e;
};

export interface MountEntry {
  readonly hostPath: string;
  readonly sandboxPath: string;
}

/**
 * Resolves the git-related mounts needed for the sandbox.
 * Handles both normal repos (where .git is a directory) and worktrees
 * (where .git is a file pointing to the parent repo's .git/worktrees/<name>).
 */
export const resolveGitMounts = (
  gitPath: string,
): Effect.Effect<MountEntry[], PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(gitPath);
    if (stat.type === "Directory") {
      return [{ hostPath: gitPath, sandboxPath: gitPath }];
    }
    // Worktree: .git is a file with "gitdir: <path>"
    const content = (yield* fs.readFileString(gitPath)).trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) {
      // Unrecognized format — fall back to mounting the file as-is
      return [{ hostPath: gitPath, sandboxPath: gitPath }];
    }
    const gitdirPath = match[1]!;
    // gitdirPath is like /path/to/repo/.git/worktrees/<name> — reuse
    // parseGitdirPath (mountUtils.ts) rather than re-deriving parentGitDir
    // here, so there's one platform-aware (handles both `/` and `\`)
    // implementation of this parsing instead of two that can drift.
    const { parentGitDir } = parseGitdirPath(gitdirPath);
    return [
      { hostPath: gitPath, sandboxPath: gitPath },
      { hostPath: parentGitDir, sandboxPath: parentGitDir },
    ];
  });

/**
 * Resolve `hostRepoDir`'s git mounts and patch them for Windows worktree
 * compatibility (ADR-0006) against `targetPath`. The bind-mount-provider
 * setup step shared by `startSandboxAgainstTarget` (below) and
 * `createSandbox.ts`'s `createSandboxFromWorktree`, which can't itself call
 * `startSandboxAgainstTarget` (see the comment at its call site) but
 * performed this exact sequence independently before this extraction.
 * Leaves `FileSystem.FileSystem` in the requirement channel rather than
 * providing it, so each call site keeps satisfying it its own way (ambient
 * `Effect.gen` context vs. an explicit `Effect.provide`).
 */
export const resolveAndPatchGitMounts = (
  hostRepoDir: string,
  targetPath: string,
): Effect.Effect<MountEntry[], WorktreeError, FileSystem.FileSystem> =>
  resolveGitMounts(join(hostRepoDir, ".git")).pipe(
    Effect.mapError(
      (e) =>
        new WorktreeError({
          message: `Failed to resolve git mounts: ${e}`,
        }),
    ),
    Effect.flatMap((gitMounts) =>
      patchGitMountsForWindows(gitMounts, targetPath, SANDBOX_REPO_DIR),
    ),
  );

// ---------------------------------------------------------------------------
// acquireSandbox / releaseSandbox — the setup/teardown primitives underneath
// withSandbox, factored out so a caller that needs a sandbox to outlive a
// single scoped callback (createSandbox(), createWorktree(), interactive())
// can call acquireSandbox() once, use the result across many operations, and
// call releaseSandbox() only at the point it actually wants to tear down —
// instead of hand-rolling this same acquire sequence, as those three files
// previously did (see the decoupling-plan writeup: ~70 lines duplicated per
// call site, with real behavioral drift between the copies).
// ---------------------------------------------------------------------------

export interface AcquireSandboxOptions {
  readonly env: Record<string, string>;
  readonly hostRepoDir: string;
  /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
  readonly copyToWorktree?: string[];
  /** When specified, the run name is included in the auto-generated branch and worktree names. */
  readonly name?: string;
  readonly sandboxProvider: SandboxProvider;
  readonly branchStrategy: BranchStrategy;
  readonly hooks?: SandboxHooks;
  readonly signal?: AbortSignal;
  readonly timeouts?: Timeouts;
}

export interface AcquiredSandbox {
  readonly sandboxInfo: SandboxInfo;
  readonly sandbox: SandboxService;
  readonly handle: SandboxHandle;
  /**
   * Present only when this acquisition created or reused a worktree — i.e.
   * every branch strategy except `head`. `releaseSandbox` uses this to
   * decide whether there's a worktree to preserve-or-remove at all.
   */
  readonly worktreeInfo: WorktreeManager.WorktreeInfo | undefined;
}

export interface StartSandboxAgainstTargetOptions {
  readonly env: Record<string, string>;
  readonly hostRepoDir: string;
  /** Where the code actually lives: `hostRepoDir` itself for head mode, a worktree's path otherwise. */
  readonly targetPath: string;
  /** Paths relative to the host repo root to copy into `targetPath` before sandbox start. Omit for head mode (nothing to copy) or when the target already has everything it needs (e.g. an existing worktree, reused across multiple sandbox starts). */
  readonly copyToWorktree?: string[];
  readonly sandboxProvider: SandboxProvider;
  readonly hooks?: SandboxHooks;
  readonly signal?: AbortSignal;
  readonly timeouts?: Timeouts;
}

/**
 * Start a sandbox against an existing target directory — no worktree
 * creation. Copies paths (if any), runs onWorktreeReady hooks, resolves and
 * patches git mounts, and starts the sandbox. This is the piece of
 * `acquireSandbox` that stays the same whether the worktree was just
 * created for this one acquisition or already existed independently of it
 * (a `Worktree` from `createWorktree()`, handed to many `run()`/
 * `interactive()` calls over its lifetime) — exported standalone so a
 * caller in the second situation isn't stuck re-deriving the same
 * per-provider-category branching `acquireSandbox` already has.
 */
export const startSandboxAgainstTarget = (
  options: StartSandboxAgainstTargetOptions,
): Effect.Effect<
  Omit<AcquiredSandbox, "worktreeInfo">,
  SandboxError,
  FileSystem.FileSystem | Display
> =>
  Effect.gen(function* () {
    const {
      env,
      hostRepoDir,
      targetPath,
      copyToWorktree: copyPaths,
      sandboxProvider,
      hooks,
      signal,
      timeouts,
    } = options;
    const display = yield* Display;

    const runOnWorktreeReady = () =>
      hooks?.host?.onWorktreeReady?.length
        ? runHostHooks(hooks.host.onWorktreeReady, targetPath, signal)
        : Effect.void;

    const runCopyToWorktree = () =>
      copyPaths && copyPaths.length > 0
        ? display.spinner(
            "Copying to worktree",
            copyToWorktree(
              copyPaths,
              hostRepoDir,
              targetPath,
              timeouts?.copyToWorktreeMs,
            ),
          )
        : Effect.succeed(undefined);

    // Exhaustive dispatch on provider category — a switch with an
    // `assertNever` default, not the previous if/if/fallthrough-with-cast,
    // so a fourth `SandboxProvider` tag is a compile error at the default
    // arm below instead of silently landing in the bind-mount branch.
    switch (sandboxProvider.tag) {
      // No-sandbox providers: run directly on the host, no container or mounts.
      case "none": {
        yield* runCopyToWorktree();
        yield* runOnWorktreeReady();
        const { sandbox, worktreePath, handle } = yield* startSandbox({
          provider: sandboxProvider,
          hostRepoDir,
          env,
          worktreeOrRepoPath: targetPath,
        });
        // A nativeGitTarget provider's repo isn't targetPath (a local path
        // computed for a worktree that may not even be relevant) — it's
        // whatever the handle itself reports as worktreePath (e.g.
        // fyreNative's repoPath). Report no hostWorktreePath at all so
        // SandboxLifecycle.ts doesn't treat a meaningless local path as the
        // repo location.
        return {
          sandboxInfo: {
            hostWorktreePath: sandboxProvider.nativeGitTarget
              ? undefined
              : targetPath,
            sandboxRepoPath: worktreePath,
            nativeGitTarget: sandboxProvider.nativeGitTarget,
          },
          sandbox,
          handle,
        };
      }

      // Isolated providers sync via git bundle. Note `copyPaths` is threaded
      // into `startSandbox` here (not applied via `runCopyToWorktree`) —
      // isolated providers copy the whole target into the sandbox via
      // sync-in, so extra paths ride along with that same transfer rather
      // than a separate host-side step.
      case "isolated": {
        yield* runOnWorktreeReady();
        const { sandbox, worktreePath, handle } = yield* startSandbox({
          provider: sandboxProvider,
          hostRepoDir: targetPath,
          env,
          copyPaths,
        });
        return {
          sandboxInfo: {
            hostWorktreePath: targetPath,
            sandboxRepoPath: worktreePath,
            applyToHost: () => syncOut(targetPath, handle),
          },
          sandbox,
          handle,
        };
      }

      // Bind-mount provider.
      case "bind-mount": {
        yield* runCopyToWorktree();
        yield* runOnWorktreeReady();
        const gitMounts = yield* resolveAndPatchGitMounts(
          hostRepoDir,
          targetPath,
        );
        const { sandbox, worktreePath, handle } = yield* startSandbox({
          provider: sandboxProvider,
          hostRepoDir,
          env,
          worktreeOrRepoPath: targetPath,
          gitMounts,
          repoDir: SANDBOX_REPO_DIR,
        });
        return {
          sandboxInfo: {
            hostWorktreePath: targetPath,
            sandboxRepoPath: worktreePath,
            bindMountHandle: handle,
          },
          sandbox,
          handle,
        };
      }

      default:
        return assertNever(sandboxProvider);
    }
  });

/**
 * Acquire a live sandbox: prune stale worktrees, create or reuse one if the
 * branch strategy needs it, then `startSandboxAgainstTarget` against it (or
 * against `hostRepoDir` directly, for head mode). Schedules no release — if
 * a step after worktree creation fails, the worktree this function itself
 * created is still cleaned up (preserved-if-dirty) before the failure
 * propagates, but a *successful* return hands the whole lifecycle —
 * including the worktree — to the caller. Pair with `releaseSandbox`.
 */
export const acquireSandbox = (
  options: AcquireSandboxOptions,
): Effect.Effect<
  AcquiredSandbox,
  SandboxError,
  FileSystem.FileSystem | Display
> =>
  Effect.gen(function* () {
    const {
      env,
      hostRepoDir,
      copyToWorktree,
      name,
      sandboxProvider,
      branchStrategy,
      hooks,
      signal,
      timeouts,
    } = options;

    const isHeadMode = branchStrategy.type === "head";
    const branch =
      branchStrategy.type === "branch" ? branchStrategy.branch : undefined;
    const baseBranch =
      branchStrategy.type === "branch" ? branchStrategy.baseBranch : undefined;
    const fileSystem = yield* FileSystem.FileSystem;
    const display = yield* Display;

    const startAgainst = (targetPath: string) =>
      provideAcquireDepsLocal(
        startSandboxAgainstTarget({
          env,
          hostRepoDir,
          targetPath,
          copyToWorktree,
          sandboxProvider,
          hooks,
          signal,
          timeouts,
        }),
      );

    // Satisfy startSandboxAgainstTarget's own Display | FileSystem
    // requirement from the values already resolved above, the same way the
    // Layer-construction call site does for acquireSandbox itself.
    function provideAcquireDepsLocal<A2, E2>(
      effect: Effect.Effect<A2, E2, Display | FileSystem.FileSystem>,
    ): Effect.Effect<A2, E2> {
      return effect.pipe(
        Effect.provideService(Display, display),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
    }

    if (isHeadMode) {
      const { sandboxInfo, sandbox, handle } = yield* startAgainst(hostRepoDir);
      return { sandboxInfo, sandbox, handle, worktreeInfo: undefined };
    }

    /** Prune stale worktrees (best-effort), then create a fresh one. */
    const pruneAndCreate = () =>
      WorktreeManager.pruneStale(hostRepoDir).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => {
            console.error(
              "[sandcastle] Warning: failed to prune stale worktrees:",
              e.message,
            );
          }),
        ),
        Effect.andThen(
          branch
            ? WorktreeManager.create(hostRepoDir, { branch, baseBranch })
            : WorktreeManager.create(hostRepoDir, { name }),
        ),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );

    // Create/reuse a worktree, then start a sandbox against it. If startup
    // fails, the worktree is cleaned up (preserved-if-dirty, with the same
    // message/attachPreservedPath handling `withSandbox` always gave a
    // mid-setup failure) before the failure propagates. If it succeeds, the
    // worktree's lifecycle passes to the caller untouched — this function
    // does not remove or preserve it on the success path.
    let preservedPath: string | undefined;
    return yield* Effect.acquireUseRelease(
      pruneAndCreate(),
      (worktreeInfo) =>
        startAgainst(worktreeInfo.path).pipe(
          Effect.map(({ sandboxInfo, sandbox, handle }) => ({
            sandboxInfo,
            sandbox,
            handle,
            worktreeInfo,
          })),
        ),
      (worktreeInfo, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : cleanupWorktree(worktreeInfo.path, exit).pipe(
              Effect.tap((p) => {
                preservedPath = p;
              }),
              Effect.asVoid,
              Effect.orDie,
            ),
    ).pipe(
      Effect.mapError((e: SandboxError) =>
        attachPreservedPath(preservedPath, e),
      ),
    );
  });

/**
 * Release a sandbox acquired via `acquireSandbox`: close the handle, then —
 * if this acquisition owns a worktree — preserve it (with the same message
 * `withSandbox` always printed) if it has uncommitted changes, otherwise
 * remove it. Returns the preserved path, if any.
 *
 * `exit` is the outcome of whatever work the caller did with the acquired
 * sandbox, if there's a meaningful one to report — `withSandbox` passes the
 * real exit of `makeEffect` through so `cleanupWorktree`'s messaging
 * distinguishes "worktree preserved after a failure" from "run succeeded
 * but left uncommitted changes". A caller with no single "did the run
 * succeed" moment (an explicit `.close()` on a long-lived, possibly
 * multi-run sandbox) can omit it — defaults to a successful exit.
 */
export const releaseSandbox = (
  acquired: AcquiredSandbox,
  exit: Exit.Exit<unknown, unknown> = Exit.succeed(undefined),
): Effect.Effect<{ readonly preservedWorktreePath?: string }, never> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => acquired.handle.close(),
      catch: () => undefined,
    }).pipe(Effect.orDie);

    if (!acquired.worktreeInfo) {
      return { preservedWorktreePath: undefined };
    }

    const preservedWorktreePath = yield* cleanupWorktree(
      acquired.worktreeInfo.path,
      exit,
    ).pipe(Effect.orDie);
    return { preservedWorktreePath };
  });

export const WorktreeDockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const config = yield* SandboxConfig;
      // Resolved once here (matching the pre-extraction layer's own
      // behavior) so withSandbox's returned Effect doesn't leak
      // acquireSandbox's Display | FileSystem.FileSystem requirement into
      // its R channel — the interface promises exactly the caller's own R.
      const display = yield* Display;
      const fileSystem = yield* FileSystem.FileSystem;
      const provideAcquireDeps = <A2, E2>(
        effect: Effect.Effect<A2, E2, Display | FileSystem.FileSystem>,
      ): Effect.Effect<A2, E2> =>
        effect.pipe(
          Effect.provideService(Display, display),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );

      return {
        withSandbox: <A, E, R>(
          makeEffect: (
            info: SandboxInfo,
            sandbox: SandboxService,
          ) => Effect.Effect<A, E, R>,
        ): Effect.Effect<WithSandboxResult<A>, E | SandboxError, R> => {
          let preservedPath: string | undefined;
          return Effect.acquireUseRelease(
            provideAcquireDeps(acquireSandbox(config)),
            (acquired) =>
              makeEffect(
                acquired.sandboxInfo,
                acquired.sandbox,
              ) as Effect.Effect<A, E | SandboxError, R>,
            (acquired, exit) =>
              releaseSandbox(acquired, exit).pipe(
                Effect.tap(({ preservedWorktreePath }) => {
                  preservedPath = preservedWorktreePath;
                }),
                Effect.asVoid,
              ),
          ).pipe(
            Effect.map((value) => ({
              value,
              preservedWorktreePath: preservedPath,
            })),
            Effect.mapError((e: E | SandboxError) =>
              attachPreservedPath(preservedPath, e),
            ),
          );
        },
      };
    }),
  ),
};
