import { z } from "zod";
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
      expect(entry.summary.length, name).toBeLessThanOrEqual(250);
    }
  });

  it("derives input rows from the registered schemas", async () => {
    const output = await capabilitiesTool.handler({}, {
      client: {} as never,
      config: makeConfig(),
      authFingerprint: "abc",
    });
    const snapshot = output.groups as Array<{
      group: string;
      tools: Array<{ name: string; input: Array<{ name: string; optional: boolean; description: string }> }>;
    }>;
    const rows = snapshot.flatMap((group) => group.tools);
    const rate = rows.find((tool) => tool.name === "github_rate_limit")!;
    expect(rate.input).toEqual([
      {
        name: "resource",
        optional: true,
        description: "Limit the projection to one resource bucket, e.g. core or search",
      },
      {
        name: "all",
        optional: true,
        description: "Return every quota bucket; the default projects core and search only",
      },
    ]);
    const capabilities = rows.find((tool) => tool.name === "github_capabilities")!;
    expect(capabilities.input).toEqual([
      {
        name: "group",
        optional: true,
        description: "Restrict the index to one group, e.g. Search or Files; groups are listed in the output",
      },
    ]);
    expect(rows).toHaveLength(allTools.length);
  });

  it("slims every summary to one line with its envelope tag", () => {
    const itemTools = [
      "github_branches", "github_commits", "github_issues", "github_prs", "github_releases",
      "github_workflows", "github_workflow_runs", "github_search_repos", "github_search_code",
      "github_search_issues",
      //? Part 2 tools; every tag here is read off the summary in
      //* src/tools/capabilities.ts, not guessed.
      "github_user_repos", "github_user_starred", "github_user_events", "github_contributors",
    ];
    const singleTools = [
      "github_repo", "github_file", "github_issue", "github_pr", "github_release",
      "github_workflow_run", "github_rate_limit", "github_capabilities", "github_repo_health",
      "github_compare_repos",
      "github_user", "github_repos", "github_compare_refs", "github_languages",
      "github_repo_activity", "github_doctor",
    ];
    for (const name of itemTools) {
      expect(CAPABILITY_GROUPS[name]!.summary.endsWith("Envelope: items[]"), name).toBe(true);
    }
    for (const name of singleTools) {
      expect(CAPABILITY_GROUPS[name]!.summary.endsWith("Envelope: single object"), name).toBe(true);
    }
    expect(CAPABILITY_GROUPS.github_tree!.summary.endsWith("Envelope: entries[]")).toBe(true);
    expect(CAPABILITY_GROUPS.github_api_get!.summary.endsWith("Envelope: {status, content_type, body}")).toBe(true);
    for (const [name, entry] of Object.entries(CAPABILITY_GROUPS)) {
      expect(entry.summary.length, name).toBeLessThanOrEqual(250);
    }
  });

  it("derives every capability signature from the registered input schema", () => {
    for (const tool of allTools) {
      const shape = tool.inputSchema as Record<string, z.ZodType>;
      const keys = Object.keys(shape);
      const derived =
        keys.length === 0
          ? "none"
          : keys.map((key) => (shape[key] instanceof z.ZodOptional ? `${key}?` : key)).join(", ");
      expect(CAPABILITY_GROUPS[tool.name]?.signature, tool.name).toBe(derived);
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
    expect(output.total).toBe(allTools.length);
    expect(Array.isArray(output.groups)).toBe(true);
    const snapshot = output.groups as Array<{ group: string; tools: { name: string; summary: string }[] }>;
    const names = snapshot.flatMap((group) => group.tools.map((tool) => tool.name));
    expect(names).toHaveLength(allTools.length);
    expect(new Set(names).size).toBe(allTools.length);
  });

  //? Sweep test (Task 14, negative): the index is the one zero-network tool, so
  //* its envelope must NOT grow the meta key every network-backed tool carries.
  it("carries no meta key because the index answers without network calls", async () => {
    const output = await capabilitiesTool.handler({}, {
      client: {} as never,
      config: makeConfig(),
      authFingerprint: "abc",
    });
    expect("meta" in output).toBe(false);
  });

  it("returns signatures in the tool rows", async () => {
    const output = await capabilitiesTool.handler({}, {
      client: {} as never,
      config: makeConfig(),
      authFingerprint: "abc",
    });
    const snapshot = output.groups as Array<{ group: string; tools: Array<{ name: string; signature: string }> }>;
    const rows = snapshot.flatMap((group) => group.tools);
    expect(rows.find((tool) => tool.name === "github_capabilities")?.signature).toBe("group?");
    expect(rows.find((tool) => tool.name === "github_rate_limit")?.signature).toBe("resource?, all?");
    expect(rows.find((tool) => tool.name === "github_tree")?.signature).toBe(
      "repo, ref?, path?, recursive?, max_entries?, summary_only?, fresh?",
    );
    expect(rows.find((tool) => tool.name === "github_file")?.signature).toBe(
      "repo, path, ref?, start_line?, end_line?, max_bytes?, fresh?",
    );
    expect(rows.find((tool) => tool.name === "github_search_repos")?.signature).toBe(
      "query, sort?, order?, page?, per_page?, public_only?, fresh?",
    );
  });

  //? The index is the entry tool, so a filtered read keeps a full listing out of the
  //* client's budget: one group object instead of the whole index, while `total`
  //* still reports the full registry count so the caller can tell it is filtered.
  it("restricts the index to one group with a case-insensitive match", async () => {
    const output = await capabilitiesTool.handler({ group: "search" }, {
      client: {} as never,
      config: makeConfig(),
      authFingerprint: "abc",
    });
    const snapshot = output.groups as Array<{ group: string; tools: Array<{ name: string }> }>;
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.group).toBe("Search");
    expect(snapshot[0]!.tools.map((tool) => tool.name).sort()).toEqual([
      "github_search_code", "github_search_issues", "github_search_repos",
    ]);
    expect(output.total).toBe(allTools.length);
  });

  it("rejects an unknown group with a self-correcting valid-groups message", async () => {
    await expect(
      capabilitiesTool.handler({ group: "Nope" }, {
        client: {} as never,
        config: makeConfig(),
        authFingerprint: "abc",
      }),
    ).rejects.toMatchObject({
      code: "invalid_params",
      message: expect.stringContaining("valid groups:"),
    });
  });
});
