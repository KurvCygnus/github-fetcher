import { describe, expect, it } from "vitest";
import { allTools } from "../../src/tools/registry.js";

describe("tool descriptions", () => {
  it("declares the output envelope in every description", () => {
    for (const tool of allTools) {
      //* The registry legitimately uses two declaration forms: "Returns {...}"
      //* and "Returns <noun> fields {...}" (github_issue, github_pr, and
      //* github_workflow_run name their primary object before the key list).
      //* The guard accepts both; the declared shape itself is what matters.
      expect(tool.description, tool.name).toMatch(/Returns( [A-Za-z]+ fields)? \{/);
    }
  });
});
