import type { FlagKind, SubcommandSpec } from "./subcommands.js";

export class CliUsageError extends Error {}

export interface ParsedArgs {
  input: Record<string, unknown>;
  pretty: boolean;
  help: boolean;
}

function convertValue(kind: FlagKind, raw: string): unknown {
  if (kind === "number") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new CliUsageError(`expected a number: ${raw}`);
    return parsed;
  }
  if (kind === "string-array") {
    return raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  }
  return raw;
}

//? Flags are kebab-case on the command line but snake_case keys in the tool schemas.
function toInputKey(flag: string): string {
  return flag.replace(/-/g, "_");
}

export function parseArgs(spec: SubcommandSpec, tokens: readonly string[]): ParsedArgs {
  const input: Record<string, unknown> = {};
  let pretty = false;
  let help = false;
  let positionalIndex = 0;

  for (let index = 0; index < tokens.length; index++) {
    //? The loop bound guarantees the token exists; noUncheckedIndexedAccess cannot see it.
    const token = tokens[index] as string;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--pretty") {
      pretty = true;
      continue;
    }
    if (!token.startsWith("--")) {
      const slot = spec.positional[positionalIndex];
      if (!slot) throw new CliUsageError(`unexpected argument: ${token}`);
      input[slot.key] = convertValue(slot.kind, token);
      positionalIndex += 1;
      continue;
    }
    const flag = token.slice(2);
    const kind = spec.flags[flag];
    if (kind === undefined) throw new CliUsageError(`unknown flag: ${token}`);
    if (kind === "boolean") {
      input[toInputKey(flag)] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`flag --${flag} requires a value`);
    }
    input[toInputKey(flag)] = convertValue(kind, value);
    index += 1;
  }

  //? positionalIndex only advances past existing slots, so "past the last one" means
  //? every required positional was filled; an in-range index means this slot is missing.
  const missing = spec.positional[positionalIndex];
  if (missing !== undefined) {
    throw new CliUsageError(`missing required argument: ${missing.key}`);
  }
  return { input, pretty, help };
}
