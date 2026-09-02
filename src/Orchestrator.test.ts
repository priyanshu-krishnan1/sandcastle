import { Cause, Effect, Layer, Ref } from "effect";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { Display, type DisplayEntry, SilentDisplay } from "./Display.js";
import { makeLocalSandbox } from "./testSandbox.js";
import { orchestrate } from "./Orchestrator.js";
import { substitutePromptArgs } from "./PromptArgumentSubstitution.js";
import { bob } from "./AgentProvider.js";
import type { SandboxService } from "./SandboxFactory.js";
import type { DockerError, SandboxError } from "./errors.js";
import { AgentError, AgentIdleTimeoutError } from "./errors.js";
import { SandboxFactory } from "./SandboxFactory.js";
import {
  agentStreamEmitterLayer,
  type AgentStreamEvent,
} from "./AgentStreamEmitter.js";

const noopAgentStreamEmitterLayer = agentStreamEmitterLayer();

// Most tests here do at least one real sandbox-lifecycle cycle (worktree
// creation + git identity + commit collection); under full-suite parallel
// load that can exceed vitest's 5s default — same class of flake fixed for
// syncOut.test.ts and Orchestrator.iterationRetries.test.ts elsewhere in
// this repo.
vi.setConfig({ testTimeout: 30000 });

const execAsync = promisify(exec);

const testProvider = bob("test-model");

const testDisplayLayer = Layer.mergeAll(
  SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
  noopAgentStreamEmitterLayer,
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

const getHead = async (dir: string) => {
  const { stdout } = await execAsync("git rev-parse HEAD", { cwd: dir });
  return stdout.trim();
};

/** Format a mock agent result as bob's stream-json lines. */
const toStreamJson = (output: string, sessionId?: string): string => {
  const lines: string[] = [];
  if (sessionId) {
    lines.push(JSON.stringify({ type: "session_id", sessionId }));
  }
  lines.push(
    JSON.stringify({ type: "message", role: "assistant", content: output }),
  );
  lines.push(
    JSON.stringify({ type: "result", status: "success", result: output }),
  );
  return lines.join("\n");
};

/**
 * Create a mock SandboxFactory that creates a fresh git worktree
 * from hostRepoDir for each withSandbox call, then cleans it up after.
 *
 * Each iteration gets an isolated sandbox: the worktree directory is
 * removed and recreated before each call, and cleaned up after.
 *
 * @param hostRepoDir - The host git repository to create worktrees from
 * @param buildLayer - Given a fresh sandbox dir, return a Sandbox layer
 * @returns The factory layer
 */
const makeTestSandboxFactory = (
  hostRepoDir: string,
  buildSandbox: (sandboxDir: string) => SandboxService,
): { factoryLayer: Layer.Layer<SandboxFactory>; sandboxRepoDir: string } => {
  const sandboxBaseDir = join(tmpdir(), `orch-factory-${randomUUID()}`);
  const sandboxRepoDir = sandboxBaseDir;

  let branchCounter = 0;

  const factoryLayer = Layer.succeed(SandboxFactory, {
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
          const branchName = `sandcastle/test-${++branchCounter}`;
          await execAsync(
            `git worktree add -b "${branchName}" "${sandboxBaseDir}" HEAD`,
            { cwd: hostRepoDir },
          );
          return branchName;
        }),
        (_branchName) =>
          makeEffect(
            {
              hostWorktreePath: sandboxBaseDir,
              sandboxRepoPath: sandboxBaseDir,
              applyToHost: () => Effect.void,
            },
            buildSandbox(sandboxBaseDir),
          ) as Effect.Effect<A, E | DockerError, R>,
        (_branchName) =>
          Effect.promise(async () => {
            try {
              await execAsync(
                `git worktree remove "${sandboxBaseDir}" --force`,
                { cwd: hostRepoDir },
              ).catch(() => {});
            } catch {}
          }),
      ).pipe(
        Effect.map((value) => ({ value, preservedWorktreePath: undefined })),
      ),
  });

  return { factoryLayer, sandboxRepoDir };
};

/**
 * Create a mock sandbox layer that intercepts `claude` commands
 * and runs a mock script instead. All other commands pass through
 * to the filesystem sandbox.
 */
const makeMockAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): SandboxService => {
  const real = makeLocalSandbox(sandboxDir);

  return {
    exec: (command, options) => {
      if (command.includes("bob run")) {
        if (options?.onLine) {
          const onLine = options.onLine;
          return Effect.gen(function* () {
            const cwd = options?.cwd ?? sandboxDir;
            const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
            const streamOutput = toStreamJson(output);
            for (const line of streamOutput.split("\n")) {
              onLine(line);
            }
            return { stdout: streamOutput, stderr: "", exitCode: 0 };
          });
        }
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          return { stdout: output, stderr: "", exitCode: 0 };
        });
      }
      return real.exec(command, options);
    },
    copyIn: real.copyIn,
    copyFileOut: real.copyFileOut,
  };
};

