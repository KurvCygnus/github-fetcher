import { describe, expect, it } from "vitest";
import { truncateText } from "../../src/tools/util.js";

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
