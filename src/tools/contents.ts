import { looksBinary } from "../core/binary.js";
import { GithubError } from "../core/errors.js";
import type { GitHubApi } from "../core/github.js";

//? The Contents payload shape shared by the tools that read file bytes
//* (github_file, github_file_grep, github_files, github_readme); only the
//* fields those tools consume are typed.
export interface ContentsPayload {
  type: string;
  encoding: string;
  size: number;
  name: string;
  path: string;
  sha: string;
  content?: string;
  download_url: string | null;
}

//? The decode pipeline shared by the contents-reading tools: inline base64
//* content decodes first, otherwise the download_url is fetched through the
//* client's raw transport, and a payload with neither readable source rejects
//* with "unsupported". Binary bytes collapse to a null return so each caller
//* keeps its own distinct binary exit; text bytes come back whole.
export async function decodeContents(ctx: { client: GitHubApi }, data: ContentsPayload): Promise<Uint8Array | null> {
  let bytes: Uint8Array;
  if (data.encoding === "base64" && data.content !== undefined) {
    bytes = new Uint8Array(Buffer.from(data.content, "base64"));
  } else if (data.download_url) {
    bytes = await ctx.client.raw(data.download_url);
  } else {
    throw new GithubError("unsupported", "GitHub did not provide readable content");
  }
  if (looksBinary(bytes, data.path)) return null;
  return bytes;
}