describe("Orchestrator", () => {
  it("runs a single iteration: sync-in, agent, sync-out", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: creates a commit in the sandbox repo
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async (repoDir) => {
          await writeFile(join(repoDir, "agent-output.txt"), "agent was here");
          await execAsync("git add -A", { cwd: repoDir });
          await execAsync('git config user.email "agent@test.com"', {
            cwd: repoDir,
          });
          await execAsync('git config user.name "Agent"', { cwd: repoDir });
          await execAsync('git commit -m "RALPH: agent commit"', {
            cwd: repoDir,
          });
          return "Done with iteration.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBeUndefined();

    // Verify the agent's commit was synced back to host
    const content = await readFile(join(hostDir, "agent-output.txt"), "utf-8");
    expect(content).toBe("agent was here");
  });

  it("stops early on completion signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits completion signal
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("stops early on custom completion signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits a custom completion signal
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. TASK_FINISHED";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
        completionSignal: "TASK_FINISHED",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("TASK_FINISHED");
  });

  it("does not trigger default completion signal when custom one is set", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits the default completion signal but custom one is set
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 2,
        prompt: "do some work",
        completionSignal: "TASK_FINISHED",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Custom signal not in output, so all iterations run
    expect(result.iterations.length).toBe(2);
    expect(result.completionSignal).toBeUndefined();
  });

  it("does not complete from a signal that appears only in non-assertive (reasoning) text", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits a raw stream-json line sequence directly (bypassing
    // toStreamJson's single-string wrapper) so a reasoning-flagged message
    // containing the literal completion signal can be exercised end-to-end
    // through the real bob() parser and Orchestrator.ts's onLine handler.
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              return Effect.sync(() => {
                const lines = [
                  JSON.stringify({
                    type: "message",
                    role: "assistant",
                    isReasoning: true,
                    content:
                      "Once everything passes I'll emit <promise>COMPLETE</promise> to finish up.",
                  }),
                  JSON.stringify({
                    type: "message",
                    role: "assistant",
                    content: "Still working on it.",
                  }),
                  JSON.stringify({
                    type: "result",
                    status: "success",
                    result: "Still working on it.",
                  }),
                ];
                for (const line of lines) onLine(line);
                return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
              });
            }
            return real.exec(command, options);
          },
          copyIn: real.copyIn,
          copyFileOut: real.copyFileOut,
        };
      },
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // The signal only ever appeared inside isReasoning:true content — must
    // never be mistaken for the agent asserting completion.
    expect(result.completionSignal).toBeUndefined();
    expect(result.iterations.length).toBe(1);
  });

  it("stops early when any signal in an array matches", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits the second signal in the array
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. TASK_ABORTED";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
        completionSignal: ["TASK_FINISHED", "TASK_ABORTED"],
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("TASK_ABORTED");
  });

  it("returns the matched signal from an array", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits the first signal in the array
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. TASK_FINISHED";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
        completionSignal: ["TASK_FINISHED", "TASK_ABORTED"],
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("TASK_FINISHED");
  });

  it("runs all iterations when no signal in array matches", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits neither signal
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "Still working.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 2,
        prompt: "do some work",
        completionSignal: ["TASK_FINISHED", "TASK_ABORTED"],
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(2);
    expect(result.completionSignal).toBeUndefined();
  });

  it("runs multiple iterations with re-sync between them", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let iterationCount = 0;

    // Mock agent: creates a commit each iteration, completes on iteration 3
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async (repoDir) => {
          iterationCount++;
          const filename = `iter-${iterationCount}.txt`;
          await writeFile(
            join(repoDir, filename),
            `iteration ${iterationCount}`,
          );
          await execAsync("git add -A", { cwd: repoDir });
          await execAsync('git config user.email "agent@test.com"', {
            cwd: repoDir,
          });
          await execAsync('git config user.name "Agent"', { cwd: repoDir });
          await execAsync(
            `git commit -m "RALPH: iteration ${iterationCount}"`,
            {
              cwd: repoDir,
            },
          );

          if (iterationCount === 3) {
            return "All tasks done. <promise>COMPLETE</promise>";
          }
          return `Finished iteration ${iterationCount}.`;
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(3);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");

    // Verify all 3 iteration files arrived on host
    for (let i = 1; i <= 3; i++) {
      const content = await readFile(join(hostDir, `iter-${i}.txt`), "utf-8");
      expect(content).toBe(`iteration ${i}`);
    }
  });

  it("handles iteration with no agent commits gracefully", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: doesn't make any commits
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "Nothing to do.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 2,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(2);
    expect(result.completionSignal).toBeUndefined();

    // Host should still be at the original commit
    const hostHead = await getHead(hostDir);
    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("each iteration gets an isolated sandbox (no state leaks)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-iso-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let iteration = 0;
    let markerExistedInIter2 = true;

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async (repoDir) => {
          iteration++;
          if (iteration === 1) {
            // Create an untracked marker file — should NOT leak to iteration 2
            await writeFile(join(repoDir, ".sandbox-marker"), "iter1");
            return "Done iter 1";
          }
          // Iteration 2: check if marker leaked from iteration 1
          markerExistedInIter2 = existsSync(join(repoDir, ".sandbox-marker"));
          return "Done iter 2. <promise>COMPLETE</promise>";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 3,

        prompt: "test isolation",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(2);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
    // Untracked file from iteration 1 must not exist in iteration 2's sandbox
    expect(markerExistedInIter2).toBe(false);
  });
});

