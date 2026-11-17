import { describe, expect, it } from "vitest";
import { cacheKey, readCachedTree } from "../../src/core/cache.js";
import { GithubError } from "../../src/core/errors.js";
import { encodePath, notFoundWithHint, truncateText } from "../../src/tools/util.js";
import { memoryCacheStore, seedCacheTree } from "../helpers.js";

describe("truncateText", () => {
  it("returns text unchanged within the byte budget", () => {
    expect(truncateText("hello", 5)).toEqual({ text: "hello", truncated: false });
  });

  it("clips ASCII exactly at the budget", () => {
    expect(truncateText("abcdef", 4)).toEqual({ text: "abcd", truncated: true });
  });

  it("counts multi-byte characters against the byte budget", () => {
    //* "héllo" is 6 UTF-8 bytes (é is 2); a 5-byte budget ends exactly after "héll".
    expect(truncateText("héllo", 6)).toEqual({ text: "héllo", truncated: false });
    expect(truncateText("héllo", 5)).toEqual({ text: "héll", truncated: true });
  });

  it("never splits a multi-byte code point at the clip boundary", () => {
    //* Budget 2 cuts inside é; the clip walks back to the last code-point boundary.
    expect(truncateText("héllo", 2)).toEqual({ text: "h", truncated: true });
    //* "中文" is 6 bytes (3 each); budgets 4 and 5 both land mid-文, keeping only 中.
    expect(truncateText("中文", 4)).toEqual({ text: "中", truncated: true });
    expect(truncateText("中文", 5)).toEqual({ text: "中", truncated: true });
    expect(truncateText("中文", 3)).toEqual({ text: "中", truncated: true });
  });

  it("walks back over a 4-byte lead at the clip boundary", () => {
    //* "a😀" is 5 bytes (a plus a 4-byte emoji); a 2-byte budget lands on the
    //* emoji's own lead byte, and the whole sequence is dropped, keeping "a".
    expect(truncateText("a😀", 2)).toEqual({ text: "a", truncated: true });
  });

  it("treats an empty budget as an empty string", () => {
    expect(truncateText("abc", 0)).toEqual({ text: "", truncated: true });
  });
});

//? The tree URL strings below are exactly what the handlers request: the plain
//* ref listing for the root and "ref:dir" for a path-scoped listing.
const ROOT_URL = "https://api.github.com/repos/octocat/Hello-World/git/trees/main";
const SRC_URL = "https://api.github.com/repos/octocat/Hello-World/git/trees/main:src";

describe("readCachedTree", () => {
  it("returns the cached listing's entry paths without touching the network", async () => {
    const store = memoryCacheStore();
    await seedCacheTree(store, "abc", ROOT_URL, {
      sha: "abc",
      truncated: false,
      tree: [{ path: "README.md" }, { path: "src" }],
    });
    expect(await readCachedTree(store, cacheKey(ROOT_URL, "abc"))).toEqual(["README.md", "src"]);
  });

  it("returns null for a missing key or a body that is not a tree listing", async () => {
    const store = memoryCacheStore();
    expect(await readCachedTree(store, cacheKey(ROOT_URL, "abc"))).toBeNull();
    await seedCacheTree(store, "abc", ROOT_URL, { message: "Not Found" });
    expect(await readCachedTree(store, cacheKey(ROOT_URL, "abc"))).toBeNull();
  });
});

