import type { ToolDefinition } from "./define.js";
import { rateLimitTool } from "./rate.js";
import { repoTool } from "./repo.js";

export const tools: readonly ToolDefinition[] = [rateLimitTool, repoTool];
