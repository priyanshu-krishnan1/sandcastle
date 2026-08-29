import { exec } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { bob } from "./AgentProvider.js";
import { createSandbox, type CreateSandboxOptions } from "./createSandbox.js";
import type { SandboxService } from "./SandboxFactory.js";
import {
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
} from "./SandboxProvider.js";
import { testIsolated } from "./sandboxes/test-isolated.js";
import { makeLocalSandbox } from "./testSandbox.js";

/** Dummy sandbox provider used to satisfy the required `sandbox` field in test mode. */
const testSandbox = createBindMountSandboxProvider({
  name: "test",
  create: async () => ({
    worktreePath: "/home/agent/workspace",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    copyFileIn: async () => {},
    copyFileOut: async () => {},
    close: async () => {},
  }),
});

const execAsync = promisify(exec);

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

/** Format a mock agent result as bob's stream-json lines. */
const toStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({ type: "message", role: "assistant", content: output }),
  );
  lines.push(JSON.stringify({ type: "result", status: "success", result: output }));
  return lines.join("\n");
};

const testProvider = bob("test-model");

/**
 * Known agent command substrings and their stream formatters. bob's actual
 * command is a long install-check preamble ending in `bob run --format
 * stream-json`, so matching uses `.includes()`, not `.startsWith()`.
 */
const AGENT_PREFIXES: { prefix: string; toStream: (o: string) => string }[] = [
  { prefix: "bob run", toStream: toStreamJson },
];

/**
 * Create a mock sandbox layer that intercepts agent commands and runs a
 * mock script instead. All other commands pass through to the local sandbox.
 */
const makeMockAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): SandboxService => {
  const real = makeLocalSandbox(sandboxDir);

  const matchAgent = (command: string) =>
    AGENT_PREFIXES.find((a) => command.includes(a.prefix));

  return {
    exec: (command, options) => {
      const agent = matchAgent(command);
      if (agent && options?.onLine) {
        const onLine = options.onLine;
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          const streamOutput = agent.toStream(output);
          for (const line of streamOutput.split("\n")) {
            onLine(line);
          }
          return { stdout: streamOutput, stderr: "", exitCode: 0 };
        });
      }
      if (agent) {
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          return { stdout: output, stderr: "", exitCode: 0 };
        });
      }
      return real.exec(command, options);
    },
    copyIn: (hostPath, sandboxPath) => real.copyIn(hostPath, sandboxPath),
    copyFileOut: (sandboxPath, hostPath) =>
      real.copyFileOut(sandboxPath, hostPath),
  };
};

/**
 * Create a mock isolated sandbox provider that intercepts agent commands.
 * Uses testIsolated() as a base and wraps exec to intercept the bob command.
 */
const makeMockIsolatedProvider = (
  mockAgentBehavior: (cwd: string) => Promise<string> = async () =>
    "mock output",
) => {
  const base = testIsolated();
  return createIsolatedSandboxProvider({
    name: "mock-isolated",
    create: async (opts) => {
      const handle = await base.create(opts);
      return {
        ...handle,
        exec: async (command: string, options?: any) => {
          const agent = AGENT_PREFIXES.find((a) =>
            command.includes(a.prefix),
          );
          if (agent && options?.onLine) {
            const cwd = options?.cwd ?? handle.worktreePath;
            const output = await mockAgentBehavior(cwd);
            const streamOutput = agent.toStream(output);
            for (const line of streamOutput.split("\n")) {
              options.onLine(line);
            }
            return { stdout: streamOutput, stderr: "", exitCode: 0 };
          }
          if (agent) {
            const cwd = options?.cwd ?? handle.worktreePath;
            const output = await mockAgentBehavior(cwd);
            return { stdout: output, stderr: "", exitCode: 0 };
          }
          return handle.exec(command, options);
        },
      };
    },
  });
};

