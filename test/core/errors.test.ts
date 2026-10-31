import { describe, expect, it } from "vitest";
import { GithubError, decodeHttpErrorBody, mapHttpError } from "../../src/core/errors.js";

describe("GithubError", () => {
  it("serializes code, message, and details", () => {
    const error = new GithubError("rate_limited", "slow down", { remaining: 0 });
    expect(error.toResult()).toEqual({
      error: { code: "rate_limited", message: "slow down", remaining: 0 },
    });
  });
});

describe("mapHttpError", () => {
  it("maps 401 to auth_failed", () => {
    expect(mapHttpError(401, "Bad credentials").code).toBe("auth_failed");
  });

  it("maps 404 to not_found", () => {
    expect(mapHttpError(404, "Not Found").code).toBe("not_found");
  });

  it("maps 422 to invalid_params", () => {
    expect(mapHttpError(422, "Validation Failed").code).toBe("invalid_params");
  });

  it("maps 500 to upstream and keeps the status", () => {
    const error = mapHttpError(500, "Server Error");
    expect(error.code).toBe("upstream");
    expect(error.details.status).toBe(500);
  });

  it("maps 403 without a rate-limit reset to upstream", () => {
    expect(mapHttpError(403, "Forbidden").code).toBe("upstream");
  });

  it("maps 403 with an exhausted rate limit to rate_limited", () => {
    const headers = new Headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "4102444800",
    });
    const error = mapHttpError(403, "API rate limit exceeded", headers);
    expect(error.code).toBe("rate_limited");
    expect(error.details).toMatchObject({
      resource: "core",
      limit: undefined,
      remaining: 0,
      //* 4102444800 s is 2100-01-01T00:00:00.000Z; the epoch is arbitrary, only the conversion matters.
      reset_at: "2100-01-01T00:00:00.000Z",
    });
    //* Without a retry-after header the seconds come from the reset epoch, which
    //* the fixture pins far in the future so the countdown stays positive.
    expect(error.details.retry_after_s).toBeGreaterThan(0);
  });

  it("prefers a numeric retry-after header over the reset epoch", () => {
    const headers = new Headers({ "retry-after": "2" });
    const error = mapHttpError(429, "Too Many Requests", headers);
    expect(error.code).toBe("rate_limited");
    expect(error.details.retry_after_s).toBe(2);
  });
});

describe("decodeHttpErrorBody", () => {
  it("extracts the message and documentation url from a JSON body", () => {
    const body = JSON.stringify({
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest",
    });
    expect(decodeHttpErrorBody(body)).toEqual({
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest",
    });
  });

  it("falls back to the raw text when the body is not JSON", () => {
    expect(decodeHttpErrorBody("<html>gateway timeout</html>")).toEqual({
      message: "<html>gateway timeout</html>",
    });
  });

  it("falls back to the raw text when message is not a string", () => {
    expect(decodeHttpErrorBody('{"message":42}')).toEqual({ message: '{"message":42}' });
  });
});
