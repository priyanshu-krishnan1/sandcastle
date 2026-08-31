/**
 * Tests for how the orchestrator decides an iteration signalled completion.
 *
 * The signal is matched against the *parsed* agent stream inside
 * `invokeAgent`, never against the returned output string. Two failures
 * motivated that:
 *
 *  - False positive: the returned output falls back to raw stdout, which
 *    contains the agent echoing back the prompt it was given. The prompt is
 *    where the completion signal is defined, so re-scanning that string
 *    reported a completion the agent never made. Raw stdout is also a bounded
 *    64KiB tail, so whether the echo survived depended on run length — the
 *    same prompt completed on a short run and looped on a long one.
 *
 *  - False negative: when the provider emits a terminal `result` event with
 *    text, that short string won over the full transcript, so a signal emitted
 *    in an earlier assistant message was dropped and the run kept iterating.
 */
import { Effect, Layer, Ref } from "effect";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { bob } from "./AgentProvider.js";
import { orchestrate } from "./Orchestrator.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory } from "./SandboxFactory.js";
import { makeLocalSandbox } from "./testSandbox.js";
import { agentStreamEmitterLayer } from "./AgentStreamEmitter.js";
import { SilentDisplay, type DisplayEntry } from "./Display.js";
import type { DockerError } from "./errors.js";

const execAsync = promisify(exec);

const SIGNAL = "<promise>COMPLETE</promise>";

const testDisplayLayer = Layer.mergeAll(
  SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
  agentStreamEmitterLayer(),
);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  await writeFile(join(dir, "hello.txt"), "hello");
  await execAsync("git add hello.txt", { cwd: dir });
  await execAsync("git commit -m initial", { cwd: dir });
};

const makeTestSandboxFactory = (
  hostRepoDir: string,
  buildSandbox: (sandboxDir: string) => SandboxService,
): Layer.Layer<SandboxFactory> => {
  const sandboxBaseDir = join(tmpdir(), `orch-signal-${randomUUID()}`);
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
          const branchName = `sandcastle/signal-test-${++branchCounter}`;
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

/**
 * Sandbox whose agent invocation replays `lines` through `onLine` and then
 * resolves with the supplied raw `stdout` — the two are independent, exactly
 * as they are for a real provider whose parser drops some stdout lines.
 */
const makeAgentSandbox = (
  dir: string,
  lines: string[],
  stdout: string,
  onRun?: () => void,
): SandboxService => {
  const real = makeLocalSandbox(dir);
  return {
    exec: (command, options) => {
      if (command.includes("bob run") && options?.onLine) {
        onRun?.();
        for (const line of lines) options.onLine(line);
        return Effect.succeed({ stdout, stderr: "", exitCode: 0 });
      }
      return real.exec(command, options);
    },
    copyIn: real.copyIn,
    copyFileOut: real.copyFileOut,
  };
};

describe("Orchestrator completion signal", () => {
  it("does not treat the agent's echo of the prompt as a completion signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-echo-"));
    await initRepo(hostDir);

    const prompt = `Reset the machine, then verify.\n\n${SIGNAL}`;
    // The agent finishes without ever emitting the signal — it only says so in
    // prose. Raw stdout still carries bob's echo of the prompt, which does
    // contain the signal.
    const assistant = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "## Reset — COMPLETE. All checks pass.",
    });
    const promptEcho = JSON.stringify({
      type: "message",
      role: "user",
      content: prompt,
    });

    let runs = 0;
    const factoryLayer = makeTestSandboxFactory(hostDir, (dir) =>
      makeAgentSandbox(
        dir,
        [promptEcho, assistant],
        `${promptEcho}\n${assistant}\n`,
        () => {
          runs++;
        },
      ),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: bob("default"),
        hostRepoDir: hostDir,
        iterations: 2,
        prompt,
        skipPromptExpansion: true,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.completionSignal).toBeUndefined();
    expect(runs).toBe(2);

    await rm(hostDir, { recursive: true, force: true });
  }, 60000);

  it("completes when the signal is in a streamed message a later result event does not repeat", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-event-"));
    await initRepo(hostDir);

    // The signal arrives in an assistant message; bob's terminal result event
    // carries only a short summary that does not repeat it.
    const lines = [
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: `All checks pass.\n${SIGNAL}`,
      }),
      JSON.stringify({
        type: "result",
        status: "success",
        result: "Task finished successfully.",
      }),
    ];

    let runs = 0;
    const factoryLayer = makeTestSandboxFactory(hostDir, (dir) =>
      makeAgentSandbox(dir, lines, "", () => {
        runs++;
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: bob("default"),
        hostRepoDir: hostDir,
        iterations: 3,
        prompt: "do the thing",
        skipPromptExpansion: true,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.completionSignal).toBe(SIGNAL);
    expect(runs).toBe(1);

    await rm(hostDir, { recursive: true, force: true });
  }, 60000);
});
