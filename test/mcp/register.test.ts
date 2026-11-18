import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GithubError } from "../../src/core/errors.js";
import type { GitHubApi } from "../../src/core/github.js";
import type { ToolContext } from "../../src/core/context.js";
import { registerTools } from "../../src/mcp/register.js";
import { defineTool } from "../../src/tools/define.js";
import { makeConfig } from "../helpers.js";

interface CapturedTool {
  name: string;
  config: CapturedConfig;
  run(input: unknown): Promise<CallToolResult>;
}

//? Mirrors the config shape registerTools passes through, so the passthrough
//? assertions read the captured values directly instead of re-casting per test.
interface CapturedConfig {
  title: string;
  description: string;
  inputSchema: unknown;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

//? The wiring only touches McpServer.registerTool, so the double captures the
//? handler callback and the registered config per tool name and is asserted to
//? the parameter types; tests then drive the real success/failure paths through
//? the registered callback and pin the config passthrough.
function serverDouble(): { captured: CapturedTool[]; server: McpServer } {
  const captured: CapturedTool[] = [];
  const server = {
    registerTool(
      name: string,
      config: CapturedConfig,
      cb: (input: unknown) => Promise<CallToolResult>,
    ): void {
      captured.push({ name, config, run: cb });
    },
  };
  return { captured, server: server as unknown as McpServer };
}

const okTool = defineTool({
  name: "test_ok",
  title: "Test OK",
  description: "Resolves with fixed data.",
  //? Non-trivial on purpose: one required string plus one optional number, so
  //? the config passthrough deep-equal on inputSchema bites on real schemas; a
  //? passthrough regression that only mangles non-empty schemas cannot slip.
  inputSchema: { name: z.string(), count: z.number().optional() },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async () => ({ value: 42, nested: { ok: true } }),
});

const failTool = defineTool({
  name: "test_fail",
  title: "Test Fail",
  description: "Rejects with a known GithubError.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async () => {
    throw new GithubError("rate_limited", "slow down", { remaining: 0 });
  },
});

function testCtx(): ToolContext {
  //? A concrete literal cannot satisfy the generic api<T> signature (same
  //! compromise as the tool tests); the handlers here never touch the client.
  const client = {} as unknown as GitHubApi;
  return { client, config: makeConfig(), authFingerprint: "abc" };
}

describe("registerTools transport shape", () => {
  it("returns a successful result with empty content and the data as structuredContent", async () => {
    const { captured, server } = serverDouble();
    registerTools(server, [okTool], testCtx());
    const tool = captured.find((entry) => entry.name === "test_ok");
    expect(tool).toBeDefined();

    const result = await (tool as CapturedTool).run({});
    //? toEqual is exact: the legacy text item the old double render emitted
    //? inside content would fail this assertion, not just pass on structuredContent.
    expect(result).toEqual({
      content: [],
      structuredContent: { value: 42, nested: { ok: true } },
    });
  });

  it("returns a failing result with empty content, isError, and the error result as structuredContent", async () => {
    const { captured, server } = serverDouble();
    registerTools(server, [failTool], testCtx());
    const tool = captured.find((entry) => entry.name === "test_fail");
    expect(tool).toBeDefined();

    const result = await (tool as CapturedTool).run({});
    expect(result).toEqual({
      content: [],
      isError: true,
      structuredContent: {
        error: { code: "rate_limited", message: "slow down", remaining: 0 },
      },
    });
  });

  it("pins the registered config: annotations and inputSchema pass through unchanged", () => {
    const { captured, server } = serverDouble();
    registerTools(server, [okTool], testCtx());
    const found = captured.find((entry) => entry.name === "test_ok");
    expect(found).toBeDefined();
    const tool = found as CapturedTool;

    //? registerTools copies each config key by hand, so a key silently dropped
    //* from that spread (readOnlyHint drives client-side confirmation prompts)
    //* would ship unnoticed; both keys are pinned exactly as the tool defined.
    expect(tool.config.annotations.readOnlyHint).toBe(true);
    expect(tool.config.inputSchema).toEqual(okTool.inputSchema);
  });
});
