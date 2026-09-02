/**
 * `GitClient` — the seam `SandboxLifecycle.ts` uses for every host-side git
 * operation (identity, current branch, merge, commit collection). Previously
 * these were hardcoded `node:child_process.exec` calls against the local
 * filesystem, baked directly into orchestration-level code with no injectable
 * abstraction — the reason a remote target (a target whose git repo lives on
 * a machine reached only over SSH, not the host running Sandcastle) could
 * never get the same merge/commit-collection safety net a local worktree
 * gets.
 *
 * `makeGitClient` is generic over how a command actually runs — it only
 * needs a function that executes `git ...` in some `cwd` and resolves with
 * stdout (rejecting on non-zero exit, matching `child_process.exec`'s own
 * contract). `LocalGitClient` below is `makeGitClient` fed the real local
 * `child_process.exec`, and reproduces the exact commands/behavior this
 * replaced. A remote implementation is the same factory fed a function that
 * runs the command over SSH instead — no new GitClientService methods, no
 * changes to SandboxLifecycle.ts, just a different `exec` argument.
 *
 * Per-operation failure semantics are preserved exactly from what
 * `SandboxLifecycle.ts` did before this extraction, not homogenized:
 * `currentBranch`/`revParseHead` die on an unexpected rejection (they were
 * `Effect.promise`, not `Effect.tryPromise`, originally); `identity`/
 * `hasCommitsInRange`/`revList`/`deleteBranch` are best-effort and never
 * fail (they were try/catch-to-default originally); `mergeBranch` is the one
 * genuinely typed failure, carrying the same descriptive recovery message
 * the caller previously constructed inline.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Context, Effect, Layer } from "effect";
import type { RepoRef } from "./RepoRef.js";
import { shellQuote } from "./shellQuote.js";

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface GitClientService {
  /** `git rev-parse --abbrev-ref HEAD` — the current branch name. */
  readonly currentBranch: (cwd: string) => Effect.Effect<string, never>;
  /** `git config user.name` / `user.email`. Best-effort — empty string per field when unset or unavailable. */
  readonly identity: (cwd: string) => Effect.Effect<GitIdentity, never>;
  /** `git rev-parse HEAD` — the current commit SHA. */
  readonly revParseHead: (cwd: string) => Effect.Effect<string, never>;
  /** Whether `range` (e.g. `"<base>..HEAD"`) contains any commits. Best-effort — `false` on failure. */
  readonly hasCommitsInRange: (
    cwd: string,
    range: string,
  ) => Effect.Effect<boolean, never>;
  /** SHAs in `range`, oldest first. Best-effort — empty array on failure. */
  readonly revList: (
    cwd: string,
    range: string,
  ) => Effect.Effect<string[], never>;
  /**
   * `git merge <branch>`. On failure, the error message names both branches
   * and the manual recovery commands — the temp branch is never deleted by
   * this call, so the message's recovery instructions stay valid.
   */
  readonly mergeBranch: (
    cwd: string,
    branch: string,
    targetBranchName: string,
  ) => Effect.Effect<void, Error>;
  /** `git branch -D <branch>`. Best-effort — swallows failure. */
  readonly deleteBranch: (
    cwd: string,
    branch: string,
  ) => Effect.Effect<void, never>;
}

export class GitClient extends Context.Tag("GitClient")<
  GitClient,
  GitClientService
>() {}

/**
 * Runs `command` in `cwd`, resolving with stdout and rejecting on non-zero
 * exit — the minimal contract `makeGitClient` needs from any execution
 * channel (local child_process, SSH, a sandbox provider's own `exec`).
 */
export type GitExec = (
  command: string,
  cwd: string,
) => Promise<{ stdout: string }>;

/**
 * Build a `GitClientService` against any `GitExec` channel. See the file
 * header for the failure-semantics contract each method preserves.
 */
