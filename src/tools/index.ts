import type { ToolDefinition } from "./define.js";
import { fileTool } from "./file.js";
import { rateLimitTool } from "./rate.js";
import { repoTool } from "./repo.js";
import { treeTool } from "./tree.js";

export const tools: readonly ToolDefinition[] = [rateLimitTool, repoTool, treeTool, fileTool];
