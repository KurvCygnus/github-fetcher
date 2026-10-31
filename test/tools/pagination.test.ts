import { describe, expect, it } from "vitest";
import { listEnvelope, parseNextPage } from "../../src/tools/pagination.js";

describe("parseNextPage", () => {
  it("reads the rel=next page number", () => {
    const link =
      '<https://api.github.com/repos/a/b/commits?page=3>; rel="next", ' +
      '<https://api.github.com/repos/a/b/commits?page=9>; rel="last"';
    expect(parseNextPage(link)).toBe(3);
  });

  it("returns null without a next link", () => {
    expect(parseNextPage(null)).toBeNull();
    expect(parseNextPage('<https://api.github.com/x?page=2>; rel="prev"')).toBeNull();
  });
});

describe("listEnvelope", () => {
  it("uses the link header for has_more", () => {
    const link = '<https://api.github.com/repos/a/b/branches?page=2>; rel="next"';
    expect(listEnvelope([{ name: "main" }], 1, 1, link)).toEqual({
      items: [{ name: "main" }],
      page: 1,
      per_page: 1,
      has_more: true,
      next_page: 2,
    });
  });
});
