import type { AgentProvider } from "./AgentProvider.js";

/**
 * Fail-fast validation that a resumable agent session exists on the host before
 * launching the agent. Throws a descriptive error when the session is missing.
 *
 * Lookup strategy: try the predictable, cwd-encoded location first
 * (`existsOnHost`) — the fast path for any provider/sandbox combination where
 * Sandcastle's own capture step wrote the session there. Fall back to
 * `findByIdOnHost` — a search by the session's globally-unique id — for the
 * case where the agent wrote its session file in place itself (typically a
 * no-sandbox run, where the agent runs directly on the host and Sandcastle
 * never moved anything). The agent's own path encoding is fragile and
 * platform-specific to reconstruct, so searching by id is the only reliable
 * option there.
 *
 * This is a capability fallback, not a sandbox-category branch: it doesn't
 * need to know which sandbox tag is in play, only whether the file turned up
 * at the location Sandcastle expects. That makes it correct by construction
 * for any future sandbox category, rather than needing a new tag check added
 * here every time one is introduced.
 */
export const assertResumeSessionExists = async (params: {
  readonly provider: AgentProvider;
  readonly hostRepoDir: string;
  readonly resumeSession: string;
}): Promise<void> => {
  const { provider, hostRepoDir, resumeSession } = params;

  if (!provider.sessionStorage) {
    throw new Error(`${provider.name} does not support resumeSession`);
  }

  const exists = await provider.sessionStorage.existsOnHost(
    hostRepoDir,
    resumeSession,
  );
  if (exists) return;

  const found = await provider.sessionStorage.findByIdOnHost(resumeSession);
  if (found.path) return;

  const sessionPath = provider.sessionStorage.hostSessionFilePath(
    hostRepoDir,
    resumeSession,
  );
  throw new Error(
    sessionPath
      ? `resumeSession "${resumeSession}" not found: expected session file at ${sessionPath}, and no session with that id was found under ${found.searchedRoot}`
      : `resumeSession "${resumeSession}" not found under ${found.searchedRoot}`,
  );
};
