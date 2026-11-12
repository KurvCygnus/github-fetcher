import { z } from "zod";
import { looksBinary } from "../core/binary.js";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { parseRepo, truncateText } from "./util.js";

//? The readme endpoint answers a single file object with the Contents payload
//? shape; only the fields the handler consumes are typed.
interface ReadmeResponse {
  encoding: string;
  content?: string;
  download_url: string | null;
  sha: string;
  size: number;
  path: string;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

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
    const result = await ctx.client.api<ReadmeResponse>(`/repos/${owner}/${name}/readme`, {
      fresh: input.fresh,
      cacheTtlMs: 300_000,
    });
    const { data } = result;
    const meta = responseMeta(result);

    let bytes: Uint8Array;
    if (data.encoding === "base64" && data.content !== undefined) {
      bytes = new Uint8Array(Buffer.from(data.content, "base64"));
    } else if (data.download_url) {
      bytes = await ctx.client.raw(data.download_url);
    } else {
      throw new GithubError("unsupported", "GitHub did not provide readable content for this readme");
    }

    if (looksBinary(bytes, data.path)) {
      return {
        repo: `${owner}/${name}`,
        path: data.path,
        sha: data.sha,
        size: bytes.byteLength,
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
