import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { type ContentsPayload, decodeContents } from "./contents.js";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { decodeUtf8, parseRepo, truncateText } from "./util.js";

export const readmeTool = defineTool({
  name: "github_readme",
  title: "GitHub repository readme",
  description:
    "Fetch a repository's README through GitHub's readme endpoint, which resolves the default naming variant (README.md, README.zh-CN.md, and friends); use github_file for a specific path. Costs 1 core call. Returns {repo, path, sha, size, encoding, content, binary, truncated}.",
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
    const result = await ctx.client.api<ContentsPayload>(`/repos/${owner}/${name}/readme`, {
      fresh: input.fresh,
      cacheTtlMs: 300_000,
    });
    const { data } = result;
    const meta = responseMeta(result, 1);

    //? decodeContents collapses binary bytes to null, so the binary exit sizes
    //* itself from the payload's size field, which GitHub keeps equal to the
    //* decoded byte length.
    const bytes = await decodeContents(ctx, data);
    if (bytes === null) {
      return {
        repo: `${owner}/${name}`,
        path: data.path,
        sha: data.sha,
        size: data.size,
        encoding: null,
        content: null,
        binary: true,
        truncated: false,
        //? meta is spread last on both exits (binary and text) so it trails the
        //* fixed keys and stays absent when the client reported no cache outcome.
        ...(meta !== undefined ? { meta } : {}),
      };
    }

    const text = decodeUtf8(bytes);
    if (text === null) {
      throw new GithubError("unsupported", "readme is not valid UTF-8");
    }
    const clipped = truncateText(text, ctx.config.maxFileBytes);
    return {
      repo: `${owner}/${name}`,
      path: data.path,
      sha: data.sha,
      size: bytes.byteLength,
      encoding: "utf-8",
      content: clipped.text,
      binary: false,
      truncated: clipped.truncated,
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
