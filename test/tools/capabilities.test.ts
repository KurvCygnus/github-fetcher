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

  it("gives every registered tool a non-empty signature", () => {
    for (const [name, entry] of Object.entries(CAPABILITY_GROUPS)) {
      expect(entry.signature.length, name).toBeGreaterThan(0);
    }
  });

  //* The index is meant to be read in one shot before any call; a summary that
  //* balloons past this budget would make the whole listing expensive to ingest.
  it("keeps every summary non-empty and within the index budget", () => {
    for (const [name, entry] of Object.entries(CAPABILITY_GROUPS)) {
      expect(entry.summary.length, name).toBeGreaterThan(0);
      expect(entry.summary.length, name).toBeLessThanOrEqual(400);
    }
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

  it("returns signatures in the tool rows", async () => {
    const output = await capabilitiesTool.handler({}, {
      client: {} as never,
      config: makeConfig(),
      authFingerprint: "abc",
    });
    const snapshot = output.groups as Array<{ group: string; tools: Array<{ name: string; signature: string }> }>;
    const rows = snapshot.flatMap((group) => group.tools);
    expect(rows.find((tool) => tool.name === "github_capabilities")?.signature).toBe("none");
    expect(rows.find((tool) => tool.name === "github_rate_limit")?.signature).toBe("resource?");
    expect(rows.find((tool) => tool.name === "github_tree")?.signature).toBe(
      "repo, ref?, path?, recursive?, max_entries?, fresh?",
    );
    expect(rows.find((tool) => tool.name === "github_file")?.signature).toBe(
      "repo, path, ref?, start_line?, end_line?, fresh?",
    );
    expect(rows.find((tool) => tool.name === "github_search_repos")?.signature).toBe(
      "query, sort?, order?, page?, per_page?, public_only?, fresh?",
    );
  });
});