describe("OrchestrateResult", () => {
  it("captures agent stdout in the result", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return 'Here is my structured output: {"plan": [1, 2, 3]}';
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.stdout).toContain(
      'Here is my structured output: {"plan": [1, 2, 3]}',
    );
  });

  it("accumulates commits across multiple iterations", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let iterationCount = 0;

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async (repoDir) => {
          iterationCount++;
          await writeFile(
            join(repoDir, `file-${iterationCount}.txt`),
            `content ${iterationCount}`,
          );
          await execAsync("git add -A", { cwd: repoDir });
          await execAsync('git config user.email "agent@test.com"', {
            cwd: repoDir,
          });
          await execAsync('git config user.name "Agent"', { cwd: repoDir });
          await execAsync(`git commit -m "commit ${iterationCount}"`, {
            cwd: repoDir,
          });

          if (iterationCount === 3) {
            return "All done. <promise>COMPLETE</promise>";
          }
          return `Iteration ${iterationCount} done.`;
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.commits).toHaveLength(3);
    // Each commit sha should be valid
    for (const commit of result.commits) {
      expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
    }
    // All shas should be unique
    const uniqueShas = new Set(result.commits.map((c) => c.sha));
    expect(uniqueShas.size).toBe(3);
  });

  it("returns empty commits and branch when agent makes no commits", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "Nothing to do.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.commits).toEqual([]);
    expect(result.branch).toBe("main");
  });

  it("returns commit shas and branch after a single iteration", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async (repoDir) => {
          await writeFile(join(repoDir, "new-file.txt"), "new content");
          await execAsync("git add -A", { cwd: repoDir });
          await execAsync('git config user.email "agent@test.com"', {
            cwd: repoDir,
          });
          await execAsync('git config user.name "Agent"', { cwd: repoDir });
          await execAsync('git commit -m "agent commit"', { cwd: repoDir });
          return "Done.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Branch should match the host's current branch
    expect(result.branch).toBe("main");

    // Should have exactly one commit
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);

    // The sha should match what's on the host
    const hostHead = await getHead(hostDir);
    expect(result.commits[0]!.sha).toBe(hostHead);
  });

  it("surfaces commits even when worktree has uncommitted changes", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const sandboxBaseDir = join(tmpdir(), `orch-factory-${randomUUID()}`);
    let branchCounter = 0;

    // Custom factory that detects uncommitted changes and preserves worktree path
    const factoryLayer = Layer.succeed(SandboxFactory, {
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
            const branchName = `sandcastle/test-${++branchCounter}`;
            await execAsync(
              `git worktree add -b "${branchName}" "${sandboxBaseDir}" HEAD`,
              { cwd: hostDir },
            );
            return branchName;
          }),
          (_branchName) =>
            makeEffect(
              {
                hostWorktreePath: sandboxBaseDir,
                sandboxRepoPath: sandboxBaseDir,
                applyToHost: () => Effect.void,
              },
              makeMockAgentLayer(sandboxBaseDir, async (repoDir) => {
                // Make a commit
                await writeFile(
                  join(repoDir, "committed.txt"),
                  "committed content",
                );
                await execAsync("git add -A", { cwd: repoDir });
                await execAsync('git config user.email "agent@test.com"', {
                  cwd: repoDir,
                });
                await execAsync('git config user.name "Agent"', {
                  cwd: repoDir,
                });
                await execAsync('git commit -m "agent commit"', {
                  cwd: repoDir,
                });

                // Leave uncommitted changes
                await writeFile(
                  join(repoDir, "uncommitted.txt"),
                  "uncommitted content",
                );

                return "Done.";
              }),
            ) as Effect.Effect<A, E | DockerError, R>,
          (_branchName) =>
            Effect.promise(async () => {
              try {
                await execAsync(
                  `git worktree remove "${sandboxBaseDir}" --force`,
                  { cwd: hostDir },
                ).catch(() => {});
              } catch {}
            }),
        ).pipe(
          Effect.map((value) => {
            // Check for uncommitted changes before cleanup
            return { value, preservedWorktreePath: sandboxBaseDir };
          }),
        ),
    });

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Should have the preserved worktree path
    expect(result.preservedWorktreePath).toBe(sandboxBaseDir);

    // Commits should still be surfaced
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("Orchestrator agent stream emitter", () => {
  it("emits text and toolCall events with iteration index and timestamps", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stream-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(ref);

    const events: AgentStreamEvent[] = [];
    const emitterLayer = agentStreamEmitterLayer((e) => {
      events.push(e);
    });

    const mockLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run") && options?.onLine) {
            const onLine = options.onLine;
            const lines = [
              JSON.stringify({
                type: "message",
                role: "assistant",
                content: "Working now",
              }),
              JSON.stringify({
                type: "tool_call",
                name: "Bash",
                args: "ls",
              }),
              JSON.stringify({
                type: "result",
                status: "success",
                result: "<promise>COMPLETE</promise>",
              }),
            ];
            for (const line of lines) onLine(line);
            return Effect.succeed({
              stdout: lines.join("\n"),
              stderr: "",
              exitCode: 0,
            });
          }
          return real.exec(command, options);
        },
        copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) =>
          real.copyFileOut(sandboxPath, hostPath),
      };
    });

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(mockLayer.factoryLayer, displayLayer, emitterLayer),
        ),
      ),
    );

    const textEvents = events.filter((e) => e.type === "text");
    const toolCallEvents = events.filter((e) => e.type === "toolCall");

    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents[0]!.message).toContain("Working now");
    expect(textEvents[0]!.iteration).toBe(1);
    expect(textEvents[0]!.timestamp).toBeInstanceOf(Date);

    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toMatchObject({
      type: "toolCall",
      name: "Bash",
      formattedArgs: "ls",
      iteration: 1,
    });
    expect(toolCallEvents[0]!.timestamp).toBeInstanceOf(Date);
  });

  it("swallows errors thrown by the callback", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stream-err-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(ref);

    const emitterLayer = agentStreamEmitterLayer(() => {
      throw new Error("callback intentionally broken");
    });

    const mockLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run") && options?.onLine) {
            const onLine = options.onLine;
            const lines = [
              JSON.stringify({
                type: "assistant",
                message: {
                  content: [{ type: "text", text: "Hello there" }],
                },
              }),
              JSON.stringify({
                type: "result",
                result: "<promise>COMPLETE</promise>",
              }),
            ];
            for (const line of lines) onLine(line);
            return Effect.succeed({
              stdout: lines.join("\n"),
              stderr: "",
              exitCode: 0,
            });
          }
          return real.exec(command, options);
        },
        copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) =>
          real.copyFileOut(sandboxPath, hostPath),
      };
    });

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(mockLayer.factoryLayer, displayLayer, emitterLayer),
        ),
      ),
    );

    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("emits raw events for every line including lines parseStreamLine drops", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stream-raw-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(ref);

    const events: AgentStreamEvent[] = [];
    const emitterLayer = agentStreamEmitterLayer((e) => {
      events.push(e);
    });

    // Lines: one valid stream-JSON line that yields a typed event, one valid
    // stream-JSON line that parseStreamLine deliberately drops (unrecognised
    // tool — not in TOOL_ARG_FIELDS), and one plain non-JSON line. All three
    // must surface as raw events.
    const droppedToolLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "TotallyUnknownTool",
            input: { foo: "bar" },
          },
        ],
      },
    });
    const plainLine = "raw TUI output: rendering panel...";
    const recognisedLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello there" }] },
    });
    const resultLine = JSON.stringify({
      type: "result",
      result: "<promise>COMPLETE</promise>",
    });

    const mockLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run") && options?.onLine) {
            const onLine = options.onLine;
            const lines = [
              droppedToolLine,
              plainLine,
              recognisedLine,
              resultLine,
            ];
            for (const line of lines) onLine(line);
            return Effect.succeed({
              stdout: lines.join("\n"),
              stderr: "",
              exitCode: 0,
            });
          }
          return real.exec(command, options);
        },
        copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) =>
          real.copyFileOut(sandboxPath, hostPath),
      };
    });

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(mockLayer.factoryLayer, displayLayer, emitterLayer),
        ),
      ),
    );

    const rawEvents = events.filter((e) => e.type === "raw");
    const rawLines = rawEvents.map((e) => e.line);

    expect(rawLines).toEqual([
      droppedToolLine,
      plainLine,
      recognisedLine,
      resultLine,
    ]);
    expect(rawEvents[0]!.iteration).toBe(1);
    expect(rawEvents[0]!.timestamp).toBeInstanceOf(Date);
  });
});