export const makeGitClient = (gitExec: GitExec): GitClientService => ({
  currentBranch: (cwd) =>
    Effect.promise(async () => {
      const { stdout } = await gitExec("git rev-parse --abbrev-ref HEAD", cwd);
      return stdout.trim();
    }),

  identity: (cwd) =>
    Effect.promise(async () => {
      const [name, email] = await Promise.all([
        gitExec("git config user.name", cwd)
          .then((r) => r.stdout.trim())
          .catch(() => ""),
        gitExec("git config user.email", cwd)
          .then((r) => r.stdout.trim())
          .catch(() => ""),
      ]);
      return { name, email };
    }),

  revParseHead: (cwd) =>
    Effect.promise(async () => {
      const { stdout } = await gitExec("git rev-parse HEAD", cwd);
      return stdout.trim();
    }),

  hasCommitsInRange: (cwd, range) =>
    Effect.promise(async () => {
      try {
        const { stdout } = await gitExec(
          `git rev-list "${range}" --count`,
          cwd,
        );
        return parseInt(stdout.trim(), 10) > 0;
      } catch {
        return false;
      }
    }),

  revList: (cwd, range) =>
    Effect.promise(async () => {
      try {
        const { stdout } = await gitExec(
          `git rev-list "${range}" --reverse`,
          cwd,
        );
        const lines = stdout.trim();
        return lines ? lines.split("\n") : [];
      } catch {
        return [];
      }
    }),

  mergeBranch: (cwd, branch, targetBranchName) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await gitExec(`git merge "${branch}"`, cwd);
        } catch {
          throw new Error(
            `Merge of '${branch}' onto '${targetBranchName}' failed. ` +
              `The temporary branch '${branch}' has been preserved. ` +
              `To retry: git merge ${branch}, ` +
              `then clean up: git branch -D ${branch}`,
          );
        }
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }),

  deleteBranch: (cwd, branch) =>
    Effect.promise(() =>
      gitExec(`git branch -D "${branch}"`, cwd).catch(() => {}),
    ).pipe(Effect.asVoid),
});

const execAsync = promisify(exec);

/** `makeGitClient` fed the real local `child_process.exec` — the only `GitClient` implementation in use today. */
export const LocalGitClient: Layer.Layer<GitClient> = Layer.succeed(
  GitClient,
  makeGitClient((command, cwd) => execAsync(command, { cwd })),
);

/** SSH connection details for `makeRemoteGitExec` — the `remote` fields of `RepoRef`, minus `kind`/`path` (cwd is passed per-call by `GitExec`, not fixed to the target). */
export type RemoteGitTarget = Omit<
  Extract<RepoRef, { kind: "remote" }>,
  "kind" | "path"
>;

const buildSshArgs = (target: RemoteGitTarget): string[] => {
  const args = ["-o", "BatchMode=yes"];
  if (target.identityFile) {
    args.push("-i", target.identityFile);
  }
  if (target.sshArgs) {
    args.push(...target.sshArgs);
  }
  args.push(target.user ? `${target.user}@${target.host}` : target.host);
  return args;
};

/**
 * Builds a `GitExec` that runs each command over SSH against `target`,
 * rather than locally. `cwd` becomes a remote path, reached via `cd` on the
 * far side. `sshExecAsync` defaults to the real `promisify(exec)` (matching
 * `LocalGitClient`'s own execution style — one assembled command string, no
 * streaming needed for short git output) but is injectable so tests never
 * spawn real `ssh`.
 */
export const makeRemoteGitExec = (
  target: RemoteGitTarget,
  sshExecAsync: (command: string) => Promise<{ stdout: string }> = (command) =>
    execAsync(command),
): GitExec => {
  const sshArgs = buildSshArgs(target);
  return (command, cwd) => {
    const remoteCommand = `cd ${shellQuote(cwd)} && ${command}`;
    const fullCommand = `ssh ${sshArgs.map(shellQuote).join(" ")} ${shellQuote(remoteCommand)}`;
    return sshExecAsync(fullCommand);
  };
};

/** `makeGitClient` fed an SSH-backed `GitExec` against `target` — a `GitClient` for a repo that lives on a remote host. */
export const RemoteGitClient = (
  target: RemoteGitTarget,
): Layer.Layer<GitClient> =>
  Layer.succeed(GitClient, makeGitClient(makeRemoteGitExec(target)));

/**
 * Picks the `GitClient` implementation for a `RepoRef`. `kind: "none"`
 * throws synchronously — there is no repo to run git against, so no current
 * or planned caller should be requesting a `GitClient` for one; a future
 * no-git lifecycle preset simply won't request `GitClient` at all.
 */
export const gitClientLayerFor = (ref: RepoRef): Layer.Layer<GitClient> => {
  switch (ref.kind) {
    case "local":
      return LocalGitClient;
    case "remote":
      return RemoteGitClient({
        host: ref.host,
        user: ref.user,
        identityFile: ref.identityFile,
        sshArgs: ref.sshArgs,
      });
    case "none":
      throw new Error(
        'gitClientLayerFor: RepoRef has kind "none" — there is no repo to build a GitClient for.',
      );
  }
};
