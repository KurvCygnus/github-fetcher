import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { labelsTool } from "../../src/tools/labels.js";
import { makeConfig } from "../helpers.js";

interface LabelItem {
  name: string;
  color: string;
  description: string | null;
  open_issues_count: number | null;
  closed_issues_count: number | null;
}

interface LabelsEnvelope {
  repo: string;
  items: LabelItem[];
  page: number;
  per_page: number;
  has_more: boolean;
  next_page: number | null;
  meta?: { cache: string; calls?: number };
}

function asEnvelope(value: unknown): LabelsEnvelope {
  return value as LabelsEnvelope;
}

function fakeClient(data: unknown, headers: Headers = new Headers()) {
  //? The api mock declares its url/options arguments so mock.calls is typed instead of
  //! falling back to an empty tuple; the cast keeps the offline literal as GitHubApi.
  const api = vi.fn(async (_url: string, _options?: unknown) => ({
    data,
    headers,
    status: 200,
    contentType: "application/json",
    cache: { state: "miss" as const },
  }));
  const client = { api, apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
  return { api, client };
}

function ctxFor(client: GitHubApi) {
  return { client, config: makeConfig(), authFingerprint: "abc" };
}

describe("github_labels", () => {
  it("GETs the labels endpoint with default page 1 and per_page 30", async () => {
    const { api, client } = fakeClient([{ name: "bug", color: "ffffff", description: "Bug" }]);
    const out = asEnvelope(await labelsTool.handler({ repo: "o/r" }, ctxFor(client)));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0]?.[0]).toBe("/repos/o/r/labels?page=1&per_page=30");
    expect(api.mock.calls[0]?.[1]).toEqual({ fresh: undefined, cacheTtlMs: 120_000 });
    expect(out).toEqual({
      repo: "o/r",
      items: [
        { name: "bug", color: "ffffff", description: "Bug", open_issues_count: null, closed_issues_count: null },
      ],
      page: 1,
      per_page: 30,
      has_more: false,
      next_page: null,
      meta: { cache: "miss", calls: 1 },
    });
    expect(Object.keys(out).at(-1)).toBe("meta");
  });

  it("reports has_more and next_page from the Link header", async () => {
    const headers = new Headers({
      link: '<https://api.github.com/repos/o/r/labels?page=2&per_page=30>; rel="next"',
    });
    const { client } = fakeClient([], headers);
    const out = asEnvelope(await labelsTool.handler({ repo: "o/r", page: 1, per_page: 30 }, ctxFor(client)));
    expect(out.has_more).toBe(true);
    expect(out.next_page).toBe(2);
  });

  it("copies upstream issue counts only when with_counts is true, else null", async () => {
    const data = [
      { name: "bug", color: "f00", description: null, open_issues_count: 3, closed_issues_count: 7 },
      { name: "plain", color: "0f0", description: "none" },
    ];
    const { api, client } = fakeClient(data);
    const withCounts = asEnvelope(await labelsTool.handler({ repo: "o/r", with_counts: true }, ctxFor(client)));
    expect(withCounts.items).toEqual([
      { name: "bug", color: "f00", description: null, open_issues_count: 3, closed_issues_count: 7 },
      { name: "plain", color: "0f0", description: "none", open_issues_count: null, closed_issues_count: null },
    ]);
    //? with_counts is a projection flag: it never triggers a second upstream request.
    expect(api).toHaveBeenCalledTimes(1);
    expect(withCounts.meta?.calls).toBe(1);

    const withoutCounts = asEnvelope(await labelsTool.handler({ repo: "o/r" }, ctxFor(client)));
    expect(withoutCounts.items.map((item) => [item.open_issues_count, item.closed_issues_count])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("honors custom page, per_page and fresh", async () => {
    const { api, client } = fakeClient([]);
    await labelsTool.handler({ repo: "o/r", page: 2, per_page: 5, fresh: true }, ctxFor(client));
    expect(api.mock.calls[0]?.[0]).toBe("/repos/o/r/labels?page=2&per_page=5");
    expect(api.mock.calls[0]?.[1]).toEqual({ fresh: true, cacheTtlMs: 120_000 });
  });
});
