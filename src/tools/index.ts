import type { ToolDefinition } from "./define.js";
import { branchesTool } from "./branches.js";
import { commitsTool } from "./commits.js";
import { fileTool } from "./file.js";
import { issueTool, issuesTool } from "./issues.js";
import { prTool, prsTool } from "./pulls.js";
import { rateLimitTool } from "./rate.js";
import { releaseTool } from "./releases.js";
import { repoTool } from "./repo.js";
import { searchCodeTool, searchIssuesTool, searchReposTool } from "./search.js";
import { treeTool } from "./tree.js";

export const tools: readonly ToolDefinition[] = [
  rateLimitTool,
  repoTool,
  treeTool,
  fileTool,
  commitsTool,
  branchesTool,
  issueTool,
  issuesTool,
  prTool,
  prsTool,
  releaseTool,
  searchReposTool,
  searchCodeTool,
  searchIssuesTool,
];
