import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../../src/core/version.js";
import { runEntry } from "../../src/cli/entry.js";

function stream(): NodeJS.WritableStream & { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() } as unknown as NodeJS.WritableStream & { write: ReturnType<typeof vi.fn> };
}

describe("cli entry", () => {
  it("prints the version for --version", async () => {
    const stdout = stream();
    const stderr = stream();
    await expect(runEntry(["--version"], { stdout, stderr })).resolves.toBe(0);
    expect(stdout.write).toHaveBeenCalledWith(`${VERSION}\n`);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("prints the version for -v", async () => {
    const stdout = stream();
    await expect(runEntry(["-v"], { stdout, stderr: stream() })).resolves.toBe(0);
    expect(stdout.write).toHaveBeenCalledWith(`${VERSION}\n`);
  });

  it("prints usage for --help", async () => {
    const stdout = stream();
    await expect(runEntry(["--help"], { stdout, stderr: stream() })).resolves.toBe(0);
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it("documents arg shapes and the arg-shape legend in top-level help", async () => {
    const stdout = stream();
    await expect(runEntry(["--help"], { stdout, stderr: stream() })).resolves.toBe(0);
    const help = stdout.write.mock.calls[0]?.[0] as string;
    expect(help).toContain("<angle brackets> = required positional");
    expect(help).toContain("[square brackets] = optional positional");
    expect(help).toContain("--flag value = value flag");
    expect(help).toContain("bare --flag = boolean");
    expect(help).toContain("github_capabilities lists every subcommand with its input signature.");
    expect(help).toContain("github_repo  <repo> --fresh");
    expect(help).toContain("github_rate_limit  --resource|--all");
  });

  it("rejects an unknown subcommand with exit code 2", async () => {
    const stderr = stream();
    await expect(runEntry(["nope"], { stdout: stream(), stderr })).resolves.toBe(2);
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });
});
