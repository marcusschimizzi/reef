// Centralized clock. Kept in one place so it can later be made injectable for
// deterministic tests and session replay (reef-docs/10: the eval/replay story).

export const nowIso = (): string => new Date().toISOString();
export const nowMs = (): number => Date.now();
