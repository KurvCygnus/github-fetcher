import { describe, expect, it } from "vitest";
import { allTools } from "../../src/tools/registry.js";

describe("tool descriptions", () => {
  it("declares the output envelope in every description", () => {
    for (const tool of allTools) {
      //* Deviation from the brief, owner decision 2026-11-07: three verbatim
      //* sentences read "Returns <noun> fields {" (github_issue, github_pr,
      //* github_workflow_run), so the literal toContain("Returns {") from the
      //* brief can never pass. Sentences stay verbatim; the assertion accepts
      //* both the plain envelope form and the "<noun> fields" form.
      expect(tool.description, tool.name).toMatch(/Returns( [A-Za-z]+ fields)? \{/);
    }
  });
});
