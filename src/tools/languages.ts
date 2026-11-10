import { z } from "zod";
import { defineTool } from "./define.js";
import { parseRepo } from "./util.js";

//? The languages endpoint answers a flat name-to-bytes record; nothing else is typed.
type LanguagesResponse = Record<string, number>;

export const languagesTool = defineTool({
  name: "github_languages",
  title: "GitHub repository languages",
  description:
    "Read a repository's language breakdown as bytes per language, sorted by bytes descending; byte counts come from GitHub's language statistics, so they measure code bytes rather than counting file extensions. Costs 1 core call. Returns {languages, total_bytes}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
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
    const { data } = await ctx.client.api<LanguagesResponse>(`/repos/${owner}/${name}/languages`, {
      fresh: input.fresh,
      cacheTtlMs: 300_000,
    });
    //* The API's record arrives in no guaranteed order; entries are rebuilt into a
    //* fresh object in bytes-descending order so key insertion order is the sort.
    const sorted = Object.entries(data).sort(([, a], [, b]) => b - a);
    let totalBytes = 0;
    const languages: Record<string, number> = {};
    for (const [language, bytes] of sorted) {
      languages[language] = bytes;
      totalBytes += bytes;
    }
    return { languages, total_bytes: totalBytes };
  },
});