describe("Orchestrator error handling", () => {
  it("propagates SandboxError when agent exits with non-zero code", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-err-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Layer where agent invocation returns non-zero exit code
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              return Effect.succeed({
                stdout: "",
                stderr: "Agent crashed",
                exitCode: 1,
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("does not complete from a signal that appears only in raw stdout", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-fallback-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Layer where the agent stream emits only assistant lines the parser does
    // not surface as text, so the signal exists solely in raw stdout. Raw
    // stdout is not a completion source: it carries lines the parser drops,
    // including the agent echoing back the prompt — and the prompt is where
    // the signal is defined. See Orchestrator.completionSignal.test.ts.
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              // Only emit an assistant line, no result line
              const assistantLine = JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "working..." }] },
              });
              onLine(assistantLine);
              return Effect.succeed({
                stdout: "All done. <promise>COMPLETE</promise>",
                stderr: "",
                exitCode: 0,
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 2,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // The signal never reached the parsed stream, so the run is not complete
    // and the orchestrator works through its full iteration budget.
    expect(result.completionSignal).toBeUndefined();
    expect(result.iterations.length).toBe(2);
  }, 30000);

  it("preserves iteration 1 work when agent fails on iteration 2", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-partial-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let callCount = 0;

    // Layer: iteration 1 succeeds with a commit, iteration 2 agent crashes
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              callCount++;
              if (callCount === 1) {
                // Iteration 1: make a commit
                return Effect.gen(function* () {
                  const cwd = options?.cwd ?? dir;
                  yield* Effect.promise(async () => {
                    await writeFile(join(cwd, "iter1.txt"), "iteration 1 data");
                    await execAsync("git add -A", { cwd });
                    await execAsync('git config user.email "agent@test.com"', {
                      cwd,
                    });
                    await execAsync('git config user.name "Agent"', { cwd });
                    await execAsync('git commit -m "RALPH: iteration 1"', {
                      cwd,
                    });
                  });
                  const output = "Finished iteration 1.";
                  const streamOutput = toStreamJson(output);
                  for (const line of streamOutput.split("\n")) {
                    onLine(line);
                  }
                  return { stdout: streamOutput, stderr: "", exitCode: 0 };
                });
              }
              // Iteration 2: agent crashes
              return Effect.succeed({
                stdout: "",
                stderr: "Agent segfault",
                exitCode: 1,
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 3,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Should have failed on iteration 2
    expect(exit._tag).toBe("Failure");

    // But iteration 1's commit should be preserved on host
    const content = await readFile(join(hostDir, "iter1.txt"), "utf-8");
    expect(content).toBe("iteration 1 data");
  });

  it("propagates error when syncIn fails (invalid host repo)", async () => {
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      "/nonexistent/repo",
      (dir) => makeMockAgentLayer(dir, async () => "done"),
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: "/nonexistent/repo",

        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("propagates error when sandbox branch resolution fails", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-nohead-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Layer that sabotages branch resolution in the sandbox
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command === "git rev-parse --abbrev-ref HEAD") {
              return Effect.succeed({
                stdout: "",
                stderr: "fatal: ambiguous argument 'HEAD'",
                exitCode: 128,
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("falls back to tail of stdout when stderr is empty on non-zero exit (no-op parser)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stderr-fallback-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const stdoutContent =
      "Setting up environment...\nLoading model...\nError: API key is invalid\nPlease check your credentials";

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run")) {
            return Effect.succeed({
              stdout: stdoutContent,
              stderr: "",
              exitCode: 1,
            });
          }
          return real.exec(command, options);
        },
        copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) =>
          real.copyFileOut(sandboxPath, hostPath),
      };
    });

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(AgentError);
      if (err instanceof AgentError) {
        expect(err.message).toContain("bob exited with code 1:");
        expect(err.message).toContain("API key is invalid");
      }
    }
  });

  it("falls back to resultText when stderr is empty on non-zero exit (structured parser)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-resulttext-fallback-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // A "result" event with explicit result text populates resultText even
    // though the mock reports a non-zero exit (bob's own stream doesn't
    // encode failure via a "success" status the way this scenario implies —
    // this is exercising the orchestrator's resultText fallback specifically).
    const errorLine = JSON.stringify({
      type: "result",
      status: "success",
      result: "Rate limit exceeded, please retry later",
    });

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run") && options?.onLine) {
            options.onLine(errorLine);
            return Effect.succeed({
              stdout: errorLine,
              stderr: "",
              exitCode: 1,
            });
          }
          return real.exec(command, options);
        },
        copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) =>
          real.copyFileOut(sandboxPath, hostPath),
      };
    });

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(AgentError);
      if (err instanceof AgentError) {
        expect(err.message).toContain("bob exited with code 1:");
        expect(err.message).toContain(
          "Rate limit exceeded, please retry later",
        );
      }
    }
  });

  it("preserves stderr in error when stderr is non-empty", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stderr-present-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run")) {
            return Effect.succeed({
              stdout: "some stdout output",
              stderr: "fatal error from stderr",
              exitCode: 1,
            });
          }
          return real.exec(command, options);
        },
        copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) =>
          real.copyFileOut(sandboxPath, hostPath),
      };
    });

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(AgentError);
      if (err instanceof AgentError) {
        expect(err.message).toContain("fatal error from stderr");
        // Should NOT fall back to stdout when stderr is present
        expect(err.message).not.toContain("some stdout output");
      }
    }
  });
});

