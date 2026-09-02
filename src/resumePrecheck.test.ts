import { describe, expect, it, vi } from "vitest";
import { bob } from "./AgentProvider.js";
import type { AgentProvider, AgentSessionStorage } from "./AgentProvider.js";
import { assertResumeSessionExists } from "./resumePrecheck.js";

const SESSION_ID = "9ba1c695-2222-4444-8888-e7e847bf34dd";
const HOST_REPO_DIR = "/some/host/repo";

const makeProvider = (sessionStorage: AgentSessionStorage): AgentProvider => ({
  name: "test-provider",
  env: {},
  captureSessions: true,
  sessionStorage,
  buildPrintCommand: () => ({ command: "" }),
  parseStreamLine: () => [],
});

const makeSessionStorage = (
  overrides: Partial<AgentSessionStorage> = {},
): AgentSessionStorage => ({
  captureToHost: vi.fn(async () => {}),
  resumeIntoSandbox: vi.fn(async () => {}),
  readHostSession: vi.fn(async () => undefined),
  existsOnHost: vi.fn(async () => false),
  hostSessionFilePath: vi.fn(
    () => `${HOST_REPO_DIR}/.sessions/${SESSION_ID}.jsonl`,
  ),
  findByIdOnHost: vi.fn(async () => ({
    path: undefined,
    searchedRoot: "/home/.agent/sessions",
  })),
  ...overrides,
});

describe("assertResumeSessionExists", () => {
  it("throws when the provider does not support resume (no sessionStorage)", async () => {
    await expect(
      assertResumeSessionExists({
        provider: bob("default"),
        hostRepoDir: HOST_REPO_DIR,
        resumeSession: SESSION_ID,
      }),
    ).rejects.toThrow("bob does not support resumeSession");
  });

  it("resolves via the predictable path (existsOnHost) without searching by id", async () => {
    const existsOnHost = vi.fn(async () => true);
    const findByIdOnHost = vi.fn(async () => ({
      path: undefined,
      searchedRoot: "/home/.agent/sessions",
    }));
    const provider = makeProvider(
      makeSessionStorage({ existsOnHost, findByIdOnHost }),
    );

    await expect(
      assertResumeSessionExists({
        provider,
        hostRepoDir: HOST_REPO_DIR,
        resumeSession: SESSION_ID,
      }),
    ).resolves.toBeUndefined();

    expect(existsOnHost).toHaveBeenCalledWith(HOST_REPO_DIR, SESSION_ID);
    // The fast path succeeded — no need to fall back to a search.
    expect(findByIdOnHost).not.toHaveBeenCalled();
  });

  it("falls back to findByIdOnHost when the predictable path doesn't have it", async () => {
    const existsOnHost = vi.fn(async () => false);
    const findByIdOnHost = vi.fn(async () => ({
      path: "/home/.agent/sessions/9ba1c695.jsonl",
      searchedRoot: "/home/.agent/sessions",
    }));
    const provider = makeProvider(
      makeSessionStorage({ existsOnHost, findByIdOnHost }),
    );

    await expect(
      assertResumeSessionExists({
        provider,
        hostRepoDir: HOST_REPO_DIR,
        resumeSession: SESSION_ID,
      }),
    ).resolves.toBeUndefined();

    expect(existsOnHost).toHaveBeenCalledWith(HOST_REPO_DIR, SESSION_ID);
    expect(findByIdOnHost).toHaveBeenCalledWith(SESSION_ID);
  });

  it("throws a combined not-found error when neither lookup finds the session", async () => {
    const provider = makeProvider(makeSessionStorage());

    await expect(
      assertResumeSessionExists({
        provider,
        hostRepoDir: HOST_REPO_DIR,
        resumeSession: SESSION_ID,
      }),
    ).rejects.toThrow(
      `resumeSession "${SESSION_ID}" not found: expected session file at ${HOST_REPO_DIR}/.sessions/${SESSION_ID}.jsonl, and no session with that id was found under /home/.agent/sessions`,
    );
  });

  it("throws a search-only not-found error when hostSessionFilePath is undefined", async () => {
    const provider = makeProvider(
      makeSessionStorage({ hostSessionFilePath: () => undefined }),
    );

    await expect(
      assertResumeSessionExists({
        provider,
        hostRepoDir: HOST_REPO_DIR,
        resumeSession: SESSION_ID,
      }),
    ).rejects.toThrow(
      `resumeSession "${SESSION_ID}" not found under /home/.agent/sessions`,
    );
  });
});
