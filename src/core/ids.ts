import { randomUUID } from "node:crypto";

export const newRunId = (): string => `run_${randomUUID()}`;
export const newAgentId = (): string => `agent_${randomUUID()}`;
export const newApprovalId = (): string => `apr_${randomUUID()}`;
export const newToolUseId = (): string => `tool_${randomUUID()}`;
export const newMemoryId = (): string => `mem_${randomUUID()}`;
