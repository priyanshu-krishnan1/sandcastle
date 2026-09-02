import { Effect, Layer, Ref } from "effect";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DisplayEntry, SilentDisplay } from "./Display.js";
import { GitClient, type GitClientService } from "./GitClient.js";
import {
  noGitLifecycle,
  remoteOnlyLifecycle,
  runLifecycle,
  type LifecycleContext,
} from "./SandcastleLifecycle.js";
import { makeLocalSandbox } from "./testSandbox.js";

const testDisplayLayer = SilentDisplay.layer(
  Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
);

const makeCtx = async (): Promise<LifecycleContext> => {
  const sandboxDir = await mkdtemp(join(tmpdir(), "sandcastle-lifecycle-"));
  return { sandbox: makeLocalSandbox(sandboxDir), sandboxRepoDir: sandboxDir };
};

describe("runLifecycle", () => {
  it("runs work and returns defaults when the lifecycle has no phases at all", async () => {
    const ctx = await makeCtx();

    const outcome = await Effect.runPromise(
      runLifecycle({}, ctx, () => Effect.succeed(42)).pipe(
        Effect.provide(testDisplayLayer),
      ),
    );

    expect(outcome).toEqual({ result: 42, branch: "", commits: [] });
  });
});

describe("noGitLifecycle", () => {
  it("runs beforeWork hooks against the sandbox, then work, with no branch/commits", async () => {
    const ctx = await makeCtx();

    const outcome = await Effect.runPromise(
      runLifecycle(
        noGitLifecycle({ hooks: [{ command: "echo hi > marker.txt" }] }),
        ctx,
        () =>
          Effect.gen(function* () {
            const check = yield* ctx.sandbox.exec("cat marker.txt");
            return check.stdout.trim();
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    expect(outcome).toEqual({ result: "hi", branch: "", commits: [] });
  });

  it("fails the whole run when a hook exits non-zero", async () => {
    const ctx = await makeCtx();

    const result = await Effect.runPromise(
      Effect.either(
        runLifecycle(
          noGitLifecycle({ hooks: [{ command: "exit 1" }] }),
          ctx,
          () => Effect.succeed("unreached"),
        ).pipe(Effect.provide(testDisplayLayer)),
      ),
    );

    expect(result._tag).toBe("Left");
  });

  it("runs work with no hooks when none are configured", async () => {
    const ctx = await makeCtx();

    const outcome = await Effect.runPromise(
      runLifecycle(noGitLifecycle(), ctx, () => Effect.succeed("ok")).pipe(
        Effect.provide(testDisplayLayer),
      ),
    );

    expect(outcome).toEqual({ result: "ok", branch: "", commits: [] });
  });

  it("cancels a running hook when signal fires", async () => {
    const ctx = await makeCtx();
    const ac = new AbortController();

    const promise = Effect.runPromise(
      runLifecycle(
        noGitLifecycle({
          hooks: [{ command: "sleep 60" }],
          signal: ac.signal,
        }),
        ctx,
        () => Effect.succeed("unreached"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    setTimeout(() => ac.abort("cancelled"), 50);
    await expect(promise).rejects.toThrow();
  });
});

describe("remoteOnlyLifecycle", () => {
  const repoRef = {
    kind: "remote" as const,
    host: "fyre-x86",
    path: "/home/agent/repo",
  };

  it("calls revParseHead in setup and revList in teardown against the configured branch range", async () => {
    const ctx = await makeCtx();
    const calls: { method: string; args: unknown[] }[] = [];

    const fakeGitClient: GitClientService = {
      currentBranch: () => Effect.succeed("unused"),
      identity: () => Effect.succeed({ name: "", email: "" }),
      revParseHead: (cwd) => {
        calls.push({ method: "revParseHead", args: [cwd] });
        return Effect.succeed("abc123");
      },
      hasCommitsInRange: () => Effect.succeed(true),
      revList: (cwd, range) => {
        calls.push({ method: "revList", args: [cwd, range] });
        return Effect.succeed(["sha1", "sha2"]);
      },
      mergeBranch: () => Effect.void,
      deleteBranch: () => Effect.void,
    };

    const outcome = await Effect.runPromise(
      runLifecycle(
        remoteOnlyLifecycle({
          repoRef,
          branch: "fix/db2-tests",
          hooks: [{ command: "echo remote hook ran" }],
          gitClientLayer: Layer.succeed(GitClient, fakeGitClient),
        }),
        ctx,
        () => Effect.succeed("work done"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    expect(outcome).toEqual({
      result: "work done",
      branch: "fix/db2-tests",
      commits: [{ sha: "sha1" }, { sha: "sha2" }],
    });
    expect(calls).toEqual([
      { method: "revParseHead", args: ["/home/agent/repo"] },
      {
        method: "revList",
        args: ["/home/agent/repo", "abc123..refs/heads/fix/db2-tests"],
      },
    ]);
  });

  it("defaults gitClientLayer to gitClientLayerFor(repoRef) when not overridden", () => {
    expect(() =>
      remoteOnlyLifecycle({ repoRef, branch: "main" }),
    ).not.toThrow();
  });

  it("cancels a running hook when signal fires", async () => {
    const ctx = await makeCtx();
    const ac = new AbortController();
    const fakeGitClient: GitClientService = {
      currentBranch: () => Effect.succeed("unused"),
      identity: () => Effect.succeed({ name: "", email: "" }),
      revParseHead: () => Effect.succeed("abc123"),
      hasCommitsInRange: () => Effect.succeed(true),
      revList: () => Effect.succeed([]),
      mergeBranch: () => Effect.void,
      deleteBranch: () => Effect.void,
    };

    const promise = Effect.runPromise(
      runLifecycle(
        remoteOnlyLifecycle({
          repoRef,
          branch: "main",
          hooks: [{ command: "sleep 60" }],
          gitClientLayer: Layer.succeed(GitClient, fakeGitClient),
          signal: ac.signal,
        }),
        ctx,
        () => Effect.succeed("unreached"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    setTimeout(() => ac.abort("cancelled"), 50);
    await expect(promise).rejects.toThrow();
  });
});