describe("Orchestrator streaming", () => {
  it("invokes bob with stream-json format", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stream-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              capturedCommand = command;
              const output = "Test output";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(capturedCommand).toContain("bob run --format stream-json");
  });

  it("extracts completion signal from stream-json result line", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent that emits completion via stream-json result type
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("uses the model/mode baked into the provider", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-defmodel-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              capturedCommand = command;
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    await Effect.runPromise(
      orchestrate({
        provider: bob("baked-in-mode"),
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(capturedCommand).toContain(`--mode 'baked-in-mode'`);
  });

  it("uses the model from a custom provider", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-custmodel-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              capturedCommand = command;
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    await Effect.runPromise(
      orchestrate({
        provider: bob("custom-mode"),
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(capturedCommand).toContain("--mode 'custom-mode'");
    expect(capturedCommand).not.toContain("baked-in-mode");
  });
});

describe("Orchestrator prompt preprocessing", () => {
  it("preprocesses !`command` expressions in the prompt before invoking agent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-preproc-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedStdin = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              // Capture the prompt delivered via stdin
              capturedStdin = options?.stdin ?? "";
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    // In production the prompt is always run through substitutePromptArgs
    // before reaching orchestrate (which marks template shell blocks).
    const marked = await Effect.runPromise(
      substitutePromptArgs(
        "Context: !`echo hello-from-sandbox`\n\nDo the work.",
        {},
      ).pipe(Effect.provide(testDisplayLayer)),
    );
    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: marked,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // The prompt should have !`echo hello-from-sandbox` replaced with "hello-from-sandbox"
    expect(capturedStdin).toContain("hello-from-sandbox");
    expect(capturedStdin).not.toContain("!`echo");
  });

  it("passes prompt through unchanged when no !`command` expressions", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-nopreproc-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedStdin = "";

    // Intercept to capture prompt delivered via stdin
    const { factoryLayer: fl2, sandboxRepoDir: sr2 } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              capturedStdin = options?.stdin ?? "";
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "Just a plain prompt with no commands.",
      }).pipe(Effect.provide(Layer.merge(fl2, testDisplayLayer))),
    );

    expect(capturedStdin).toContain("Just a plain prompt with no commands.");
  });

  it("passes prompt through literally when skipPromptExpansion is true", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-skipexp-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedStdin = "";

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run") && options?.onLine) {
            const onLine = options.onLine;
            capturedStdin = options?.stdin ?? "";
            const output = "Done.";
            const streamOutput = toStreamJson(output);
            for (const line of streamOutput.split("\n")) {
              onLine(line);
            }
            return Effect.succeed({
              stdout: streamOutput,
              stderr: "",
              exitCode: 0,
            });
          }
          return real.exec(command, options);
        },
        copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) =>
          real.copyFileOut(sandboxPath, hostPath),
      };
    });

    const literalPrompt =
      "Context: !`echo hello-from-sandbox`\n\n{{ISSUE_NUMBER}} should pass through.";

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: literalPrompt,
        skipPromptExpansion: true,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Both the shell expression and the {{KEY}} placeholder are delivered verbatim.
    expect(capturedStdin).toContain("!`echo hello-from-sandbox`");
    expect(capturedStdin).toContain("{{ISSUE_NUMBER}}");
    expect(capturedStdin).not.toContain("hello-from-sandbox\n");
  });
});

