import type { ToolDefinition } from "./define.js";
import { workflowRunTool, workflowRunsTool, workflowsTool } from "./actions.js";
import { apiGetTool } from "./api.js";
import { repoActivityTool } from "./activity.js";
import { branchesTool } from "./branches.js";
import { capabilitiesTool } from "./capabilities.js";
import { commitsTool } from "./commits.js";
import { compareReposTool } from "./compare.js";
import { compareRefsTool } from "./compare-refs.js";
import { contributorsTool } from "./contributors.js";
import { doctorTool } from "./doctor.js";
import { fileGrepTool } from "./file-grep.js";
import { filesBatchTool } from "./files-batch.js";
import { fileTool } from "./file.js";
import { healthTool } from "./health.js";
import { issueTool, issuesTool } from "./issues.js";
import { languagesTool } from "./languages.js";
import { prTool, prsTool } from "./pulls.js";
import { rateLimitTool } from "./rate.js";
import { readmeTool } from "./readme.js";
import { pinTool } from "./pin.js";
import { releaseTool, releasesTool } from "./releases.js";
import { repoTool } from "./repo.js";
import { reposBatchTool } from "./repos-batch.js";
import { searchCodeTool, searchIssuesTool, searchReposTool, searchUsersTool } from "./search.js";
import { stargazersTool } from "./stargazers.js";
import { treeTool } from "./tree.js";
import { trendingTool } from "./trending.js";
import { userHealthTool } from "./user-health.js";
import { userEventsTool, userReposTool, userStarredTool, userTool } from "./user.js";

export const tools: readonly ToolDefinition[] = [
  rateLimitTool,
  repoTool,
  treeTool,
  fileTool,
  fileGrepTool,
  filesBatchTool,
  readmeTool,
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
  searchUsersTool,
  trendingTool,
  workflowsTool,
  workflowRunsTool,
  workflowRunTool,
  apiGetTool,
  healthTool,
  capabilitiesTool,
  pinTool,
  compareReposTool,
  userTool,
  userReposTool,
  userStarredTool,
  userEventsTool,
  userHealthTool,
  languagesTool,
  contributorsTool,
  stargazersTool,
  repoActivityTool,
  reposBatchTool,
  compareRefsTool,
  doctorTool,
];
