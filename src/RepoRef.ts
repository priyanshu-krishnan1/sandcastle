/**
 * `RepoRef` — where a git repository actually lives, replacing the implicit
 * assumption baked into `hostRepoDir: string` everywhere in this codebase
 * that it's always a path on the local filesystem. Introduced ahead of any
 * caller needing it, as the seam a future remote-git `GitClient` (see
 * `RemoteGitClient` in ./GitClient.js) plugs into — no public option accepts
 * a `RepoRef` yet.
 */

export type RepoRef =
  | { readonly kind: "local"; readonly path: string }
  | {
      readonly kind: "remote";
      readonly host: string;
      readonly path: string;
      readonly user?: string;
      readonly identityFile?: string;
      readonly sshArgs?: readonly string[];
    }
  | { readonly kind: "none" };

/** Wraps a local filesystem path as a `RepoRef` — the shim existing string-based callers pass through unchanged. */
export const toRepoRef = (path: string): RepoRef => ({ kind: "local", path });

/**
 * The filesystem path a `RepoRef` points at — local or remote both have one.
 * Throws for `kind: "none"`: there is no repo, so no caller should be asking
 * this ref for a path to run git commands against.
 */
export const repoRefPath = (ref: RepoRef): string => {
  if (ref.kind === "none") {
    throw new Error(
      'repoRefPath: RepoRef has kind "none" — there is no repo path.',
    );
  }
  return ref.path;
};