describe("Orchestrator Display integration", () => {
  it("emits iteration header, spinner, and completion status", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-display-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, displayLayer))),
    );

    const entries = await Effect.runPromise(Ref.get(ref));

    // Iteration header
    const statusEntries = entries.filter((e) => e._tag === "status");
    expect(statusEntries.some((e) => e.message.includes("Iteration 1/5"))).toBe(
      true,
    );

    // Task log for sandbox setup
    const taskLogEntries = entries.filter((e) => e._tag === "taskLog");
    expect(
      taskLogEntries.some((e) => e.title.includes("Setting up sandbox")),
    ).toBe(true);

    // No spinner for sync-out when agent produces no commits
    const spinnerEntries = entries.filter((e) => e._tag === "spinner");
    expect(
      spinnerEntries.some((e) =>
        e.message.includes("Syncing commits back to host"),
      ),
    ).toBe(false);

    // No usage summary emitted
    const summaryEntries = entries.filter((e) => e._tag === "summary");
    expect(summaryEntries).toHaveLength(0);

    // Completion status
    expect(
      statusEntries.some(
        (e) =>
          e.message.includes("completion") || e.message.includes("complete"),
      ),
    ).toBe(true);
  });

  it("labels iteration header and max-reached message with 'max'", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-maxlabel-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          // Never signals completion
          return "Nothing to do.";
        }),
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 2,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, displayLayer))),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const statusEntries = entries.filter((e) => e._tag === "status");

    // Iteration header should NOT include "(max)" — the summary already communicates the max
    expect(statusEntries.some((e) => e.message.includes("Iteration 1/2"))).toBe(
      true,
    );
    expect(statusEntries.every((e) => !e.message.includes("(max)"))).toBe(true);

    // Completion message when max is reached should say "max iterations"
    expect(
      statusEntries.some((e) => e.message.includes("max iterations")),
    ).toBe(true);
  });

  it("uses 10 minutes as the default idle timeout", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-timeout-default-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => makeMockAgentLayer(dir, async () => "done"),
    );

    // Verify indirectly: a run that completes quickly should not time out.
    // The default idle timeout is 600s (10 minutes) — far longer than any mock agent delay.
    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        // No idleTimeoutSeconds — should default to 10 minutes (600s)
      }).pipe(
        Effect.provide(Layer.merge(factoryLayer, testDisplayLayer)),
        Effect.exit,
      ),
    );

    // The run completes successfully — default idle timeout is large enough
    expect(exitResult._tag).toBe("Success");
  }, 10_000);

  it("prefixes status messages with [name] when name is provided", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-name-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
        name: "issue-42",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, displayLayer))),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const statusEntries = entries.filter((e) => e._tag === "status");

    // All status messages should be prefixed with [issue-42]
    expect(statusEntries.every((e) => e.message.startsWith("[issue-42]"))).toBe(
      true,
    );
    // Iteration message should still be readable
    expect(statusEntries.some((e) => e.message.includes("Iteration 1/1"))).toBe(
      true,
    );
  });

  it("does not prefix status messages when no name is provided", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-noname-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, displayLayer))),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const statusEntries = entries.filter((e) => e._tag === "status");

    // No status messages should be prefixed with brackets
    expect(statusEntries.every((e) => !e.message.startsWith("["))).toBe(true);
  });

  it("fails with AgentIdleTimeoutError when idleTimeoutSeconds is exceeded with no output", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-timeout-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: takes 2 seconds to respond and produces no output during that time
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return "done";
        }),
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        idleTimeoutSeconds: 0.1, // 100ms — well below the 2s agent delay with no output
      }).pipe(
        Effect.provide(Layer.merge(factoryLayer, testDisplayLayer)),
        Effect.exit,
      ),
    );

    expect(exitResult._tag).toBe("Failure");
    if (exitResult._tag === "Failure") {
      const err = Cause.squash(exitResult.cause);
      expect(err).toBeInstanceOf(AgentIdleTimeoutError);
      if (err instanceof AgentIdleTimeoutError) {
        expect(err.timeoutMs).toBe(100);
        expect(err.message).toContain("idle");
        expect(err.message).toContain("--idle-timeout");
      }
    }
  }, 10_000);

  it("resets the idle timer on each text/tool_call output", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-idle-reset-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits text after 100ms, then completes after another 100ms.
    // With idleTimeoutSeconds=0.15 (150ms), the timer fires at t=150ms without reset.
    // But the text event at t=100ms should reset the timer to t=250ms, allowing
    // the run to complete at t=200ms before the reset timer fires.
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              return Effect.gen(function* () {
                // Wait 100ms then emit a text event (resets idle timer)
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 100)),
                );
                onLine(
                  JSON.stringify({
                    type: "assistant",
                    message: {
                      content: [{ type: "text", text: "working..." }],
                    },
                  }),
                );
                // Wait another 100ms then emit the result
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 100)),
                );
                onLine(JSON.stringify({ type: "result", result: "done" }));
                return { stdout: "", stderr: "", exitCode: 0 };
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        idleTimeoutSeconds: 0.15, // 150ms — timer resets on text at t=100ms
      }).pipe(
        Effect.provide(Layer.merge(factoryLayer, testDisplayLayer)),
        Effect.exit,
      ),
    );

    // Should succeed because the text event at t=100ms resets the idle timer
    expect(exitResult._tag).toBe("Success");
  }, 10_000);

  it("resets the idle timer on unparsed stdout lines (no structured events)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-idle-raw-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits raw (non-JSON) stdout lines that don't parse into any
    // structured event, then completes. With idleTimeoutSeconds=0.15 (150ms),
    // the timer would fire at t=150ms if only parsed events reset it.
    // The raw line at t=100ms should reset the timer to t=250ms, allowing
    // the run to complete at t=200ms.
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              return Effect.gen(function* () {
                // Wait 100ms then emit a raw, unparsable line (should still reset idle timer)
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 100)),
                );
                onLine("raw TUI output: rendering panel...");
                // Wait another 100ms then emit the result so the run completes
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 100)),
                );
                onLine(JSON.stringify({ type: "result", result: "done" }));
                return { stdout: "", stderr: "", exitCode: 0 };
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        idleTimeoutSeconds: 0.15, // 150ms — should be reset by raw stdout at t=100ms
      }).pipe(
        Effect.provide(Layer.merge(factoryLayer, testDisplayLayer)),
        Effect.exit,
      ),
    );

    // Should succeed because the raw stdout line at t=100ms resets the idle timer
    expect(exitResult._tag).toBe("Success");
  }, 10_000);

  it("logs periodic idle warnings every IDLE_WARNING_INTERVAL_MS of inactivity", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-idle-warn-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Agent stays idle for 250ms with _idleWarningIntervalMs=100ms,
    // so ~2 warnings should fire before the agent completes.
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              return Effect.gen(function* () {
                // Stay idle for 250ms — enough for ~2 warnings at 100ms interval
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 250)),
                );
                onLine(JSON.stringify({ type: "result", result: "done" }));
                return { stdout: "", stderr: "", exitCode: 0 };
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    const displayEntries = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(displayEntries),
      noopAgentStreamEmitterLayer,
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        idleTimeoutSeconds: 10, // high enough not to kill
        _idleWarningIntervalMs: 100, // fire warnings every 100ms for testing
      }).pipe(
        Effect.provide(Layer.merge(factoryLayer, displayLayer)),
        Effect.exit,
      ),
    );

    expect(exitResult._tag).toBe("Success");

    const allEntries = await Effect.runPromise(Ref.get(displayEntries));
    const warningEntries = allEntries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    );

    // Should have at least 2 warning entries (at ~100ms and ~200ms)
    expect(warningEntries.length).toBeGreaterThanOrEqual(2);
    // First warning should say "1 minute" (even though the interval is 100ms in test)
    expect((warningEntries[0] as { message: string }).message).toContain(
      "Agent idle for 1 minute",
    );
    expect((warningEntries[1] as { message: string }).message).toContain(
      "Agent idle for 2 minutes",
    );
  }, 10_000);

  it("resets idle warning counter when agent produces output", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-idle-warn-reset-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: idle 150ms, emit text (resets counter), idle 150ms, complete.
    // With 100ms warning interval, we should see warning at ~100ms (1 minute),
    // then text at ~150ms resets counter, then warning at ~250ms (1 minute again, not 2).
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const real = makeLocalSandbox(dir);
        return {
          exec: (command, options) => {
            if (command.includes("bob run") && options?.onLine) {
              const onLine = options.onLine;
              return Effect.gen(function* () {
                // Idle for 150ms — warning fires at ~100ms
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 150)),
                );
                // Emit text — should reset the warning counter
                onLine(
                  JSON.stringify({
                    type: "assistant",
                    message: {
                      content: [{ type: "text", text: "working..." }],
                    },
                  }),
                );
                // Idle for another 150ms — warning fires at ~100ms after reset
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 150)),
                );
                onLine(JSON.stringify({ type: "result", result: "done" }));
                return { stdout: "", stderr: "", exitCode: 0 };
              });
            }
            return real.exec(command, options);
          },
          copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
          copyFileOut: (sandboxPath, hostPath) =>
            real.copyFileOut(sandboxPath, hostPath),
        };
      },
    );

    const displayEntries = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(displayEntries),
      noopAgentStreamEmitterLayer,
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        idleTimeoutSeconds: 10,
        _idleWarningIntervalMs: 100,
      }).pipe(
        Effect.provide(Layer.merge(factoryLayer, displayLayer)),
        Effect.exit,
      ),
    );

    expect(exitResult._tag).toBe("Success");

    const allEntries = await Effect.runPromise(Ref.get(displayEntries));
    const warningEntries = allEntries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    );

    // Should have at least 2 warnings (one before text, one after text reset)
    expect(warningEntries.length).toBeGreaterThanOrEqual(2);
    // Both should say "1 minute" because the counter was reset by the text event
    expect((warningEntries[0] as { message: string }).message).toContain(
      "Agent idle for 1 minute",
    );
    expect((warningEntries[1] as { message: string }).message).toContain(
      "Agent idle for 1 minute",
    );
  }, 10_000);
});

