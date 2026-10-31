import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { listEnvelope } from "./pagination.js";
import { githubQuery, parseRepo, truncateText } from "./util.js";

interface ReleaseResponse {
  tag_name: string;
  name: string | null;
  body: string | null;
  prerelease: boolean;
  draft: boolean;
  published_at: string | null;
  html_url: string;
  assets: {
    name: string;
    size: number;
    download_count: number;
    browser_download_url: string;
  }[];
}

export const releaseTool = defineTool({
  name: "github_release",
  title: "GitHub release",
  description:
    "Read the latest release or the release for a specific tag, including assets and download URLs.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    tag: z.string().optional().describe("Release tag; omit for the latest release"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const { owner, name } = parseRepo(input.repo);
    const path = input.tag
      ? `/repos/${owner}/${name}/releases/tags/${encodeURIComponent(input.tag)}`
      : `/repos/${owner}/${name}/releases/latest`;
    //* Repositories without any release answer 404; that is an expected outcome,
    //* so it becomes the found:false shape below and callers branch on `found`
    //* instead of catching. Every other error keeps propagating untouched.
    const notFound = {
      found: false,
      tag_name: null,
      name: null,
      body: null,
      prerelease: false,
      draft: false,
      published_at: null,
      html_url: null,
      assets: [],
    } as const;
    let data: ReleaseResponse;
    try {
      ({ data } = await ctx.client.api<ReleaseResponse>(path, {
        fresh: input.fresh,
        cacheTtlMs: 600_000,
      }));
    } catch (error) {
      if (error instanceof GithubError && error.code === "not_found") return notFound;
      throw error;
    }
    return {
      found: true,
      tag_name: data.tag_name,
      name: data.name,
      body: data.body === null ? null : truncateText(data.body, ctx.config.maxFileBytes).text,
      prerelease: data.prerelease,
      draft: data.draft,
      published_at: data.published_at,
      html_url: data.html_url,
      assets: data.assets.map((asset) => ({
        name: asset.name,
        size: asset.size,
        download_count: asset.download_count,
        browser_download_url: asset.browser_download_url,
      })),
    };
  },
});

export const releasesTool = defineTool({
  name: "github_releases",
  title: "GitHub releases",
  description:
    "List releases newest first with tag, name, prerelease/draft flags, and dates. Release note bodies are omitted to keep responses small; use github_release for a single release's notes. With include_prereleases=false the page is filtered client-side, so has_more reflects the unfiltered Link header.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, default 20"),
    include_prereleases: z.boolean().optional().describe("Include prerelease and draft releases, default true"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const { owner, name } = parseRepo(input.repo);
    const page = input.page ?? 1;
    const perPage = input.per_page ?? 20;
    const query = githubQuery({ page, per_page: perPage });
    const { data, headers } = await ctx.client.api<ReleaseResponse[]>(
      `/repos/${owner}/${name}/releases${query}`,
      { fresh: input.fresh, cacheTtlMs: 600_000 },
    );
    //* Filtering happens after the fetch, not in the query, so the Link header and
    //* thus has_more/next_page keep describing the upstream pages; callers stepping
    //* through next_page never silently skip a page that filtered to zero items.
    const visible =
      input.include_prereleases === false
        ? data.filter((release) => !release.prerelease && !release.draft)
        : data;
    const items = visible.map((release) => ({
      tag_name: release.tag_name,
      name: release.name,
      prerelease: release.prerelease,
      draft: release.draft,
      published_at: release.published_at,
      html_url: release.html_url,
    }));
    return listEnvelope(items, page, perPage, headers.get("link"));
  },
});
