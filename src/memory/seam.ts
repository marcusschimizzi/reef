// The memory seam (reef-docs/07). Memory is reef's *cross-session* knowledge
// tier — deliberate, durable facts the agent carries from one conversation into
// another (the opposite vector from compaction, which forgets within a session).
//
// The contract is deliberately the lowest common denominator every retrieval
// model satisfies: `recall` takes a FREE-TEXT query and returns a ranked list.
// A lexical backend ranks by term overlap; a semantic/hybrid one ranks better; a
// graph one treats the query as an entry point and flattens a neighbourhood.
// Structure a richer backend needs (links, scopes, embeddings refs) rides in the
// generic `meta` rather than becoming query parameters reef has to understand.
//
// Phase 3d ships mechanism A: `recall`/`record` are model-driven tools (see
// tools/memory.ts). The `primer` hook below is the seam left open for the
// eventual hybrid end-state — a provider that wants to inject always-on context.
// The default omits it; the loop ignores it until we wire cache-stable injection.

/** A single remembered item. Generic in `meta` so a backend types its extras. */
export interface MemoryRecord<M = Record<string, unknown>> {
  id: string;
  /** The memory as text — the one field every backend must populate. */
  content: string;
  /** Backend-defined category, e.g. "preference" | "fact" | "decision". */
  kind?: string;
  /** Backend-defined labels; the default supports filtering recall by them. */
  tags?: string[];
  createdAt: string;
  /** Recall relevance, backend-assigned (higher = more relevant). Unset for non-recall reads. */
  score?: number;
  meta?: M;
}

export interface RecordInput<M = Record<string, unknown>> {
  content: string;
  kind?: string;
  tags?: string[];
  meta?: M;
}

export interface RecallOptions {
  /** Max results (the backend's competent default applies if omitted). */
  limit?: number;
  /** If set, only memories carrying *all* of these tags are returned. */
  tags?: string[];
}

/**
 * The seam the loop and the memory tools depend on. One instance is bound to one
 * agent (its namespace), so adding agents later cannot leak memory between them.
 * Implementations: the SQLite/FTS5 default (sqlite.ts); a user's hybrid backend
 * is the second, dropped in behind this same interface.
 */
export interface MemoryStore<M = Record<string, unknown>> {
  record(input: RecordInput<M>): Promise<{ id: string }>;
  recall(query: string, opts?: RecallOptions): Promise<MemoryRecord<M>[]>;
  /**
   * Hybrid-end-state hook: memories the backend wants always available, returned
   * for the loop to inject at a cache-stable point. Optional — the default does
   * not implement it, and the loop does not yet call it (Phase 3d ships tools
   * only). Present in the contract now so adding it needs no reshaping.
   */
  primer?(): Promise<MemoryRecord<M>[]>;
}
