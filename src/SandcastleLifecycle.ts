/**
 * `SandcastleLifecycle` — a pluggable, phase-based alternative to
 * `withSandboxLifecycle` (./SandboxLifecycle.js) for workflows that don't fit
 * "repo lives on the local host filesystem": `noGitLifecycle` (no git at
 * all — artifact-based work) and `remoteOnlyLifecycle` (repo lives on a
 * remote host reached over SSH, commits stay there).
 *
 * `withSandboxLifecycle` itself is unchanged and remains the local preset —
 * it already does everything a `localGitLifecycle` would (worktree, hooks,
 * merge/cherry-pick, commit collection), so it isn't reshaped into this
 * interface. Nothing in this codebase constructs a `SandcastleLifecycle` yet;
 * this is the seam a future caller-side preset selector would use.
 *
 * Sandbox hooks here run sequentially with no cooperative abort support —
 * unlike `withSandboxLifecycleImpl`'s hook runner, which races hooks against
 * an `AbortSignal` via `Deferred` because `SandboxHandle.exec` has no native
 * cancellation. That complexity isn't duplicated here; it's a known gap for
 * these two new presets, not an oversight.
 */
import { Effect, Layer } from "effect";
import { Display } from "./Display.js";
import { execOk } from "./SandboxLifecycle.js";
import { type SandboxService } from "./SandboxFactory.js";
import { GitClient, gitClientLayerFor } from "./GitClient.js";
import type { RepoRef } from "./RepoRef.js";
import {
  ExecError,
  HookTimeoutError,
  withTimeout,
  type SandboxError,
} from "./errors.js";

const HOOK_TIMEOUT_MS = 60_000;

export interface LifecycleContext {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
}

export interface LifecycleResult {
  readonly branch: string;
  readonly commits: { sha: string }[];
}

/**
 * A pluggable lifecycle: any phase left unset is a no-op (`beforeWork`/
 * `afterWork`) or contributes nothing to the result (`setup`/`teardown`).
 * One shared `LifecycleContext` for every phase — no `noGitLifecycle`/
 * `remoteOnlyLifecycle` phase built here needs a different shape per phase.
 */
export interface SandcastleLifecycle {
  readonly setup?: () => Effect.Effect<void, SandboxError, Display>;
  readonly beforeWork?: (
    ctx: LifecycleContext,
  ) => Effect.Effect<void, SandboxError, Display>;
  readonly afterWork?: (
    ctx: LifecycleContext,
  ) => Effect.Effect<void, SandboxError, Display>;
  readonly teardown?: () => Effect.Effect<
    LifecycleResult,
    SandboxError,
    Display
  >;
}

export type SandboxHookSpec = {
  readonly command: string;
  readonly sudo?: boolean;
  readonly timeoutMs?: number;
};

/**
 * Runs `hooks` sequentially in the sandbox, failing fast on the first
 * non-zero exit or per-hook timeout. See the file header for why this is
 * sequential/non-cancellable, unlike `withSandboxLifecycleImpl`'s hook
 * runner.
 */
export const runSandboxHooks = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  hooks: ReadonlyArray<SandboxHookSpec>,
): Effect.Effect<void, ExecError | HookTimeoutError> =>
  Effect.gen(function* () {
    for (const hook of hooks) {
      const timeout = hook.timeoutMs ?? HOOK_TIMEOUT_MS;
      yield* execOk(sandbox, hook.command, {
        cwd: sandboxRepoDir,
        sudo: hook.sudo,
      }).pipe(
        withTimeout(
          timeout,
          () =>
            new HookTimeoutError({
              message: `Hook '${hook.command}' timed out after ${timeout}ms`,
              timeoutMs: timeout,
              command: hook.command,
            }),
        ),
      );
    }
  });

/**
 * Sequences a `SandcastleLifecycle`'s phases around `work`:
 * `setup? → beforeWork? → work → afterWork? → teardown?`. Missing phases
 * default to a no-op / `{branch: "", commits: []}`. This is what a future
 * caller would invoke instead of `withSandboxLifecycle` once one of these
 * presets is actually wired up to a public entry point.
 */
export const runLifecycle = <A>(
  lifecycle: SandcastleLifecycle,
  ctx: LifecycleContext,
  work: (ctx: LifecycleContext) => Effect.Effect<A, SandboxError, Display>,
): Effect.Effect<{ result: A } & LifecycleResult, SandboxError, Display> =>
  Effect.gen(function* () {
    yield* lifecycle.setup?.() ?? Effect.void;
    yield* lifecycle.beforeWork?.(ctx) ?? Effect.void;
    const result = yield* work(ctx);
    yield* lifecycle.afterWork?.(ctx) ?? Effect.void;
    const { branch, commits } = yield* lifecycle.teardown?.() ??
      Effect.succeed({ branch: "", commits: [] } as LifecycleResult);
    return { result, branch, commits };
  });

/**
 * No git at all — artifact-based work. `beforeWork` runs `config.hooks` (if
 * any); everything else is the interface's default (no branch, no commits —
 * there's no git to report on).
 */
export const noGitLifecycle = (config?: {
  readonly hooks?: ReadonlyArray<SandboxHookSpec>;
}): SandcastleLifecycle => ({
  beforeWork: (ctx) =>
    config?.hooks?.length
      ? runSandboxHooks(ctx.sandbox, ctx.sandboxRepoDir, config.hooks)
      : Effect.void,
});

/**
 * Repo lives on a remote host reached over SSH — no worktree, no sync;
 * commits stay on `config.branch` on the remote. `gitClientLayer` defaults
 * to a real SSH-backed `GitClient` (`gitClientLayerFor`) but is overridable,
 * the same test-injection pattern `GitClient.ts`'s `makeRemoteGitExec`
 * already uses, so tests never open a real SSH connection. Each phase
 * self-provides this layer internally so the interface stays uniform with
 * `noGitLifecycle` — `GitClient` never appears in `SandcastleLifecycle`'s own
 * requirement channel.
 */
export const remoteOnlyLifecycle = (config: {
  readonly repoRef: Extract<RepoRef, { kind: "remote" }>;
  readonly branch: string;
  readonly hooks?: ReadonlyArray<SandboxHookSpec>;
  readonly gitClientLayer?: Layer.Layer<GitClient>;
}): SandcastleLifecycle => {
  const gitClientLayer =
    config.gitClientLayer ?? gitClientLayerFor(config.repoRef);
  let baseHead = "";

  return {
    setup: () =>
      Effect.gen(function* () {
        const gitClient = yield* GitClient;
        baseHead = yield* gitClient.revParseHead(config.repoRef.path);
      }).pipe(Effect.provide(gitClientLayer)),

    beforeWork: (ctx) =>
      config.hooks?.length
        ? runSandboxHooks(ctx.sandbox, ctx.sandboxRepoDir, config.hooks)
        : Effect.void,

    teardown: () =>
      Effect.gen(function* () {
        const gitClient = yield* GitClient;
        const shas = yield* gitClient.revList(
          config.repoRef.path,
          `${baseHead}..refs/heads/${config.branch}`,
        );
        return { branch: config.branch, commits: shas.map((sha) => ({ sha })) };
      }).pipe(Effect.provide(gitClientLayer)),
  };
};
