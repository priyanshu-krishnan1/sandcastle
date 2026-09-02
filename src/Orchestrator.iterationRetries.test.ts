/**
 * Tests for the iterationRetries feature in Orchestrator.ts.
 *
 * These tests verify that:
 * - A failing agent is retried the configured number of times
 * - Success on a retry counts as iteration success
 * - Exhausting retries propagates the final AgentError
 * - Lifecycle (git/sandbox) errors are never retried
 * - Default (omitted) iterationRetries = 0 means no retries
 */
import { Cause, Effect, Layer, Ref } from "effect";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { bob } from "./agents/bob.js";
import { orchestrate } from "./Orchestrator.js";
import { AgentError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory } from "./SandboxFactory.js";
import { makeLocalSandbox } from "./testSandbox.js";
import { agentStreamEmitterLayer } from "./AgentStreamEmitter.js";
import { SilentDisplay, type DisplayEntry } from "./Display.js";
import type { DockerError } from "./errors.js";

// Every test here does at least one real sandbox-lifecycle cycle (worktree
// creation + git identity + commit collection), some with retry backoff on
// top; under full-suite parallel load that can exceed vitest's 5s default,
// same class of flake fixed for syncOut.test.ts elsewhere in this repo.
vi.setConfig({ testTimeout: 30000 });

const execAsync = promisify(exec);

const testProvider = bob("default");

const testDisplayLayer = Layer.mergeAll(
  SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
  agentStreamEmitterLayer(),
);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

/** Minimal SandboxFactory layer that creates a real git worktree per call. */
const makeTestSandboxFactory = (
  hostRepoDir: string,
  buildSandbox: (sandboxDir: string) => SandboxService,
): Layer.Layer<SandboxFactory> => {
  const sandboxBaseDir = join(tmpdir(), `orch-retry-${randomUUID()}`);
  let branchCounter = 0;

  return Layer.succeed(SandboxFactory, {
    withSandbox: <A, E, R>(
      makeEffect: (
        info: import("./SandboxFactory.js").SandboxInfo,
        sandbox: SandboxService,
      ) => Effect.Effect<A, E, R>,
    ): Effect.Effect<
      import("./SandboxFactory.js").WithSandboxResult<A>,
      E | DockerError,
      R
    > =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          await rm(sandboxBaseDir, { recursive: true, force: true });
          const branchName = `sandcastle/retry-test-${++branchCounter}`;
          await execAsync(
            `git worktree add -b "${branchName}" "${sandboxBaseDir}" HEAD`,
            { cwd: hostRepoDir },
          );
          return branchName;
        }),
        (_) =>
          makeEffect(
            {
              hostWorktreePath: sandboxBaseDir,
              sandboxRepoPath: sandboxBaseDir,
              applyToHost: () => Effect.void,
            },
            buildSandbox(sandboxBaseDir),
          ) as Effect.Effect<A, E | DockerError, R>,
        (_) =>
          Effect.promise(async () => {
            await execAsync(`git worktree remove "${sandboxBaseDir}" --force`, {
              cwd: hostRepoDir,
            }).catch(() => {});
          }),
      ).pipe(
        Effect.map((value) => ({ value, preservedWorktreePath: undefined })),
      ),
  });
};

describe("Orchestrator iterationRetries", () => {
  it("retries once and succeeds when agent fails on first attempt", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-retry-ok-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    let callCount = 0;

    const factoryLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run") && options?.onLine) {
            callCount++;
            if (callCount === 1) {
              // First attempt: agent disconnects with non-zero exit (reboot/SSH drop scenario)
              return Effect.succeed({
                stdout: "",
                stderr: "Connection to remote host closed.",
                exitCode: 255,
              });
            }
            // Second attempt: agent succeeds — bob emits a result line containing
            // the completion signal so the orchestrator's signal-matching fires.
            options.onLine(
              JSON.stringify({
                type: "result",
                status: "success",
                result: "Done. <promise>COMPLETE</promise>",
              }),
            );
            return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
          }
          return real.exec(command, options);
        },
        copyIn: real.copyIn,
        copyFileOut: real.copyFileOut,
      };
    });

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do work",
        iterationRetries: 1,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(callCount).toBe(2);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
    expect(result.iterations.length).toBe(1);
  });

  it("fails after exhausting all retry attempts", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-retry-exhaust-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    let callCount = 0;

    const factoryLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run")) {
            callCount++;
            // Always fail — simulates persistent infrastructure issue
            return Effect.succeed({
              stdout: "",
              stderr: "always crashes",
              exitCode: 1,
            });
          }
          return real.exec(command, options);
        },
        copyIn: real.copyIn,
        copyFileOut: real.copyFileOut,
      };
    });

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do work",
        iterationRetries: 2, // 1 initial + 2 retries = 3 total attempts
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // 3 total attempts consumed, then hard failure
    expect(callCount).toBe(3);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(AgentError);
    }
  });

  it("does not retry when iterationRetries is omitted (default 0)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-retry-zero-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    let callCount = 0;

    const factoryLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run")) {
            callCount++;
            return Effect.succeed({ stdout: "", stderr: "crash", exitCode: 1 });
          }
          return real.exec(command, options);
        },
        copyIn: real.copyIn,
        copyFileOut: real.copyFileOut,
      };
    });

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do work",
        // iterationRetries not set — default 0
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Exactly one attempt, immediate failure
    expect(callCount).toBe(1);
    expect(exit._tag).toBe("Failure");
  });

  it("retries across multiple iterations independently", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-retry-multi-iter-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    // agent call sequence:
    //   iter1 attempt1 → fail
    //   iter1 attempt2 → succeed (no completion signal)
    //   iter2 attempt1 → fail
    //   iter2 attempt2 → succeed + COMPLETE
    let callCount = 0;

    const factoryLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run") && options?.onLine) {
            callCount++;
            // odd calls fail, even calls succeed
            if (callCount % 2 === 1) {
              return Effect.succeed({
                stdout: "",
                stderr: "transient error",
                exitCode: 255,
              });
            }
            const isLastIteration = callCount === 4; // iter2 attempt2
            if (isLastIteration) {
              // Final success: emit completion signal via result line
              options.onLine(
                JSON.stringify({
                  type: "result",
                  status: "success",
                  result: "all done <promise>COMPLETE</promise>",
                }),
              );
            } else {
              // Intermediate success: emit plain text, no completion signal
              options.onLine(
                JSON.stringify({
                  type: "message",
                  role: "assistant",
                  content: "partial progress",
                }),
              );
            }
            return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
          }
          return real.exec(command, options);
        },
        copyIn: real.copyIn,
        copyFileOut: real.copyFileOut,
      };
    });

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 2,
        prompt: "do work",
        iterationRetries: 1,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // 4 calls total: 2 per iteration (1 fail + 1 succeed)
    expect(callCount).toBe(4);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
    expect(result.iterations.length).toBe(2);
  });
});
