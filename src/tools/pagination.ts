//? noUncheckedIndexedAccess makes exec() capture groups string | undefined;
//? the guards below narrow them instead of non-null assertions.
export function parseNextPage(link: string | null): number | null {
  if (!link) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(link);
  if (!match || match[1] === undefined) return null;
  try {
    const page = Number(new URL(match[1]).searchParams.get("page"));
    return Number.isInteger(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

export function linkFor(headers: Headers, rel: string): string | null {
  const link = headers.get("link");
  if (!link) return null;
  const match = new RegExp(`<([^>]+)>;\\s*rel="${rel}"`).exec(link);
  return match?.[1] ?? null;
}

export function listEnvelope<T>(items: T[], page: number, perPage: number, link: string | null) {
  const nextPage = parseNextPage(link);
  return {
    items,
    page,
    per_page: perPage,
    has_more: nextPage !== null,
    next_page: nextPage,
  };
}

export function searchEnvelope<T>(
  items: T[],
  totalCount: number,
  incompleteResults: boolean,
  page: number,
  perPage: number,
  link: string | null,
) {
  return {
    ...listEnvelope(items, page, perPage, link),
    total_count: totalCount,
    incomplete_results: incompleteResults,
  };
}
