import { exec } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeGitClient, type GitExec } from "./GitClient.js";

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

/**
 * A second, independently-written `GitExec` — deliberately not
 * `LocalGitClient`'s own implementation — standing in for "a channel other
 * than local child_process.exec" (an SSH connection, a sandbox provider's
 * own exec). Still runs locally under the hood since this is a unit test
 * with no real remote host available, but it's a genuinely different code
 * path than `LocalGitClient`'s, proving `makeGitClient` isn't secretly
 * coupled to child_process's exact call shape.
 */
const wrappedExec: GitExec = (command, cwd) =>
  new Promise((resolve, reject) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve({ stdout });
    });
  });

describe.each([
  [
    "LocalGitClient's own exec shape",
    (command: string, cwd: string) => execAsync(command, { cwd }),
  ],
  ["an independently-implemented exec channel", wrappedExec],
])("makeGitClient against %s", (_label, gitExec) => {
  const client = makeGitClient(gitExec);

  it("currentBranch reports the checked-out branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitclient-test-"));
    await initRepo(dir);
    await commitFile(dir, "a.txt", "a", "initial");

    const branch = await Effect.runPromise(client.currentBranch(dir));
    expect(branch).toBe("main");
  });

  it("identity reads git config user.name/email, empty string when unset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitclient-test-"));
    await initRepo(dir);

    const identity = await Effect.runPromise(client.identity(dir));
    expect(identity).toEqual({ name: "Test", email: "test@test.com" });
  });

  it("revParseHead reports the current commit SHA", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitclient-test-"));
    await initRepo(dir);
    await commitFile(dir, "a.txt", "a", "initial");

    const head = await Effect.runPromise(client.revParseHead(dir));
    const { stdout } = await execAsync("git rev-parse HEAD", { cwd: dir });
    expect(head).toBe(stdout.trim());
  });

  it("hasCommitsInRange and revList agree on a range with commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitclient-test-"));
    await initRepo(dir);
    await commitFile(dir, "a.txt", "a", "initial");
    const base = (
      await execAsync("git rev-parse HEAD", { cwd: dir })
    ).stdout.trim();
    await commitFile(dir, "b.txt", "b", "second");
    const second = (
      await execAsync("git rev-parse HEAD", { cwd: dir })
    ).stdout.trim();

    const hasCommits = await Effect.runPromise(
      client.hasCommitsInRange(dir, `${base}..HEAD`),
    );
    const shas = await Effect.runPromise(client.revList(dir, `${base}..HEAD`));

    expect(hasCommits).toBe(true);
    expect(shas).toEqual([second]);
  });

  it("hasCommitsInRange is false and revList is empty for a range with no commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitclient-test-"));
    await initRepo(dir);
    await commitFile(dir, "a.txt", "a", "initial");
    const head = (
      await execAsync("git rev-parse HEAD", { cwd: dir })
    ).stdout.trim();

    const hasCommits = await Effect.runPromise(
      client.hasCommitsInRange(dir, `${head}..HEAD`),
    );
    const shas = await Effect.runPromise(client.revList(dir, `${head}..HEAD`));

    expect(hasCommits).toBe(false);
    expect(shas).toEqual([]);
  });

  it("mergeBranch fast-forwards and deleteBranch removes the merged branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitclient-test-"));
    await initRepo(dir);
    await commitFile(dir, "a.txt", "a", "initial");
    await execAsync("git checkout -b feature", { cwd: dir });
    await commitFile(dir, "b.txt", "b", "feature commit");
    await execAsync("git checkout main", { cwd: dir });

    await Effect.runPromise(client.mergeBranch(dir, "feature", "main"));
    const headAfterMerge = (
      await execAsync("git log -1 --format=%s", { cwd: dir })
    ).stdout.trim();
    expect(headAfterMerge).toBe("feature commit");

    await Effect.runPromise(client.deleteBranch(dir, "feature"));
    const branches = (await execAsync("git branch", { cwd: dir })).stdout;
    expect(branches).not.toContain("feature");
  });

  it("mergeBranch fails with a descriptive message on conflict, and preserves the branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitclient-test-"));
    await initRepo(dir);
    await writeFile(join(dir, "conflict.txt"), "main version");
    await execAsync("git add conflict.txt", { cwd: dir });
    await execAsync('git commit -m "main commit"', { cwd: dir });
    await execAsync("git checkout -b conflicting", { cwd: dir });
    await writeFile(join(dir, "conflict.txt"), "feature version");
    await execAsync("git add conflict.txt", { cwd: dir });
    await execAsync('git commit -m "conflicting commit"', { cwd: dir });
    await execAsync("git checkout main", { cwd: dir });
    await writeFile(join(dir, "conflict.txt"), "main version, changed");
    await execAsync("git add conflict.txt", { cwd: dir });
    await execAsync('git commit -m "main change"', { cwd: dir });

    const result = await Effect.runPromise(
      Effect.either(client.mergeBranch(dir, "conflicting", "main")),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("conflicting");
      expect(result.left.message).toContain("main");
      expect(result.left.message).toContain("git branch -D conflicting");
    }

    // The branch must still exist — mergeBranch never deletes on failure.
    const branches = (await execAsync("git branch", { cwd: dir })).stdout;
    expect(branches).toContain("conflicting");

    // Clean up the half-finished merge so the temp dir doesn't linger dirty.
    await execAsync("git merge --abort", { cwd: dir }).catch(() => {});
  });
});
