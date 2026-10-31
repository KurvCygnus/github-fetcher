import type { GitHubApi } from "../core/github.js";

export async function resolveRef(
  client: GitHubApi,
  owner: string,
  name: string,
  ref: string | undefined,
  fresh: boolean | undefined,
): Promise<string> {
  if (ref) return ref;
  const { data } = await client.api<{ default_branch: string }>(`/repos/${owner}/${name}`, {
    fresh,
    cacheTtlMs: 600_000,
  });
  return data.default_branch;
}
