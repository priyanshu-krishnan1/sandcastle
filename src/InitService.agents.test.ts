import { describe, expect, it } from "vitest";
import { listAgents, getAgent } from "./InitService.js";

describe("Agent registry", () => {
  it("listAgents returns only bob", () => {
    const agents = listAgents();
    expect(agents.map((a) => a.name)).toEqual(["bob"]);
  });

  it("getAgent returns the bob entry with expected fields", () => {
    const agent = getAgent("bob");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("bob");
    expect(agent!.defaultModel).toBe("default");
    expect(agent!.factoryImport).toBe("bob");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain("bob.ibm.com");
  });

  it("getAgent returns undefined for unknown agent", () => {
    expect(getAgent("nonexistent")).toBeUndefined();
  });
});
