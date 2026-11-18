import { describe, expect, it, vi } from "vitest";
import { GithubError } from "../../src/core/errors.js";
import type { GitHubApi } from "../../src/core/github.js";
import { decodeContents, type ContentsPayload } from "../../src/tools/contents.js";
import { makeClientWith } from "../helpers.js";

//? A complete Contents payload with every field the shared interface declares;
//* individual tests override the branch-relevant fields only.
function payload(overrides: Partial<ContentsPayload> = {}): ContentsPayload {
  return {
    type: "file",
    encoding: "base64",
    size: 5,
    name: "notes.md",
    path: "docs/notes.md",
    sha: "sha1",
    download_url: null,
    ...overrides,
  };
}

//? A client whose raw download serves the given bytes, so the download_url
//* branch can be exercised offline.
function makeRawClient(rawBytes: Uint8Array): GitHubApi {
  const client = makeClientWith({});
  client.raw = vi.fn(async () => rawBytes);
  return client;
}

describe("decodeContents", () => {
  it("decodes a base64 payload to bytes without touching raw", async () => {
    const client = makeClientWith({});
    const bytes = await decodeContents({ client }, payload({ content: Buffer.from("hello").toString("base64") }));
    expect(bytes).toEqual(new Uint8Array(Buffer.from("hello")));
    expect(client.raw).not.toHaveBeenCalled();
  });

  it("falls back to the client's raw download for a download_url payload", async () => {
    const url = "https://raw.githubusercontent.com/octocat/Hello-World/main/docs/notes.md";
    const rawBytes = new TextEncoder().encode("raw body");
    const client = makeRawClient(rawBytes);
    const bytes = await decodeContents({ client }, payload({ encoding: "none", download_url: url }));
    expect(bytes).toEqual(rawBytes);
    expect(client.raw).toHaveBeenCalledWith(url);
  });

  it("rejects with unsupported when neither branch is readable", async () => {
    const client = makeClientWith({});
    let failure: unknown;
    await decodeContents({ client }, payload()).catch((error: unknown) => {
      failure = error;
    });
    expect(failure).toBeInstanceOf(GithubError);
    expect((failure as GithubError).code).toBe("unsupported");
    expect((failure as GithubError).message).toBe("GitHub did not provide readable content");
  });

  it("returns null instead of throwing for binary bytes", async () => {
    const client = makeClientWith({});
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bytes = await decodeContents({ client }, payload({
      name: "logo.png",
      path: "images/logo.png",
      content: png.toString("base64"),
    }));
    expect(bytes).toBeNull();
  });
});
