//* The search tools accept a single free-form `query` string, so repository,
//* path, state, and label filters arrive as qualifiers inside that text. The
//* parser is pure string work: no client call and no new dependency.

export interface SearchQualifiers {
  repo?: string | undefined;
  path?: string | undefined;
  state?: string | undefined;
  labels: string[];
  remainder: string;
}

//* Double quotes bind a multi-word label value into one token; a manual scan
//* keeps those quotes attached to the token so the label parser can strip them.
function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of query) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (/\s/.test(char) && !inQuotes) {
      if (current !== "") tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseSearchQualifiers(query: string): SearchQualifiers {
  let repo: string | undefined;
  let path: string | undefined;
  let state: string | undefined;
  const labels: string[] = [];
  const remainder: string[] = [];
  for (const token of tokenize(query)) {
    //* An empty qualifier value stays in the remainder so a bare `repo:` never
    //* produces an empty repository path downstream.
    if (token.startsWith("repo:") && token.length > "repo:".length) {
      repo = token.slice("repo:".length);
    } else if (token.startsWith("path:") && token.length > "path:".length) {
      path = token.slice("path:".length);
    } else if (token.startsWith("state:") && token.length > "state:".length) {
      state = token.slice("state:".length);
    } else if (token.startsWith("label:") && token.length > "label:".length) {
      labels.push(stripQuotes(token.slice("label:".length)));
    } else {
      remainder.push(token);
    }
  }
  return {
    ...(repo !== undefined ? { repo } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(state !== undefined ? { state } : {}),
    labels,
    remainder: remainder.join(" "),
  };
}

export interface CodeQualifiers {
  repo?: string | undefined;
  path?: string | undefined;
  remainder: string;
}

//* Spec limits code search to repo:/path: parsing, so state:/label: and every
//* other token stay in the remainder verbatim. Re-injecting them would reorder
//* a non-repo query and change its request bytes; this parser keeps that path
//* identical regardless of how the free-form query is arranged.
export function parseCodeQualifiers(query: string): CodeQualifiers {
  let repo: string | undefined;
  let path: string | undefined;
  const remainder: string[] = [];
  for (const token of tokenize(query)) {
    if (token.startsWith("repo:") && token.length > "repo:".length) {
      repo = token.slice("repo:".length);
    } else if (token.startsWith("path:") && token.length > "path:".length) {
      path = token.slice("path:".length);
    } else {
      remainder.push(token);
    }
  }
  return {
    ...(repo !== undefined ? { repo } : {}),
    ...(path !== undefined ? { path } : {}),
    remainder: remainder.join(" "),
  };
}
