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

  //? v0.4 meta.calls: a handler that knows its exact upstream request count passes
  //* it as the trailing argument; the key lands last inside the meta object.
  it("reports the exact upstream call count when one is passed", () => {
    expect(
      responseMeta(
        { cache: { state: "hit", ageSeconds: 12 }, quota: { resource: "core", remaining: 4990 } },
        3,
      ),
    ).toEqual({
      cache: "hit",
      age_s: 12,
      quota: { resource: "core", remaining: 4990 },
      calls: 3,
    });
    expect(responseMeta({ cache: { state: "miss" } }, 1)).toEqual({ cache: "miss", calls: 1 });
  });

  it("keeps a passed call count out of undefined results", () => {
    expect(responseMeta(undefined, 3)).toBeUndefined();
    expect(responseMeta({}, 3)).toBeUndefined();
    expect(responseMeta({ quota: { resource: "core", remaining: 5 } }, 3)).toBeUndefined();
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

  //? v0.4 meta.calls: multi-request handlers report their whole batch's request
  //* count beside the scarcest quota observation; without a count the key stays
  //* absent so the pre-0.4 shape is unchanged.
  it("tags the scarcest observation with the batch's call count when one is passed", () => {
    expect(
      scarcestMeta(
        [
          { cache: { state: "miss" }, quota: { resource: "core", remaining: 100 } },
          { cache: { state: "hit", ageSeconds: 5 }, quota: { resource: "core", remaining: 40 } },
        ],
        7,
      ),
    ).toEqual({ cache: "hit", age_s: 5, quota: { resource: "core", remaining: 40 }, calls: 7 });
    expect(
      scarcestMeta([undefined, { cache: { state: "hit", ageSeconds: 7 } }], 4),
    ).toEqual({ cache: "hit", age_s: 7, calls: 4 });
  });

  it("keeps the meta calls-free when no count is passed", () => {
    expect(
      scarcestMeta([{ cache: { state: "miss" }, quota: { resource: "core", remaining: 9 } }]),
    ).toEqual({ cache: "miss", quota: { resource: "core", remaining: 9 } });
    expect(scarcestMeta([], 7)).toBeUndefined();
    expect(scarcestMeta([undefined], 7)).toBeUndefined();
  });
});
