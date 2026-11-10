import type { ToolDefinition } from "./define.js";
import { workflowRunTool, workflowRunsTool, workflowsTool } from "./actions.js";
import { apiGetTool } from "./api.js";
import { branchesTool } from "./branches.js";
import { capabilitiesTool } from "./capabilities.js";
import { commitsTool } from "./commits.js";
import { compareReposTool } from "./compare.js";
import { contributorsTool } from "./contributors.js";
import { fileTool } from "./file.js";
import { healthTool } from "./health.js";
import { issueTool, issuesTool } from "./issues.js";
import { languagesTool } from "./languages.js";
import { prTool, prsTool } from "./pulls.js";
import { rateLimitTool } from "./rate.js";
import { releaseTool, releasesTool } from "./releases.js";
import { repoTool } from "./repo.js";
import { searchCodeTool, searchIssuesTool, searchReposTool } from "./search.js";
import { treeTool } from "./tree.js";
import { userEventsTool, userReposTool, userStarredTool, userTool } from "./user.js";

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
  releasesTool,
  searchReposTool,
  searchCodeTool,
  searchIssuesTool,
  workflowsTool,
  workflowRunsTool,
  workflowRunTool,
  apiGetTool,
  healthTool,
  capabilitiesTool,
  compareReposTool,
  userTool,
  userReposTool,
  userStarredTool,
  userEventsTool,
  languagesTool,
  contributorsTool,
];
