import Database from "better-sqlite3";
import { newMemoryId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import type {
  MemoryRecord,
  MemoryStore,
  RecallOptions,
  RecordInput,
} from "./seam.js";

type DB = Database.Database;

// The competent default behind the memory seam: lexical recall via SQLite's
// built-in FTS5 (BM25 ranking), living in the same database file as the spine.
// Provider-agnostic by construction — no embedding service, no network — which
// is why it is the *default* (a provider-coupled semantic tier belongs in a
// swap-in backend). Roadmap: a local-embedding hybrid tier and automatic
// dedupe-on-record can land behind this same class without touching the seam.
//
// Storage is two tables: `memories` holds the durable records; `memories_fts`
// is a standalone FTS5 index over the searchable text. Both are written under
// one transaction on record, so the index never drifts from the records.

const DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  namespace   TEXT NOT NULL,
  content     TEXT NOT NULL,
  kind        TEXT,
  tags        TEXT,            -- JSON string[]
  meta        TEXT,            -- JSON
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_ns ON memories(namespace);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  namespace UNINDEXED,
  content,
  tags
);
`;

const DEFAULT_LIMIT = 8;

interface MemoryRow {
  id: string;
  content: string;
  kind: string | null;
  tags: string | null;
  meta: string | null;
  created_at: string;
  rank: number;
}

/** The SQLite/FTS5 memory store, scoped to one agent's namespace. */
export class SqliteMemory<M = Record<string, unknown>> implements MemoryStore<M> {
  private readonly db: DB;
  private readonly owns: boolean;

  /**
   * Pass a file path to open and own a connection (tests), or an existing
   * better-sqlite3 handle to *borrow* the daemon's shared connection (it is not
   * closed by this store). Either way the FTS schema is ensured on construction.
   */
  constructor(dbOrPath: string | DB, private readonly namespace: string) {
    if (typeof dbOrPath === "string") {
      this.db = new Database(dbOrPath);
      this.owns = true;
      this.db.pragma("journal_mode = WAL");
    } else {
      this.db = dbOrPath;
      this.owns = false;
    }
    this.db.exec(DDL);
  }

  close(): void {
    if (this.owns) this.db.close();
  }

  async record(input: RecordInput<M>): Promise<{ id: string }> {
    const id = newMemoryId();
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (id, namespace, content, kind, tags, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.namespace,
          input.content,
          input.kind ?? null,
          tags,
          input.meta != null ? JSON.stringify(input.meta) : null,
          nowIso(),
        );
      // The FTS row mirrors only what we search on: content + the tag words.
      this.db
        .prepare(
          `INSERT INTO memories_fts (id, namespace, content, tags) VALUES (?, ?, ?, ?)`,
        )
        .run(id, this.namespace, input.content, (input.tags ?? []).join(" "));
    });
    tx();
    return { id };
  }

  async recall(query: string, opts: RecallOptions = {}): Promise<MemoryRecord<M>[]> {
    const match = toFtsQuery(query);
    if (!match) return []; // no usable terms → nothing to rank against

    const limit = opts.limit ?? DEFAULT_LIMIT;
    // Tag filtering is applied in JS (tags are JSON), so over-fetch to keep the
    // post-filter result set full, then slice to the caller's limit.
    const fetch = opts.tags?.length ? Math.max(limit * 5, 50) : limit;

    const rows = this.db
      .prepare(
        `SELECT m.id, m.content, m.kind, m.tags, m.meta, m.created_at,
                bm25(memories_fts) AS rank
         FROM memories_fts f
         JOIN memories m ON m.id = f.id
         WHERE memories_fts MATCH ? AND f.namespace = ?
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(match, this.namespace, fetch) as MemoryRow[];

    let records = rows.map((r) => this.rowToRecord(r));
    if (opts.tags?.length) {
      const want = opts.tags;
      records = records.filter((r) => want.every((t) => r.tags?.includes(t)));
    }
    return records.slice(0, limit);
  }

  private rowToRecord(r: MemoryRow): MemoryRecord<M> {
    return {
      id: r.id,
      content: r.content,
      kind: r.kind ?? undefined,
      tags: r.tags ? (JSON.parse(r.tags) as string[]) : undefined,
      createdAt: r.created_at,
      // bm25 returns lower = better; expose higher = more relevant.
      score: -r.rank,
      meta: r.meta ? (JSON.parse(r.meta) as M) : undefined,
    };
  }
}

/**
 * Turn an arbitrary model-supplied string into a safe FTS5 MATCH expression.
 * Raw queries can carry FTS operators (`"`, `*`, `:`, `-`, AND/OR/NOT) that
 * throw a syntax error, so we extract bare word tokens, quote each as a literal,
 * and OR them — forgiving recall (any term), with BM25 doing the ranking.
 */
function toFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