describe("createSandbox", () => {
  it("creates a sandbox with branch and worktreePath properties", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      expect(sandbox.branch).toBe("test-branch");
      expect(sandbox.worktreePath).toContain(".sandcastle/worktrees");
      expect(existsSync(sandbox.worktreePath)).toBe(true);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() invokes agent and returns SandboxRunResult", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-run-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    try {
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "do something",
        maxIterations: 1,
      });

      expect(result.iterations.length).toBe(1);
      expect(typeof result.stdout).toBe("string");
      expect(Array.isArray(result.commits)).toBe(true);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() rejects resumeSession with maxIterations > 1", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-resume-validate-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "resume-validate",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "ok"),
      },
    });

    try {
      await expect(
        sandbox.run({
          agent: testProvider,
          prompt: "do something",
          maxIterations: 2,
          resumeSession: "abc-123",
        }),
      ).rejects.toThrow(
        "resumeSession cannot be combined with maxIterations > 1",
      );

      await expect(
        sandbox.run({
          agent: testProvider,
          prompt: "do something",
          forkSession: true,
        }),
      ).rejects.toThrow("forkSession requires resumeSession");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() appends raw stdout to the same log file when logging.verbose is true", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-verbose-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");
    const logPath = join(hostDir, "verbose.log");

    // Use a mock that emits both a recognised stream-JSON line and a line
    // parseStreamLine drops (bob echoing the prompt back as a "user" message)
    // so we can verify ALL stdout makes it to the log file.
    const droppedLine = JSON.stringify({
      type: "message",
      role: "user",
      content: "the original prompt, echoed back",
    });
    const recognisedLine = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "hello",
    });

    const sandbox = await createSandbox({
      branch: "verbose-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => {
          const real = makeLocalSandbox(sandboxDir);
          return {
            exec: (command, options) => {
              if (command.includes("bob run") && options?.onLine) {
                const onLine = options.onLine;
                return Effect.gen(function* () {
                  for (const line of [droppedLine, recognisedLine]) {
                    onLine(line);
                  }
                  return {
                    stdout: [droppedLine, recognisedLine].join("\n"),
                    stderr: "",
                    exitCode: 0,
                  };
                });
              }
              return real.exec(command, options);
            },
            copyIn: real.copyIn,
            copyFileOut: real.copyFileOut,
          };
        },
      },
    });

    try {
      await sandbox.run({
        agent: testProvider,
        prompt: "do something",
        maxIterations: 1,
        logging: { type: "file", path: logPath, verbose: true },
      });

      const log = await readFile(logPath, "utf-8");
      expect(log).toContain(droppedLine);
      expect(log).toContain(recognisedLine);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() does NOT append raw stdout to the log file when verbose is false/unset", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-verbose-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");
    const logPath = join(hostDir, "verbose-off.log");

    // Same dropped line as the verbose-on test. With verbose unset it
    // must NOT appear in the log file (parseStreamLine drops it and only
    // the human-readable output reaches the file).
    const droppedLine = JSON.stringify({
      type: "message",
      role: "user",
      content: "the original prompt, echoed back",
    });
    const recognisedLine = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "hello",
    });

    const sandbox = await createSandbox({
      branch: "verbose-off-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => {
          const real = makeLocalSandbox(sandboxDir);
          return {
            exec: (command, options) => {
              if (command.includes("bob run") && options?.onLine) {
                const onLine = options.onLine;
                return Effect.gen(function* () {
                  for (const line of [droppedLine, recognisedLine]) {
                    onLine(line);
                  }
                  return {
                    stdout: [droppedLine, recognisedLine].join("\n"),
                    stderr: "",
                    exitCode: 0,
                  };
                });
              }
              return real.exec(command, options);
            },
            copyIn: real.copyIn,
            copyFileOut: real.copyFileOut,
          };
        },
      },
    });

    try {
      await sandbox.run({
        agent: testProvider,
        prompt: "do something",
        maxIterations: 1,
        logging: { type: "file", path: logPath },
      });

      const log = await readFile(logPath, "utf-8");
      expect(log).not.toContain(droppedLine);
      expect(log).not.toContain(recognisedLine);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.exec() runs a command and returns the ExecResult (test-mode path)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-exec-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const result = await sandbox.exec("echo hello");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.exec() defaults cwd to the sandbox repo path", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-exec-cwd-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const result = await sandbox.exec("pwd");
      // In test mode, sandboxRepoDir === worktreePath.
      expect(result.stdout.trim()).toBe(sandbox.worktreePath);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.exec() returns non-zero exit codes without throwing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-exec-nonzero-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const result = await sandbox.exec("exit 7");
      expect(result.exitCode).toBe(7);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.exec() allows the caller to override the default cwd", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-exec-cwd-override",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const result = await sandbox.exec("pwd", { cwd: hostDir });
      expect(result.stdout.trim()).toBe(hostDir);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.exec() delegates to providerHandle.exec() (non-test mode)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const gitTmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
    const globalConfigPath = join(gitTmpDir, ".gitconfig");
    writeFileSync(globalConfigPath, "");
    const isolatedEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfigPath,
    };

    let userExecCmd: string | undefined;
    let userExecCwd: string | undefined;

    const spyProvider = createBindMountSandboxProvider({
      name: "spy-exec",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          // Sandcastle issues a `git config --global --add safe.directory ...`
          // command before user code can run; only record the user-issued one.
          if (cmd === "echo hello-from-provider") {
            userExecCmd = cmd;
            userExecCwd = execOpts?.cwd;
            return {
              stdout: "hello-from-provider\n",
              stderr: "",
              exitCode: 0,
            };
          }
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd, env: isolatedEnv });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-exec-delegates",
      sandbox: spyProvider,
      cwd: hostDir,
    });

    try {
      const result = await sandbox.exec("echo hello-from-provider");
      expect(result.stdout).toBe("hello-from-provider\n");
      expect(userExecCmd).toBe("echo hello-from-provider");
      // cwd should default to the provider's worktreePath.
      expect(userExecCwd).toBe(sandbox.worktreePath);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
      await rm(gitTmpDir, { recursive: true, force: true });
    }
  });

  it("sandbox.close() removes worktree when clean, returns no preservedWorktreePath", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-clean-close",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    const worktreePath = sandbox.worktreePath;
    const closeResult = await sandbox.close();

    expect(closeResult.preservedWorktreePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("sandbox.close() preserves worktree when dirty, returns preservedWorktreePath", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-dirty-close",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    // Make the worktree dirty
    await writeFile(join(sandbox.worktreePath, "dirty.txt"), "uncommitted");

    const closeResult = await sandbox.close();

    expect(closeResult.preservedWorktreePath).toBe(sandbox.worktreePath);
    expect(existsSync(sandbox.worktreePath)).toBe(true);

    // Clean up manually
    await rm(sandbox.worktreePath, { recursive: true, force: true });
    await execAsync(`git worktree prune`, { cwd: hostDir });
    await rm(hostDir, { recursive: true, force: true });
  });

  it("Symbol.asyncDispose works via await using", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let worktreePath: string;
    {
      await using sandbox = await createSandbox({
        branch: "test-dispose-branch",
        sandbox: testSandbox,
        cwd: hostDir,
        _test: {
          buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
        },
      });
      worktreePath = sandbox.worktreePath;
      expect(existsSync(worktreePath)).toBe(true);
    }
    // After block exit, worktree should be cleaned up
    expect(existsSync(worktreePath!)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("reuses clean worktree when branch is already checked out", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox1 = await createSandbox({
      branch: "collision-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const sandbox2 = await createSandbox({
        branch: "collision-branch",
        sandbox: testSandbox,
        cwd: hostDir,
        _test: {
          buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
        },
      });

      expect(sandbox2.worktreePath).toBe(sandbox1.worktreePath);
      expect(sandbox2.branch).toBe("collision-branch");
      await sandbox2.close();
    } finally {
      await sandbox1.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("reuses dirty worktree with warning (ADR 0003)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox1 = await createSandbox({
      branch: "dirty-collision",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    // Make the worktree dirty
    await writeFile(join(sandbox1.worktreePath, "dirty.txt"), "uncommitted");

    try {
      const sandbox2 = await createSandbox({
        branch: "dirty-collision",
        sandbox: testSandbox,
        cwd: hostDir,
        _test: {
          buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
        },
      });

      // Should reuse the same worktree path
      expect(sandbox2.worktreePath).toBe(sandbox1.worktreePath);
      expect(sandbox2.branch).toBe("dirty-collision");

      await sandbox2.close();
    } finally {
      await rm(sandbox1.worktreePath, { recursive: true, force: true });
      await execAsync("git worktree prune", { cwd: hostDir });
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() returns commits made during the run", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-commits-branch",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async (cwd) => {
            await writeFile(join(cwd, "agent-created.txt"), "new file");
            await execAsync("git add agent-created.txt", { cwd });
            await execAsync('git commit -m "agent commit"', { cwd });
            return "done";
          }),
      },
    });

    try {
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "create a file",
        maxIterations: 1,
      });

      expect(result.commits.length).toBeGreaterThanOrEqual(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.close() is idempotent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-idempotent-close",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    const result1 = await sandbox.close();
    const result2 = await sandbox.close();

    expect(result1.preservedWorktreePath).toBeUndefined();
    expect(result2.preservedWorktreePath).toBeUndefined();
    await rm(hostDir, { recursive: true, force: true });
  });

  it("two sequential runs with different prompts succeed on the same sandbox", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-multi-run",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "mock output"),
      },
    });

    try {
      const result1 = await sandbox.run({
        agent: testProvider,
        prompt: "implement feature",
        maxIterations: 1,
        name: "Implementer",
      });

      const result2 = await sandbox.run({
        agent: testProvider,
        prompt: "review the code",
        maxIterations: 1,
        name: "Reviewer",
      });

      expect(result1.iterations.length).toBe(1);
      expect(result2.iterations.length).toBe(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("commits from multiple runs accumulate on the branch", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let runCount = 0;
    const sandbox = await createSandbox({
      branch: "test-commit-accumulation",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async (cwd) => {
            runCount++;
            const fname = `file-${runCount}.txt`;
            await writeFile(join(cwd, fname), `content ${runCount}`);
            await execAsync(`git add ${fname}`, { cwd });
            await execAsync(`git commit -m "commit from run ${runCount}"`, {
              cwd,
            });
            return `done run ${runCount}`;
          }),
      },
    });

    try {
      const result1 = await sandbox.run({
        agent: testProvider,
        prompt: "first run",
        maxIterations: 1,
      });

      const result2 = await sandbox.run({
        agent: testProvider,
        prompt: "second run",
        maxIterations: 1,
      });

      expect(result1.commits.length).toBeGreaterThanOrEqual(1);
      expect(result2.commits.length).toBeGreaterThanOrEqual(1);

      // Verify both commits exist on the branch
      const { stdout: log } = await execAsync(
        `git log --oneline test-commit-accumulation`,
        { cwd: hostDir },
      );
      expect(log).toContain("commit from run 1");
      expect(log).toContain("commit from run 2");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("onSandboxReady hooks execute once at creation time", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-hooks",
      sandbox: testSandbox,
      hooks: {
        sandbox: {
          onSandboxReady: [
            { command: "touch /tmp/hook-marker.txt" },
            { command: "echo 'hook-ran' > hook-output.txt" },
          ],
        },
      },
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      // The hook wrote a file into the worktree (cwd is sandboxRepoDir = worktreePath in test mode)
      const hookOutput = await readFile(
        join(sandbox.worktreePath, "hook-output.txt"),
        "utf-8",
      );
      expect(hookOutput.trim()).toBe("hook-ran");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("provider's create() is called exactly once across multiple .run() calls", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let createCallCount = 0;
    let closeCallCount = 0;

    // Isolated git config so global writes don't pollute developer config
    const gitTmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
    const globalConfigPath = join(gitTmpDir, ".gitconfig");
    writeFileSync(globalConfigPath, "");
    const isolatedEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfigPath,
    };

    const spyProvider = createBindMountSandboxProvider({
      name: "spy",
      create: async (opts) => {
        createCallCount++;
        const workDir = opts.worktreePath;
        return {
          worktreePath: workDir,
          exec: async (cmd, execOpts) => {
            const cwd = execOpts?.cwd ?? workDir;
            if (cmd.includes("bob run") && execOpts?.onLine) {
              const onLine = execOpts.onLine;
              const output = toStreamJson("mock output");
              for (const line of output.split("\n")) onLine(line);
              return { stdout: output, stderr: "", exitCode: 0 };
            }
            if (cmd.includes("bob run")) {
              return { stdout: "mock", stderr: "", exitCode: 0 };
            }
            const result = await execAsync(cmd, { cwd, env: isolatedEnv });
            if (execOpts?.onLine) {
              for (const line of result.stdout.split("\n"))
                execOpts.onLine(line);
            }
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: 0,
            };
          },
          copyFileIn: async () => {},
          copyFileOut: async () => {},
          close: async () => {
            closeCallCount++;
          },
        };
      },
    });

    const sandbox = await createSandbox({
      branch: "test-create-once",
      sandbox: spyProvider,
      cwd: hostDir,
    });

    try {
      expect(createCallCount).toBe(1);

      await sandbox.run({
        agent: testProvider,
        prompt: "first run",
        maxIterations: 1,
      });
      expect(createCallCount).toBe(1);

      await sandbox.run({
        agent: testProvider,
        prompt: "second run",
        maxIterations: 1,
      });
      expect(createCallCount).toBe(1);
    } finally {
      await sandbox.close();
      expect(closeCallCount).toBe(1);
      await rm(hostDir, { recursive: true, force: true });
      await rm(gitTmpDir, { recursive: true, force: true });
    }
  });

  it("close() delegates to the provider handle's close()", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let providerClosed = false;

    const gitTmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
    const globalConfigPath = join(gitTmpDir, ".gitconfig");
    writeFileSync(globalConfigPath, "");
    const isolatedEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfigPath,
    };

    const spyProvider = createBindMountSandboxProvider({
      name: "spy-close",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          if (cmd.includes("bob run") && execOpts?.onLine) {
            const onLine = execOpts.onLine;
            const output = toStreamJson("mock");
            for (const line of output.split("\n")) onLine(line);
            return { stdout: output, stderr: "", exitCode: 0 };
          }
          if (cmd.includes("bob run"))
            return { stdout: "mock", stderr: "", exitCode: 0 };
          const result = await execAsync(cmd, { cwd, env: isolatedEnv });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {
          providerClosed = true;
        },
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-close-delegates",
      sandbox: spyProvider,
      cwd: hostDir,
    });

    expect(providerClosed).toBe(false);
    await sandbox.close();
    expect(providerClosed).toBe(true);

    await rm(hostDir, { recursive: true, force: true });
    await rm(gitTmpDir, { recursive: true, force: true });
  });

  it("state persists between runs — file created in run 1 exists in run 2", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let runNumber = 0;
    const sandbox = await createSandbox({
      branch: "test-state-persistence",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async (cwd) => {
            runNumber++;
            if (runNumber === 1) {
              // Run 1: create a file (non-committed state)
              await writeFile(join(cwd, "persistent-state.txt"), "from-run-1");
              return "created file";
            }
            // Run 2: verify the file still exists
            const content = await readFile(
              join(cwd, "persistent-state.txt"),
              "utf-8",
            );
            if (content !== "from-run-1") {
              throw new Error("State did not persist between runs!");
            }
            return "verified file exists";
          }),
      },
    });

    try {
      await sandbox.run({
        agent: testProvider,
        prompt: "create file",
        maxIterations: 1,
      });

      // Verify file exists on host between runs
      const content = await readFile(
        join(sandbox.worktreePath, "persistent-state.txt"),
        "utf-8",
      );
      expect(content).toBe("from-run-1");

      // Run 2 — the mock agent verifies the file persists inside the sandbox
      await sandbox.run({
        agent: testProvider,
        prompt: "verify file",
        maxIterations: 1,
      });
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("works with isolated sandbox providers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = testIsolated();
    const sandbox = await createSandbox({
      branch: "test-isolated-branch",
      sandbox: provider,
      cwd: hostDir,
    });

    try {
      expect(sandbox.branch).toBe("test-isolated-branch");
      expect(sandbox.worktreePath).toContain(".sandcastle/worktrees");
      expect(existsSync(sandbox.worktreePath)).toBe(true);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("isolated provider: run() syncs commits to host worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = makeMockIsolatedProvider();
    const sandbox = await createSandbox({
      branch: "test-isolated-commits",
      sandbox: provider,
      cwd: hostDir,
    });

    try {
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "create a file",
        maxIterations: 1,
      });

      expect(result.iterations.length).toBe(1);

      // Verify the worktree exists and is on the right branch
      const { stdout: branch } = await execAsync(
        "git rev-parse --abbrev-ref HEAD",
        { cwd: sandbox.worktreePath },
      );
      expect(branch.trim()).toBe("test-isolated-commits");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("isolated provider: close() cleans up properly", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = testIsolated();
    const sandbox = await createSandbox({
      branch: "test-isolated-close",
      sandbox: provider,
      cwd: hostDir,
    });

    const worktreePath = sandbox.worktreePath;
    const closeResult = await sandbox.close();

    expect(closeResult.preservedWorktreePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("isolated provider: sequential runs with commits sync correctly", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let runCount = 0;
    const provider = makeMockIsolatedProvider(async (cwd) => {
      runCount++;
      const fname = `isolated-file-${runCount}.txt`;
      await writeFile(join(cwd, fname), `content ${runCount}`);
      await execAsync(`git add ${fname}`, { cwd });
      await execAsync(`git commit -m "isolated commit ${runCount}"`, { cwd });
      return `done run ${runCount}`;
    });

    const sandbox = await createSandbox({
      branch: "test-isolated-multi-run",
      sandbox: provider,
      cwd: hostDir,
    });

    try {
      const result1 = await sandbox.run({
        agent: testProvider,
        prompt: "first run",
        maxIterations: 1,
      });
      expect(result1.commits.length).toBeGreaterThanOrEqual(1);

      const result2 = await sandbox.run({
        agent: testProvider,
        prompt: "second run",
        maxIterations: 1,
      });
      expect(result2.commits.length).toBeGreaterThanOrEqual(1);

      // Verify both commits exist on the host worktree branch
      const { stdout: log } = await execAsync(
        `git log --oneline test-isolated-multi-run`,
        { cwd: hostDir },
      );
      expect(log).toContain("isolated commit 1");
      expect(log).toContain("isolated commit 2");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() invokes interactiveExec and returns result", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const receivedArgs: string[] = [];

    // Create a provider that has interactiveExec
    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          if (execOpts?.onLine) {
            for (const line of result.stdout.split("\n")) execOpts.onLine(line);
          }
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        interactiveExec: async (args, _opts) => {
          receivedArgs.push(...args);
          return { exitCode: 0 };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-interactive",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    try {
      const result = await sandbox.interactive({
        agent: testProvider,
        prompt: "do something interactively",
      });

      expect(result.exitCode).toBe(0);
      expect(Array.isArray(result.commits)).toBe(true);
      expect(receivedArgs).toContain("do something interactively");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() reuses the same sandbox handle", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let createCallCount = 0;

    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive-reuse",
      create: async (opts) => {
        createCallCount++;
        return {
          worktreePath: opts.worktreePath,
          exec: async (cmd, execOpts) => {
            const cwd = execOpts?.cwd ?? opts.worktreePath;
            const result = await execAsync(cmd, { cwd });
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: 0,
            };
          },
          interactiveExec: async () => ({ exitCode: 0 }),
          copyFileIn: async () => {},
          copyFileOut: async () => {},
          close: async () => {},
        };
      },
    });

    const sandbox = await createSandbox({
      branch: "test-interactive-reuse",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    try {
      expect(createCallCount).toBe(1);
      await sandbox.interactive({
        agent: testProvider,
        prompt: "first interactive",
      });
      expect(createCallCount).toBe(1);
      await sandbox.interactive({
        agent: testProvider,
        prompt: "second interactive",
      });
      expect(createCallCount).toBe(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() collects commits made during session", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive-commits",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        interactiveExec: async (_args, opts) => {
          // Simulate agent making a commit
          const cwd = opts.cwd!;
          await writeFile(
            join(cwd, "interactive-file.txt"),
            "interactive content",
          );
          await execAsync("git add interactive-file.txt", { cwd });
          await execAsync('git commit -m "interactive commit"', { cwd });
          return { exitCode: 0 };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-interactive-commits",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    try {
      const result = await sandbox.interactive({
        agent: testProvider,
        prompt: "add a file",
      });

      expect(result.commits.length).toBeGreaterThanOrEqual(1);
      expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() throws when provider lacks interactiveExec", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    // Provider without interactiveExec
    const noInteractiveProvider = createBindMountSandboxProvider({
      name: "test-no-interactive",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-no-interactive",
      sandbox: noInteractiveProvider,
      cwd: hostDir,
    });

    try {
      await expect(
        sandbox.interactive({
          agent: testProvider,
          prompt: "test",
        }),
      ).rejects.toThrow("interactiveExec");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() substitutes {{KEY}} placeholders in prompts", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const receivedArgs: string[] = [];

    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive-args",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        interactiveExec: async (args, _opts) => {
          receivedArgs.push(...args);
          return { exitCode: 0 };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-interactive-args",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    const promptFile = join(hostDir, "interactive-args-prompt.md");
    await writeFile(promptFile, "Fix bug in {{COMPONENT}}");

    try {
      await sandbox.interactive({
        agent: testProvider,
        promptFile,
        promptArgs: { COMPONENT: "LoginForm" },
      });

      const promptArg = receivedArgs[receivedArgs.length - 1]!;
      expect(promptArg).toContain("LoginForm");
      expect(promptArg).not.toContain("{{COMPONENT}}");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() accepts signal option (type check)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-signal-type",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    try {
      const ac = new AbortController();
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "do something",
        signal: ac.signal,
      });
      expect(result.iterations.length).toBe(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() rejects immediately with pre-aborted signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-signal-pre-abort",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    try {
      const reason = new DOMException("cancelled", "AbortError");
      const ac = new AbortController();
      ac.abort(reason);

      await expect(
        sandbox.run({
          agent: testProvider,
          prompt: "do something",
          signal: ac.signal,
        }),
      ).rejects.toThrow("cancelled");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() abort leaves handle usable for next run", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-signal-reuse",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    try {
      // First run: abort
      const ac = new AbortController();
      ac.abort(new DOMException("cancelled", "AbortError"));
      await expect(
        sandbox.run({
          agent: testProvider,
          prompt: "will be aborted",
          signal: ac.signal,
        }),
      ).rejects.toThrow("cancelled");

      // Second run: succeeds with fresh signal
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "should succeed",
        signal: new AbortController().signal,
      });
      expect(result.iterations.length).toBe(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() abort then close() works cleanly", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-signal-then-close",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    // Abort
    const ac = new AbortController();
    ac.abort(new DOMException("cancelled", "AbortError"));
    await expect(
      sandbox.run({
        agent: testProvider,
        prompt: "will be aborted",
        signal: ac.signal,
      }),
    ).rejects.toThrow("cancelled");

    // Close should work fine
    const closeResult = await sandbox.close();
    expect(closeResult.preservedWorktreePath).toBeUndefined();
    await rm(hostDir, { recursive: true, force: true });
  });

  it("sandbox.interactive() accepts signal option (type check)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive-signal",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        interactiveExec: async () => ({ exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-interactive-signal",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    try {
      const result = await sandbox.interactive({
        agent: testProvider,
        prompt: "test",
        signal: new AbortController().signal,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.interactive() rejects with pre-aborted signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const interactiveProvider = createBindMountSandboxProvider({
      name: "test-interactive-preabort",
      create: async (opts) => ({
        worktreePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          const result = await execAsync(cmd, { cwd });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        interactiveExec: async () => ({ exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-interactive-preabort",
      sandbox: interactiveProvider,
      cwd: hostDir,
    });

    try {
      const ac = new AbortController();
      ac.abort(new DOMException("interactive-cancelled", "AbortError"));

      await expect(
        sandbox.interactive({
          agent: testProvider,
          prompt: "test",
          signal: ac.signal,
        }),
      ).rejects.toThrow("interactive-cancelled");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("createSandbox() does not accept signal option (type check)", () => {
    // This test validates at the type level — createSandbox should NOT accept signal.
    // If someone adds signal to CreateSandboxOptions, this will fail at compile time.
    const opts: CreateSandboxOptions = {
      branch: "test",
      sandbox: testSandbox,
    };
    // Verify signal is not a key on the options type
    type HasSignal = "signal" extends keyof CreateSandboxOptions ? true : false;
    const check: HasSignal = false;
    expect(check).toBe(false);
    expect(opts).toBeDefined();
  });

  it("forks new branch from baseBranch when specified", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    // Record the base commit's SHA before adding a second commit on main
    const { stdout: baseSha } = await execAsync("git rev-parse HEAD", {
      cwd: hostDir,
    });
    await commitFile(hostDir, "second.txt", "second", "second commit");

    const sandbox = await createSandbox({
      branch: "feature/from-base",
      baseBranch: baseSha.trim(),
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const { stdout: worktreeHead } = await execAsync("git rev-parse HEAD", {
        cwd: sandbox.worktreePath,
      });
      expect(worktreeHead.trim()).toBe(baseSha.trim());
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("removes the worktree when sandbox start fails (no orphan)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const failingProvider = createBindMountSandboxProvider({
      name: "failing-create",
      create: async () => {
        throw new Error("Image 'sandcastle:test' not found locally");
      },
    });

    try {
      await expect(
        createSandbox({
          branch: "test-start-fails",
          sandbox: failingProvider,
          cwd: hostDir,
        }),
      ).rejects.toThrow();

      // The worktree must not be left orphaned on disk.
      const worktreesDir = join(hostDir, ".sandcastle", "worktrees");
      const leftover = existsSync(worktreesDir)
        ? readdirSync(worktreesDir)
        : [];
      expect(leftover).toHaveLength(0);

      const { stdout } = await execAsync("git worktree list", { cwd: hostDir });
      expect(stdout).not.toContain(".sandcastle/worktrees");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("copyToWorktree copies files into the worktree at creation time", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    // Create untracked files in the host repo that should be copied
    await writeFile(join(hostDir, "config.json"), '{"key": "value"}');

    const sandbox = await createSandbox({
      branch: "test-copy",
      sandbox: testSandbox,
      copyToWorktree: ["config.json"],
      cwd: hostDir,
      _test: {
        buildSandbox: (sandboxDir) => makeLocalSandbox(sandboxDir),
      },
    });

    try {
      const copied = await readFile(
        join(sandbox.worktreePath, "config.json"),
        "utf-8",
      );
      expect(JSON.parse(copied)).toEqual({ key: "value" });
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });
});
