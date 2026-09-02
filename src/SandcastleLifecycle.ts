/**
 * `SandcastleLifecycle` — a pluggable, phase-based engine for workflows that
 * don't fit "repo lives on the local host filesystem, needs a worktree":
 * `noGitLifecycle` (no git at all — artifact-based work) and
 * `remoteOnlyLifecycle` (repo lives on a remote host reached over SSH,
 * commits stay there).
 *
 * This is deliberately NOT a general replacement for `withSandboxLifecycle`
 * (./SandboxLifecycle.js), and the two are not "duplicate implementations of
 * the same lifecycle" at risk of drifting apart — `withSandboxLifecycle`
 * does real work neither preset here needs: worktree creation, bind-mount
 * vs. isolated-provider sync, host git-identity propagation, and
 * merge/cherry-pick onto the host branch. Forcing both onto one shared
 * 4-phase shape would mean adding parameters and moving logic across phase
 * boundaries in `withSandboxLifecycle` purely to satisfy a preset that
 * doesn't need them — that's not attempted here. These are purpose-built
 * engines for cases `withSandboxLifecycle` structurally doesn't cover, and
 * nothing in this codebase constructs a `SandcastleLifecycle` yet; this is
 * the seam a future caller-side preset selector would use.
 *
 * The one piece of real logic these two engines *do* share with
 * `withSandboxLifecycleImpl` is sandbox-hook cancellation, so it isn't
 * reimplemented here — `runSandboxHooks` below delegates to
 * `runSandboxHooksWithAbort` (./SandboxLifecycle.js), the exact
 * `AbortSignal`-via-`Deferred` mechanism the real lifecycle uses, so a
 * `signal` passed into `noGitLifecycle`/`remoteOnlyLifecycle` behaves
 * identically to one passed into `withSandboxLifecycle`.
 */
import { Effect, Layer } from "effect";
import { Display } from "./Display.js";
import { runSandboxHooksWithAbort } from "./SandboxLifecycle.js";
import { type SandboxService } from "./SandboxFactory.js";
import { GitClient, gitClientLayerFor } from "./GitClient.js";
import type { RepoRef } from "./RepoRef.js";
import {
  type ExecError,
  type HookTimeoutError,
  type SandboxError,
} from "./errors.js";

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
 * Runs `hooks` in the sandbox via `runSandboxHooksWithAbort` — the same
 * `AbortSignal`-via-`Deferred` cancellation `withSandboxLifecycleImpl` uses,
 * shared rather than reimplemented. `signal` defaults to a never-aborted one
 * so callers that don't need cancellation can omit it.
 */
export const runSandboxHooks = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  hooks: ReadonlyArray<SandboxHookSpec>,
  signal: AbortSignal = new AbortController().signal,
): Effect.Effect<void, ExecError | HookTimeoutError> =>
  runSandboxHooksWithAbort(sandbox, sandboxRepoDir, hooks, signal);

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
 * there's no git to report on). `config.signal`, when passed, lets hooks
 * cancel cooperatively via `runSandboxHooks`'s abort racing.
 */
export const noGitLifecycle = (config?: {
  readonly hooks?: ReadonlyArray<SandboxHookSpec>;
  readonly signal?: AbortSignal;
}): SandcastleLifecycle => ({
  beforeWork: (ctx) =>
    config?.hooks?.length
      ? runSandboxHooks(
          ctx.sandbox,
          ctx.sandboxRepoDir,
          config.hooks,
          config.signal,
        )
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
  /** Lets hooks cancel cooperatively via `runSandboxHooks`'s abort racing. */
  readonly signal?: AbortSignal;
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
        ? runSandboxHooks(
            ctx.sandbox,
            ctx.sandboxRepoDir,
            config.hooks,
            config.signal,
          )
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
