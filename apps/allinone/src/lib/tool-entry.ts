import type { ToolConfig } from "./types";

export function isEmbeddedTool(tool: ToolConfig): boolean {
  return (
    tool.lifecycle === "active" &&
    tool.kind === "static" &&
    tool.integration === "path" &&
    tool.openMode === "same-tab" &&
    tool.entry.startsWith("/") &&
    !tool.entry.startsWith("//") &&
    !tool.entry.includes("\\")
  );
}

export function toolHref(tool: ToolConfig): string {
  return tool.lifecycle === "maintenance" || isEmbeddedTool(tool)
    ? `/tools/${tool.id}`
    : tool.entry;
}
