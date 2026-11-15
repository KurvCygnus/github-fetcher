import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { createTrendingTool, trendingTool } from "../../src/tools/trending.js";
import type { SnapshotEntry } from "../../src/tools/trending.js";
import { makeConfig } from "../helpers.js";

interface Reply {
  data: unknown;
  quota?: { resource: string; remaining: number };
}

//? Routes on the decoded q parameter, so the rising (created:>) and active
//! (pushed:>) lenses each get their own fixture and an unrouted query fails
//! loudly instead of silently feeding one lens's payload to the other.
function searchClient(routes: Record<string, Reply>) {
  return {
    api: vi.fn(async (url: string) => {
      const parsed = new URL(`https://api.github.com${url}`);
      const q = parsed.searchParams.get("q") ?? "";
      const route = routes[q];
      if (route === undefined) throw new Error(`unexpected query ${q}`);
      return {
        data: route.data,
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
        cache: { state: "miss" as const },
        ...(route.quota !== undefined ? { quota: route.quota } : {}),
      };
    }),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

//? Search item fixture carrying exactly the fields the lean projection reads.
function repoItem(fullName: string, stars: number, language: string | null = "TypeScript") {
  return {
    full_name: fullName,
    stargazers_count: stars,
    description: `${fullName} description`,
    language,
    created_at: "2026-11-10T00:00:00Z",
    pushed_at: "2026-11-15T00:00:00Z",
  };
}

function searchPayload(items: unknown[], incomplete = false) {
  return { total_count: items.length, incomplete_results: incomplete, items };
}

//? Fixed clock: the window-start date math (1/7/30 days back) must be deterministic.
const NOW = () => new Date("2026-11-16T12:00:00Z");

//? In-memory snapshot store standing in for the on-disk default, so no test
//! ever touches the real filesystem; spies let the assertions see the keys.
function memoryStore(prior: Record<string, SnapshotEntry> = {}) {
  const entries = new Map<string, SnapshotEntry>(Object.entries(prior));
  const read = vi.fn(async (key: string) => entries.get(key));
  const write = vi.fn(async (key: string, entry: SnapshotEntry) => {
    entries.set(key, entry);
  });
  return { entries, read, write };
}

function depsFor(store: ReturnType<typeof memoryStore>) {
  return {
    env: {},
    homedir: "/home/u",
    platform: "linux" as NodeJS.Platform,
    readSnapshot: store.read,
    writeSnapshot: store.write,
    now: NOW,
  };
}

function callUrls(client: GitHubApi): string[] {
  const api = (client as unknown as { api: { mock: { calls: Array<[string, unknown]> } } }).api;
  return api.mock.calls.map((call) => call[0]);
}

describe("github_trending", () => {
  it("routes two lens searches and projects lean rows with exact meta", async () => {
    const client = searchClient({
      "created:>2026-11-09 stars:>100": { data: searchPayload([repoItem("rising/one", 120)]) },
      "pushed:>2026-11-09 stars:>100": {
        data: searchPayload([repoItem("active/one", 900), repoItem("active/two", 400, "Go")], true),
        quota: { resource: "search", remaining: 25 },
      },
    });
    const store = memoryStore();
    const tool = createTrendingTool(depsFor(store));
    const output = await tool.handler(
      {},
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    //? Weekly window back 7 days from the fixed clock; the two lenses differ in
    //* the created:/pushed: qualifier, so two distinct URLs are always issued.
    expect(callUrls(client)).toEqual([
      "/search/repositories?q=created%3A%3E2026-11-09+stars%3A%3E100&sort=stars&per_page=15",
      "/search/repositories?q=pushed%3A%3E2026-11-09+stars%3A%3E100&sort=stars&per_page=15",
    ]);
    expect(output).toEqual({
      window: "weekly",
      language: null,
      lenses: {
        rising: [
          {
            full_name: "rising/one",
            stars: 120,
            description: "rising/one description",
            language: "TypeScript",
            pushed_at: "2026-11-15T00:00:00Z",
            created_at: "2026-11-10T00:00:00Z",
          },
        ],
        active: [
          {
            full_name: "active/one",
            stars: 900,
            description: "active/one description",
            language: "TypeScript",
            pushed_at: "2026-11-15T00:00:00Z",
            created_at: "2026-11-10T00:00:00Z",
          },
          {
            full_name: "active/two",
            stars: 400,
            description: "active/two description",
            language: "Go",
            pushed_at: "2026-11-15T00:00:00Z",
            created_at: "2026-11-10T00:00:00Z",
          },
        ],
      },
      rising_incomplete_results: false,
      active_incomplete_results: true,
      source: "computed",
      //? Two api invocations were issued; the scarcest quota observation wins.
      meta: { cache: "miss", quota: { resource: "search", remaining: 25 }, calls: 2 },
    });
    //? First call with an empty store: no prior means no delta fields anywhere.
    expect(JSON.stringify(output)).not.toContain("stars_gained");
  });

  it("writes fresh observations for both lens keys after the first call", async () => {
    const client = searchClient({
      "created:>2026-11-09 stars:>100": { data: searchPayload([repoItem("rising/one", 120)]) },
      "pushed:>2026-11-09 stars:>100": { data: searchPayload([]) },
    });
    const store = memoryStore();
    const tool = createTrendingTool(depsFor(store));
    await tool.handler({}, { client, config: makeConfig(), authFingerprint: "abc" });
    //? Keys are `${lens}:${language ?? "any"}:${window}`; the observation keeps
    //* the full_name -> stars map and the snapshot stamp from the injected now.
    expect(store.write).toHaveBeenCalledTimes(2);
    expect(store.write).toHaveBeenCalledWith("rising:any:weekly", {
      date: "2026-11-16T12:00:00.000Z",
      stars: { "rising/one": 120 },
    });
    expect(store.write).toHaveBeenCalledWith("active:any:weekly", {
      date: "2026-11-16T12:00:00.000Z",
      stars: {},
    });
    expect(store.read).toHaveBeenCalledWith("rising:any:weekly");
    expect(store.read).toHaveBeenCalledWith("active:any:weekly");
  });

  it("gains stars_gained from an injected prior snapshot and flips source", async () => {
    const client = searchClient({
      "created:>2026-11-09 stars:>100": {
        data: searchPayload([repoItem("rising/grew", 150), repoItem("rising/shrank", 350), repoItem("rising/new", 10)]),
      },
      "pushed:>2026-11-09 stars:>100": { data: searchPayload([repoItem("active/steady", 200)]) },
    });
    const store = memoryStore({
      "rising:any:weekly": {
        date: "2026-11-15T00:00:00Z",
        stars: { "rising/grew": 100, "rising/shrank": 400 },
      },
      "active:any:weekly": {
        date: "2026-11-15T00:00:00Z",
        stars: { "active/steady": 180 },
      },
    });
    const tool = createTrendingTool(depsFor(store));
    const output = await tool.handler(
      {},
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output.source).toBe("computed+snapshot");
    const rising = (output.lenses as { rising: Array<{ full_name: string; stars_gained?: number }> }).rising;
    expect(rising.find((row) => row.full_name === "rising/grew")?.stars_gained).toBe(50);
    //? gained = current - prior exactly; stars can shrink, so a negative delta
    //* passes through unclamped and clamping it would lie about velocity.
    expect(rising.find((row) => row.full_name === "rising/shrank")?.stars_gained).toBe(-50);
    expect(rising.find((row) => row.full_name === "rising/new")).not.toHaveProperty("stars_gained");
    const active = (output.lenses as { active: Array<{ full_name: string; stars_gained?: number }> }).active;
    expect(active[0]?.stars_gained).toBe(20);
  });

  it("keeps answering when the snapshot store rejects (best-effort store)", async () => {
    const client = searchClient({
      "created:>2026-11-09 stars:>100": { data: searchPayload([repoItem("rising/one", 120)]) },
      "pushed:>2026-11-09 stars:>100": { data: searchPayload([]) },
    });
    const tool = createTrendingTool({
      readSnapshot: vi.fn(async () => {
        throw new Error("read blew up");
      }),
      writeSnapshot: vi.fn(async () => {
        throw new Error("disk on fire");
      }),
      now: NOW,
    });
    const output = await tool.handler(
      {},
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output.source).toBe("computed");
    expect(JSON.stringify(output)).not.toContain("stars_gained");
    expect(output.lenses).toEqual({ rising: [expect.objectContaining({ full_name: "rising/one" })], active: [] });
  });

  it("routes window, language, and min_stars into the queries and the snapshot keys", async () => {
    const client = searchClient({
      "created:>2026-11-15 stars:>500 language:rust": { data: searchPayload([]) },
      "pushed:>2026-11-15 stars:>500 language:rust": { data: searchPayload([]) },
    });
    const store = memoryStore();
    const tool = createTrendingTool(depsFor(store));
    const output = await tool.handler(
      { window: "daily", language: "rust", min_stars: 500, limit: 30 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(callUrls(client)).toEqual([
      "/search/repositories?q=created%3A%3E2026-11-15+stars%3A%3E500+language%3Arust&sort=stars&per_page=30",
      "/search/repositories?q=pushed%3A%3E2026-11-15+stars%3A%3E500+language%3Arust&sort=stars&per_page=30",
    ]);
    expect(output.window).toBe("daily");
    expect(output.language).toBe("rust");
    //? Language joins the snapshot key, so a rust snapshot never leaks into the
    //* any-language lens.
    expect(store.read).toHaveBeenCalledWith("rising:rust:daily");
    expect(store.write).toHaveBeenCalledWith("active:rust:daily", { date: "2026-11-16T12:00:00.000Z", stars: {} });
  });

  it("maps the monthly window to a 30-day start", async () => {
    const client = searchClient({
      "created:>2026-10-17 stars:>100": { data: searchPayload([]) },
      "pushed:>2026-10-17 stars:>100": { data: searchPayload([]) },
    });
    const tool = createTrendingTool(depsFor(memoryStore()));
    const output = await tool.handler(
      { window: "monthly" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output.window).toBe("monthly");
    expect(callUrls(client)[0]).toContain("q=created%3A%3E2026-10-17");
  });

  it("exports a ready-made tool with the documented input schema", () => {
    expect(trendingTool.name).toBe("github_trending");
    expect(Object.keys(trendingTool.inputSchema)).toEqual(["window", "language", "min_stars", "limit", "fresh"]);
  });
});
