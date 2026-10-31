import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { parseRepo, truncateText } from "./util.js";

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
