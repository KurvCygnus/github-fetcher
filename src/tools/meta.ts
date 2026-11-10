import type { CacheOutcome, QuotaSnapshot } from "../core/github.js";

//? The meta channel shared by every network-backed tool envelope: callers spread
//? it last so `meta` is always the trailing key. Optional props spell out
//? "undefined" (house pattern) because handlers pass schema-optional values.
export interface ResponseMeta {
  cache: "hit" | "revalidated" | "miss";
  age_s?: number | undefined;
  quota?: QuotaSnapshot | undefined;
}

//? Structural subset of ApiResult/RawApiResult, so any client result (or a test
//? mock without the rest of the shape) satisfies it; undefined covers callers
//? whose sub-request failed and never produced a result.
export type MetaSource =
  | { cache?: CacheOutcome | undefined; quota?: QuotaSnapshot | undefined }
  | undefined;

//* A result without a cache outcome keeps its exact old shape: responseMeta has
//* nothing trustworthy to say about it, so it maps to undefined rather than a
//* half-filled meta object. age_s exists only for hit/revalidated (a miss has no
//* age by definition), and an unknown quota is omitted instead of zero-faked.
export function responseMeta(result: MetaSource): ResponseMeta | undefined {
  if (result?.cache === undefined) return undefined;
  const outcome = result.cache;
  return {
    cache: outcome.state,
    ...(outcome.state !== "miss" && outcome.ageSeconds !== undefined ? { age_s: outcome.ageSeconds } : {}),
    ...(result.quota !== undefined ? { quota: result.quota } : {}),
  };
}

//* Tools that issue several requests report their worst-case observation: the
//* lowest remaining seen across the results, tagged with that request's resource.
//* Ties keep the first observation, which keeps the output deterministic. When no
//* result carries quota, the first defined responseMeta is still reported so the
//* envelope keeps its cache state; an empty or all-undefined list maps to undefined.
export function scarcestMeta(results: ReadonlyArray<MetaSource>): ResponseMeta | undefined {
  let first: ResponseMeta | undefined;
  let scarcest: ResponseMeta | undefined;
  for (const result of results) {
    const meta = responseMeta(result);
    if (meta === undefined) continue;
    if (first === undefined) first = meta;
    if (meta.quota === undefined) continue;
    //* scarcest only ever receives metas whose quota is defined, so an undefined
    //* incumbent remaining can only mean "no incumbent yet".
    const incumbent = scarcest?.quota?.remaining;
    if (incumbent === undefined || meta.quota.remaining < incumbent) {
      scarcest = meta;
    }
  }
  return scarcest ?? first;
}