describe("Orchestrator signal (AbortSignal)", () => {
  it("rejects with pre-aborted signal before running any iteration", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let agentCalled = false;
    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        agentCalled = true;
        return "Done.";
      }),
    );

    const ac = new AbortController();
    ac.abort("pre-aborted");

    await expect(
      Effect.runPromise(
        orchestrate({
          provider: testProvider,
          hostRepoDir: hostDir,
          iterations: 1,
          prompt: "do some work",
          signal: ac.signal,
        }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
      ),
    ).rejects.toThrow("pre-aborted");

    expect(agentCalled).toBe(false);
  });

  it("aborts mid-iteration and rejects", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ac = new AbortController();

    // Mock agent that takes a while — abort fires while it's running
    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        // Simulate slow agent: abort mid-flight
        ac.abort("cancelled mid-iteration");
        // Give the abort a tick to propagate
        await new Promise((r) => setTimeout(r, 10));
        return "Done.";
      }),
    );

    await expect(
      Effect.runPromise(
        orchestrate({
          provider: testProvider,
          hostRepoDir: hostDir,
          iterations: 1,
          prompt: "do some work",
          signal: ac.signal,
        }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
      ),
    ).rejects.toThrow("cancelled mid-iteration");
  });

  it("aborts between iterations and does not start the next one", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ac = new AbortController();
    let iterationCount = 0;

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        iterationCount++;
        if (iterationCount === 1) {
          // After first iteration completes, abort before second starts
          ac.abort("cancelled between iterations");
        }
        return `Iteration ${iterationCount} done.`;
      }),
    );

    await expect(
      Effect.runPromise(
        orchestrate({
          provider: testProvider,
          hostRepoDir: hostDir,
          iterations: 5,
          prompt: "do some work",
          signal: ac.signal,
        }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
      ),
    ).rejects.toThrow("cancelled between iterations");

    expect(iterationCount).toBe(1);
  });

  it("abort after completion is a no-op", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ac = new AbortController();

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        return "All done. <promise>COMPLETE</promise>";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
        signal: ac.signal,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Abort after completion — should not throw or affect result
    ac.abort("too late");

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("works normally when no signal is provided", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        return "Done. <promise>COMPLETE</promise>";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
        // no signal
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });
});