describe("notFoundWithHint", () => {
  const base = { authFingerprint: "abc", owner: "octocat", name: "Hello-World", ref: "main" };
  const notFound = () => new GithubError("not_found", "Not Found", { status: 404 });

  it("passes non-404 and non-GithubError values through untouched", async () => {
    const rateLimited = new GithubError("rate_limited", "slow down");
    expect(
      await notFoundWithHint(rateLimited, { ...base, cache: undefined, path: "README.md" }),
    ).toBe(rateLimited);
    const plain = new Error("boom");
    expect(await notFoundWithHint(plain, { ...base, cache: undefined, path: "README.md" })).toBe(plain);
  });

  it("suggests checking the ref when the tree itself 404s at the ref", async () => {
    const result = (await notFoundWithHint(notFound(), {
      ...base,
      cache: undefined,
      path: undefined,
    })) as GithubError;
    expect(result.code).toBe("not_found");
    expect(result.message).toBe("Not Found");
    expect(result.details.hint).toBe("ref main not found; check the branch or tag name");
    expect(result.details.status).toBe(404);
  });

  it("lists repo-root siblings from the cached ref listing", async () => {
    const store = memoryCacheStore();
    await seedCacheTree(store, "abc", ROOT_URL, {
      tree: [{ path: "README.md" }, { path: "src" }, { path: "docs" }],
    });
    const result = (await notFoundWithHint(notFound(), {
      ...base,
      cache: store,
      path: "gone.md",
    })) as GithubError;
    expect(result.details.hint).toBe(
      'path "gone.md" not found at ref main; entries in repo root: README.md, src, docs',
    );
  });

  it("lists parent-directory siblings from the cached dir listing in both path spellings", async () => {
    //? Path-scoped listings may report paths relative to the directory or from
    //* the repo root; both must resolve to the same sibling names.
    const relative = memoryCacheStore();
    await seedCacheTree(relative, "abc", SRC_URL, {
      tree: [{ path: "index.ts" }, { path: "util.ts" }],
    });
    const fromRelative = (await notFoundWithHint(notFound(), {
      ...base,
      cache: relative,
      path: "src/missing.ts",
    })) as GithubError;
    expect(fromRelative.details.hint).toBe(
      'path "src/missing.ts" not found at ref main; entries in src: index.ts, util.ts',
    );

    const absolute = memoryCacheStore();
    await seedCacheTree(absolute, "abc", SRC_URL, {
      tree: [{ path: "src/index.ts" }, { path: "src/util.ts" }],
    });
    const fromAbsolute = (await notFoundWithHint(notFound(), {
      ...base,
      cache: absolute,
      path: "src/missing.ts",
    })) as GithubError;
    expect(fromAbsolute.details.hint).toBe(
      'path "src/missing.ts" not found at ref main; entries in src: index.ts, util.ts',
    );
  });

  it("falls back to the root listing when the parent dir is not cached", async () => {
    const store = memoryCacheStore();
    await seedCacheTree(store, "abc", ROOT_URL, {
      tree: [{ path: "src" }, { path: "README.md" }],
    });
    const result = (await notFoundWithHint(notFound(), {
      ...base,
      cache: store,
      path: "src/missing.ts",
    })) as GithubError;
    expect(result.details.hint).toBe(
      'path "src/missing.ts" not found at ref main; entries in repo root: src, README.md',
    );
  });

  it("returns the original error object when nothing relevant is cached", async () => {
    const error = notFound();
    expect(
      await notFoundWithHint(error, { ...base, cache: memoryCacheStore(), path: "gone.md" }),
    ).toBe(error);
  });

  it("caps the sibling list at 8 names", async () => {
    const store = memoryCacheStore();
    await seedCacheTree(store, "abc", ROOT_URL, {
      tree: Array.from({ length: 12 }, (_, index) => ({ path: `f${index}` })),
    });
    const result = (await notFoundWithHint(notFound(), {
      ...base,
      cache: store,
      path: "gone.md",
    })) as GithubError;
    expect(result.details.hint).toBe(
      "path \"gone.md\" not found at ref main; entries in repo root: f0, f1, f2, f3, f4, f5, f6, f7",
    );
  });
});

describe("encodePath", () => {
  //? The tree tool normalizes only a whole "." or "./" path at its own level;
  //* encodePath stays strict so ".." and mixed dot segments keep rejecting.
  it("keeps rejecting ., ./ and .. segments", () => {
    expect(() => encodePath(".")).toThrow();
    expect(() => encodePath("./")).toThrow();
    expect(() => encodePath("..")).toThrow();
    expect(() => encodePath("src/../x")).toThrow();
  });
});
