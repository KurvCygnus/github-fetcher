import { describe, expect, it } from "vitest";
import { authorizeBearer, newBearerToken } from "../../src/daemon/auth.js";

describe("newBearerToken", () => {
  it("is non-empty and differs across calls", () => {
    const first = newBearerToken();
    const second = newBearerToken();
    expect(first.length).toBeGreaterThan(0);
    expect(first).not.toBe(second);
  });
});

describe("authorizeBearer", () => {
  it("accepts an exact Bearer header", () => {
    const token = newBearerToken();
    expect(authorizeBearer("Bearer " + token, token)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(authorizeBearer(undefined, "token")).toBe(false);
  });

  it("rejects a wrong scheme", () => {
    expect(authorizeBearer("Basic token", "token")).toBe(false);
  });

  it("rejects a wrong token", () => {
    expect(authorizeBearer("Bearer wrong", "right")).toBe(false);
  });
});
