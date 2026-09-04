/**
 * Session storage primitives shared across agent providers.
 *
 * Sandcastle currently ships a single agent provider, Bob (see
 * `src/agents/bob.ts`), which has no filesystem-backed session record —
 * its session model is a remote task-id (`--resume <task-id>`), not a
 * JSONL file Sandcastle can copy/rewrite. `HostSessionLookup` is kept here
 * as the shared shape `AgentSessionStorage.findByIdOnHost` (see
 * `AgentProvider.ts`) is typed against, for whichever provider is the next
 * to implement file-based session capture/resume.
 */

/**
 * Result of locating a session on the host by its unique id, independent of any
 * cwd-derived path encoding.
 */
export interface HostSessionLookup {
  /** Absolute path to the located session file, or `undefined` when no session
   *  with this id exists anywhere under the searched root. */
  readonly path: string | undefined;
  /** The host directory that was scanned — surfaced in not-found errors so the
   *  user knows where Sandcastle looked. */
  readonly searchedRoot: string;
}
