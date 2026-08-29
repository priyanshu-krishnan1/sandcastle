import { describe, expect, it } from "vitest";
import { bob } from "./AgentProvider.js";
import { assertResumeSessionExists } from "./resumePrecheck.js";

const SESSION_ID = "9ba1c695-2222-4444-8888-e7e847bf34dd";

describe("assertResumeSessionExists", () => {
  it("throws when the provider does not support resume (no sessionStorage)", async () => {
    await expect(
      assertResumeSessionExists({
        provider: bob("default"),
        sandboxTag: "none",
        hostRepoDir: "/some/host/repo",
        resumeSession: SESSION_ID,
      }),
    ).rejects.toThrow("bob does not support resumeSession");
  });
});
