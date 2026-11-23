import { describe, expect, it } from "vitest";
import { parseSearchQualifiers } from "../../src/tools/search-qualifiers.js";

describe("parseSearchQualifiers", () => {
  it("extracts repo, state, and quoted labels while keeping unknown qualifiers in the remainder", () => {
    expect(parseSearchQualifiers('repo:facebook/react is:issue label:"Type: Regression" state:open')).toEqual({
      repo: "facebook/react",
      state: "open",
      labels: ["Type: Regression"],
      remainder: "is:issue",
    });
  });

  it("leaves a query with no recognized qualifiers untouched", () => {
    expect(parseSearchQualifiers("stars:>100 language:rust")).toEqual({
      labels: [],
      remainder: "stars:>100 language:rust",
    });
  });

  it("extracts path and multiple labels, preserving token order in the remainder", () => {
    expect(parseSearchQualifiers('foo bar path:src/a.ts label:bug label:"needs triage" state:closed')).toEqual({
      path: "src/a.ts",
      state: "closed",
      labels: ["bug", "needs triage"],
      remainder: "foo bar",
    });
  });
});
