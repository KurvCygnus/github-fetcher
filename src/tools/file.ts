import { z } from "zod";
import { looksBinary } from "../core/binary.js";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { resolveRef } from "./ref.js";
import { encodePath, githubQuery, parseRepo, truncateText } from "./util.js";

interface ContentsResponse {
  type: string;
  encoding: string;
  size: number;
  name: string;
  path: string;
  sha: string;
  content?: string;
  download_url: string | null;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export const fileTool = defineTool({
  name: "github_file",
  title: "GitHub file",
  description:
    "Read one file at a ref. Returns UTF-8 text when possible, never binary bytes, and reports sha, size, and truncation.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    path: z.string().describe("File path inside the repository"),
    ref: z.string().optional().describe("Branch, tag, or commit; defaults to the repository default branch"),
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
    const ref = await resolveRef(ctx.client, owner, name, input.ref, input.fresh);
    const path = encodePath(input.path);
    const { data } = await ctx.client.api<ContentsResponse | ContentsResponse[]>(
      `/repos/${owner}/${name}/contents/${path}${githubQuery({ ref })}`,
      { fresh: input.fresh, cacheTtlMs: 300_000 },
    );
    if (Array.isArray(data)) {
      throw new GithubError("invalid_params", "path points to a directory; use github_tree");
    }
    if (data.type !== "file") {
      throw new GithubError("invalid_params", "path is not a file");
    }

    let bytes: Uint8Array;
    if (data.encoding === "base64" && data.content !== undefined) {
      bytes = new Uint8Array(Buffer.from(data.content, "base64"));
    } else if (data.download_url) {
      bytes = await ctx.client.raw(data.download_url);
    } else {
      throw new GithubError("unsupported", "GitHub did not provide readable content for this file");
    }

    if (looksBinary(bytes, data.path)) {
      return {
        repo: `${owner}/${name}`,
        path: data.path,
        ref,
        sha: data.sha,
        size: bytes.byteLength,
        encoding: null,
        content: null,
        binary: true,
        truncated: false,
      };
    }

    const text = decodeUtf8(bytes);
    if (text === null) {
      throw new GithubError("unsupported", "file is not valid UTF-8");
    }
    const clipped = truncateText(text, ctx.config.maxFileBytes);
    return {
      repo: `${owner}/${name}`,
      path: data.path,
      ref,
      sha: data.sha,
      size: bytes.byteLength,
      encoding: "utf-8",
      content: clipped.text,
      binary: false,
      truncated: clipped.truncated,
    };
  },
});
