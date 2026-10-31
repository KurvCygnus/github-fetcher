import { describe, expect, it } from "vitest";
import { CAPABILITY_GROUPS, capabilitiesTool } from "../../src/tools/capabilities.js";
import { allTools } from "../../src/tools/registry.js";
import { makeConfig } from "../helpers.js";

describe("CAPABILITY_GROUPS", () => {
  it("covers every registered tool exactly once", () => {
    const listed = Object.keys(CAPABILITY_GROUPS).sort();
    const registered = allTools.map((tool) => tool.name).sort();
    expect(listed).toEqual(registered);
  });
});

describe("github_capabilities", () => {
  it("groups tools without network calls", async () => {
    const output = await capabilitiesTool.handler({}, {
      client: {} as never,
      config: makeConfig(),
      authFingerprint: "abc",
    });
    expect(output.total).toBe(22);
    expect(Array.isArray(output.groups)).toBe(true);
    const snapshot = output.groups as Array<{ group: string; tools: { name: string; summary: string }[] }>;
    const names = snapshot.flatMap((group) => group.tools.map((tool) => tool.name));
    expect(names).toHaveLength(22);
    expect(new Set(names).size).toBe(22);
  });
});
