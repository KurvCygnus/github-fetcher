import { describe, expect, it } from "vitest";
import { usageFor } from "../../src/cli/subcommands.js";

describe("usageFor", () => {
  it("names the init wizard in the top-level help without the deleted TUI", () => {
    const help = usageFor(undefined);
    expect(help).toContain("configure MCP clients interactively (wizard; --client/--all/--dry-run)");
    expect(help).not.toContain("TUI");
  });
});
