import { describe, expect, it } from "vitest";
import { responseMeta, scarcestMeta } from "../../src/tools/meta.js";

describe("responseMeta", () => {
  it("maps a cache hit outcome and quota into the meta shape", () => {
    expect(
      responseMeta({ cache: { state: "hit", ageSeconds: 12 }, quota: { resource: "core", remaining: 4990 } }),
    ).toEqual({
      cache: "hit",
      age_s: 12,
      quota: { resource: "core", remaining: 4990 },
    });
  });

  it("reports a miss without age_s", () => {
    expect(responseMeta({ cache: { state: "miss" }, quota: { resource: "core", remaining: 100 } })).toEqual({
      cache: "miss",
      quota: { resource: "core", remaining: 100 },
    });
  });

  it("reports revalidated with age_s 0 and omits an unknown quota", () => {
    expect(responseMeta({ cache: { state: "revalidated", ageSeconds: 0 } })).toEqual({
      cache: "revalidated",
      age_s: 0,
    });
    expect(responseMeta({ cache: { state: "hit", ageSeconds: 3 } })).toEqual({ cache: "hit", age_s: 3 });
  });

  it("returns undefined for undefined input and for cache-less results", () => {
    expect(responseMeta(undefined)).toBeUndefined();
    expect(responseMeta({})).toBeUndefined();
    expect(responseMeta({ quota: { resource: "core", remaining: 5 } })).toBeUndefined();
  });
});

describe("scarcestMeta", () => {
  it("picks the observation with the lowest quota remaining", () => {
    expect(
      scarcestMeta([
        { cache: { state: "miss" }, quota: { resource: "core", remaining: 100 } },
        { cache: { state: "hit", ageSeconds: 5 }, quota: { resource: "core", remaining: 40 } },
      ]),
    ).toEqual({ cache: "hit", age_s: 5, quota: { resource: "core", remaining: 40 } });
  });

  it("keeps the first observation on a remaining tie", () => {
    expect(
      scarcestMeta([
        { cache: { state: "miss" }, quota: { resource: "search", remaining: 7 } },
        { cache: { state: "miss" }, quota: { resource: "core", remaining: 7 } },
      ]),
    ).toEqual({ cache: "miss", quota: { resource: "search", remaining: 7 } });
  });

  it("falls back to the first defined responseMeta when no result carries quota", () => {
    expect(
      scarcestMeta([
        undefined,
        { cache: { state: "hit", ageSeconds: 7 } },
        { cache: { state: "miss" } },
      ]),
    ).toEqual({ cache: "hit", age_s: 7 });
  });

  it("returns undefined when nothing is defined", () => {
    expect(scarcestMeta([])).toBeUndefined();
    expect(scarcestMeta([undefined])).toBeUndefined();
  });
});