describe("Orchestrator completion timeout (hanging process)", () => {
  /**
   * Build a mock sandbox layer where the `claude` exec emits the given lines
   * via `onLine` and then *never resolves*. Used to simulate a hanging child
   * process keeping stdout open after the agent's logical turn ends.
   */
  const makeHangingClaudeAgentLayer = (
    sandboxDir: string,
    lines: string[],
  ): SandboxService => {
    const real = makeLocalSandbox(sandboxDir);
    return {
      exec: (command, options) => {
        if (command.includes("bob run") && options?.onLine) {
          const onLine = options.onLine;
          return Effect.gen(function* () {
            for (const line of lines) {
              onLine(line);
            }
            // Never resolve — simulate a hanging child holding stdout open.
            yield* Effect.never;
            return { stdout: "", stderr: "", exitCode: 0 };
          });
        }
        return real.exec(command, options);
      },
      copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
      copyFileOut: (sandboxPath, hostPath) =>
        real.copyFileOut(sandboxPath, hostPath),
    };
  };

  it("succeeds with completionSignal set when the agent hangs after emitting the signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-comp-hang-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "All done. <promise>COMPLETE</promise>",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        result: "All done. <promise>COMPLETE</promise>",
      }),
    ];

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeHangingClaudeAgentLayer(dir, lines),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
        completionTimeoutSeconds: 0.2, // 200ms grace window for the test
        idleTimeoutSeconds: 30, // way larger than the test runtime
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
    expect(result.iterations.length).toBe(1);
  }, 10_000);

  it("falls through to the idle timeout when the agent hangs WITHOUT emitting the signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-comp-noidle-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "still thinking..." }],
        },
      }),
    ];

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeHangingClaudeAgentLayer(dir, lines),
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
        idleTimeoutSeconds: 0.15, // 150ms — fires because no signal was seen
        completionTimeoutSeconds: 0.05, // would-be grace window, must not apply
      }).pipe(
        Effect.provide(Layer.merge(factoryLayer, testDisplayLayer)),
        Effect.exit,
      ),
    );

    expect(exitResult._tag).toBe("Failure");
    if (exitResult._tag === "Failure") {
      const err = Cause.squash(exitResult.cause);
      expect(err).toBeInstanceOf(AgentIdleTimeoutError);
    }
  }, 10_000);

  it("resets the completion timer on trailing output and includes it in stdout", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-comp-trailing-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // After the signal: emit a trailing usage/result line ~120ms later. With a
    // 200ms grace window the trailing line MUST land before the timer fires
    // and MUST reset it, so the run succeeds and the trailing text is in stdout.
    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) => {
      const real = makeLocalSandbox(dir);
      return {
        exec: (command, options) => {
          if (command.includes("bob run") && options?.onLine) {
            const onLine = options.onLine;
            return Effect.gen(function* () {
              onLine(
                JSON.stringify({
                  type: "assistant",
                  message: {
                    content: [
                      {
                        type: "text",
                        text: "Plan ready. <promise>COMPLETE</promise>",
                      },
                    ],
                  },
                }),
              );
              yield* Effect.promise(
                () => new Promise((resolve) => setTimeout(resolve, 120)),
              );
              onLine(
                JSON.stringify({
                  type: "result",
                  result:
                    "Plan ready. <promise>COMPLETE</promise>\nTRAILING_TOKEN",
                }),
              );
              // Hang forever after trailing output.
              yield* Effect.never;
              return { stdout: "", stderr: "", exitCode: 0 };
            });
          }
          return real.exec(command, options);
        },
        copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
        copyFileOut: (sandboxPath, hostPath) =>
          real.copyFileOut(sandboxPath, hostPath),
      };
    });

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
        completionTimeoutSeconds: 0.2,
        idleTimeoutSeconds: 30,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
    expect(result.stdout).toContain("TRAILING_TOKEN");
  }, 10_000);

  it("adds no latency when the agent exits cleanly after the signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-comp-fast-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(
        dir,
        async () => "All done. <promise>COMPLETE</promise>",
      ),
    );

    const start = Date.now();
    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
        // Large completion timeout — clean exit must NOT wait for it.
        completionTimeoutSeconds: 30,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );
    const elapsedMs = Date.now() - start;

    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
    // Clean exit beats the grace window — no waiting added.
    expect(elapsedMs).toBeLessThan(2_000);
  }, 10_000);

  it("emits a warning when the completion timeout fires", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-comp-warn-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Final answer <promise>COMPLETE</promise>",
            },
          ],
        },
      }),
    ];

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeHangingClaudeAgentLayer(dir, lines),
    );

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
        completionTimeoutSeconds: 0.1,
        idleTimeoutSeconds: 30,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, displayLayer))),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const warnEntries = entries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    ) as { _tag: "status"; message: string; severity: "warn" }[];
    expect(
      warnEntries.some((e) => /hang|completion timeout/i.test(e.message)),
    ).toBe(true);
  }, 10_000);
});
