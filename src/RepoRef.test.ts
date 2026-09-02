import { describe, expect, it } from "vitest";
import { repoRefPath, toRepoRef, type RepoRef } from "./RepoRef.js";

describe("toRepoRef", () => {
  it("wraps a path as a local RepoRef", () => {
    expect(toRepoRef("/repo/path")).toEqual({
      kind: "local",
      path: "/repo/path",
    });
  });
});

describe("repoRefPath", () => {
  it("returns the path for a local RepoRef", () => {
    const ref: RepoRef = { kind: "local", path: "/repo/path" };
    expect(repoRefPath(ref)).toBe("/repo/path");
  });

  it("returns the path for a remote RepoRef", () => {
    const ref: RepoRef = {
      kind: "remote",
      host: "fyre-x86",
      path: "/home/user/repo",
    };
    expect(repoRefPath(ref)).toBe("/home/user/repo");
  });

  it("throws for a RepoRef with kind 'none'", () => {
    const ref: RepoRef = { kind: "none" };
    expect(() => repoRefPath(ref)).toThrow(/kind "none"/);
  });
});
