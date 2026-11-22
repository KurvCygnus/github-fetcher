//* A PinStore holds one pinned ref per repository for a single MCP session.
//* The stdio server shares one store across its lifetime, while the HTTP daemon
//* builds a store per session so a pin in one session never leaks into another.
export interface PinStore {
  get(repo: string): { ref: string; sha: string } | undefined;
  set(repo: string, ref: string, sha: string): void;
  delete(repo: string): void;
}

//* Back each store with its own map so two sessions never share pin state; the
//* entries live only as long as the caller keeps the returned store alive.
export function createPinStore(): PinStore {
  const entries = new Map<string, { ref: string; sha: string }>();
  return {
    get(repo) {
      return entries.get(repo);
    },
    set(repo, ref, sha) {
      entries.set(repo, { ref, sha });
    },
    delete(repo) {
      entries.delete(repo);
    },
  };
}
