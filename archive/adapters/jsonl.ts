import { makeEvent } from "../events.js";
import type { AgentEvent } from "../types.js";

export type JsonlMapper = (payload: Record<string, unknown>) => AgentEvent;

export async function* parseJsonLines(
  stream: NodeJS.ReadableStream,
  mapPayload: JsonlMapper
): AsyncIterable<AgentEvent> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          const payload = JSON.parse(line) as Record<string, unknown>;
          yield mapPayload(payload);
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown parse error";
          yield makeEvent("error", "", { message, line });
        }
      }
      index = buffer.indexOf("\n");
    }
  }
}
