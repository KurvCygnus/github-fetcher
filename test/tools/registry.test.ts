import { describe, expect, it } from "vitest";
import { EXPECTED_TOOL_COUNT, allTools } from "../../src/tools/registry.js";

describe("tool registry", () => {
  it("registers every documented tool exactly once", () => {
    expect(allTools).toHaveLength(EXPECTED_TOOL_COUNT);
    expect(new Set(allTools.map((tool) => tool.name)).size).toBe(EXPECTED_TOOL_COUNT);
  });
});
