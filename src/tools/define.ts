import type { z } from "zod";
import type { ToolContext } from "../core/context.js";

export type { ToolContext };

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: true;
  };
  //? Method declaration (not a property) so parameter checking is bivariant: concrete tool
  //? definitions must stay assignable to ToolDefinition<ZodRawShape> in the tools registry.
  handler(input: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<Record<string, unknown>>;
}

export function defineTool<S extends z.ZodRawShape>(definition: ToolDefinition<S>): ToolDefinition<S> {
  return definition;
}
