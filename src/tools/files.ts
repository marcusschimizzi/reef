import { z } from "zod";
import type { Tool } from "./types.js";

// File tools — reef's first real capability. Every one reaches the filesystem
// only through `ctx.fs` (a path-contained BoundFs), so they physically cannot
// touch anything outside the agent's workspace (reef-docs/06, /08). When the
// broker gains real policy, these tools don't change — only the capability they
// receive does.

export const readFileTool: Tool<{ path: string }> = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace. `path` is relative to the workspace root.",
  inputSchema: z.object({
    path: z.string().describe("Workspace-relative file path"),
  }),
  async run({ path }, ctx) {
    const content = await ctx.fs.read(path);
    return { path, content };
  },
};

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file in the workspace, creating parent directories as needed.",
  inputSchema: z.object({
    path: z.string().describe("Workspace-relative file path"),
    content: z.string().describe("Full file contents to write"),
  }),
  async run({ path, content }, ctx) {
    await ctx.fs.write(path, content);
    return { path, bytes: Buffer.byteLength(content, "utf8") };
  },
};

export const listFilesTool: Tool<{ path?: string }> = {
  name: "list_files",
  description: "List the entries of a workspace directory (defaults to the workspace root).",
  inputSchema: z.object({
    path: z.string().optional().describe("Workspace-relative directory (default: root)"),
  }),
  async run({ path }, ctx) {
    const dir = path ?? ".";
    const entries = await ctx.fs.list(dir);
    return { path: dir, entries };
  },
};

export const editFileTool: Tool<{
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}> = {
  name: "edit_file",
  description:
    "Replace an exact substring in a workspace file. `old_string` must occur exactly once " +
    "unless `replace_all` is true. Prefer a substring with enough surrounding context to be unique.",
  inputSchema: z.object({
    path: z.string(),
    old_string: z.string().describe("Exact text to replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence (default: false)"),
  }),
  async run({ path, old_string, new_string, replace_all }, ctx) {
    const content = await ctx.fs.read(path);
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) {
      throw new Error(`edit_file: old_string not found in ${path}`);
    }
    if (occurrences > 1 && !replace_all) {
      throw new Error(
        `edit_file: old_string occurs ${occurrences} times in ${path}; ` +
          `pass replace_all or include more surrounding context to make it unique`,
      );
    }
    const updated = replace_all
      ? content.split(old_string).join(new_string)
      : content.replace(old_string, new_string);
    await ctx.fs.write(path, updated);
    return { path, replacements: replace_all ? occurrences : 1 };
  },
};

export const fileTools: Tool[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  editFileTool,
];
