import { describe, expect, it } from "vitest";
import { fyre } from "./fyre.js";

describe("fyre()", () => {
  it("returns an isolated sandbox provider with name 'fyre'", () => {
    const provider = fyre({ host: "fyre-x86" });
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("fyre");
  });

  it("defaults env to empty object when not provided", () => {
    const provider = fyre({ host: "fyre-x86" });
    expect(provider.env).toEqual({});
  });

  it("accepts provider env", () => {
    const provider = fyre({
      host: "fyre-x86",
      env: { FYRE_TEST: "1" },
    });
    expect(provider.env).toEqual({ FYRE_TEST: "1" });
  });

  it("allows ssh identity and user configuration", () => {
    const provider = fyre({
      host: "fyre-x86",
      user: "mohit29",
      identityFile: "~/.ssh/id_ed25519",
    });
    expect(provider.tag).toBe("isolated");
  });
});
