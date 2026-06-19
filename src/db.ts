import Database from "libsql";
import path from "path";
import fs from "fs";
import type { NodeRow, EdgeRow, NodeStatus } from "./types.js";

const SCHEMA_VERSION = 5;

export class KnowledgeDB {
  private db: Database.Database;
  private _txDepth = 0;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private getUserVersion(): number {
    const pragmaResult = this.db.pragma("user_version", { simple: true });
    // libsql returns { user_version: N } instead of raw N like better-sqlite3
    return (
      typeof pragmaResult === "object" && pragmaResult !== null
        ? (pragmaResult as Record<string, unknown>).user_version
        : pragmaResult
    ) as number;
  }

  private migrate(): void {
    const version = this.getUserVersion();
    if (version >= SCHEMA_VERSION) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check after acquiring the write lock in case another process migrated first.
      const currentVersion = this.getUserVersion();
      if (currentVersion >= SCHEMA_VERSION) {
        this.db.exec("COMMIT");
        return;
      }

      if (currentVersion < 1) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS nodes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            summary TEXT NOT NULL,
            why TEXT,
            file_refs TEXT,
            parent_id TEXT,
            created_by_task TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            removed_at TEXT,
            removed_reason TEXT,
            embedding BLOB,
            merge_group TEXT,
            needs_merge INTEGER DEFAULT 0,
            source_branch TEXT,
            merge_timestamp TEXT,
            FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE SET NULL
          );

          CREATE TABLE IF NOT EXISTS edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            relation TEXT NOT NULL,
            description TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            merge_group TEXT,
            needs_merge INTEGER DEFAULT 0,
            source_branch TEXT,
            merge_timestamp TEXT,
            FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
            FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
          CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
          CREATE INDEX IF NOT EXISTS idx_nodes_removed ON nodes(removed_at);
          CREATE INDEX IF NOT EXISTS idx_nodes_merge_group ON nodes(merge_group);
          CREATE INDEX IF NOT EXISTS idx_nodes_needs_merge ON nodes(needs_merge);
          CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
          CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
          CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
          CREATE INDEX IF NOT EXISTS idx_edges_merge_group ON edges(merge_group);
          CREATE INDEX IF NOT EXISTS idx_edges_needs_merge ON edges(needs_merge);
        `);
      }

      if (currentVersion < 2) {
        // Add merge-related columns for existing v1 databases
        const nodeColumns = this.db
          .prepare("PRAGMA table_info(nodes)")
          .all() as Array<{ name: string }>;
        const nodeColNames = new Set(nodeColumns.map((c) => c.name));

        if (!nodeColNames.has("merge_group")) {
          this.db.exec(`
            ALTER TABLE nodes ADD COLUMN merge_group TEXT;
            ALTER TABLE nodes ADD COLUMN needs_merge INTEGER DEFAULT 0;
            ALTER TABLE nodes ADD COLUMN source_branch TEXT;
            ALTER TABLE nodes ADD COLUMN merge_timestamp TEXT;
            CREATE INDEX IF NOT EXISTS idx_nodes_merge_group ON nodes(merge_group);
            CREATE INDEX IF NOT EXISTS idx_nodes_needs_merge ON nodes(needs_merge);
          `);
        }

        const edgeColumns = this.db
          .prepare("PRAGMA table_info(edges)")
          .all() as Array<{ name: string }>;
        const edgeColNames = new Set(edgeColumns.map((c) => c.name));

        if (!edgeColNames.has("merge_group")) {
          this.db.exec(`
            ALTER TABLE edges ADD COLUMN merge_group TEXT;
            ALTER TABLE edges ADD COLUMN needs_merge INTEGER DEFAULT 0;
            ALTER TABLE edges ADD COLUMN source_branch TEXT;
            ALTER TABLE edges ADD COLUMN merge_timestamp TEXT;
            CREATE INDEX IF NOT EXISTS idx_edges_merge_group ON edges(merge_group);
            CREATE INDEX IF NOT EXISTS idx_edges_needs_merge ON edges(needs_merge);
          `);
        }
      }

      if (currentVersion < 3) {
        // Add timeline table for version 3
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS timeline (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT DEFAULT (datetime('now')),
            tool TEXT NOT NULL,
            params TEXT NOT NULL,
            result_summary TEXT NOT NULL,
            is_write INTEGER NOT NULL,
            is_error INTEGER NOT NULL,
            affected_ids TEXT NOT NULL
          );
          
          CREATE INDEX IF NOT EXISTS idx_timeline_timestamp ON timeline(timestamp);
          CREATE INDEX IF NOT EXISTS idx_timeline_tool ON timeline(tool);
          CREATE INDEX IF NOT EXISTS idx_timeline_is_write ON timeline(is_write);
          CREATE INDEX IF NOT EXISTS idx_timeline_is_error ON timeline(is_error);
        `);
      }

      if (currentVersion < 4) {
        this.db.exec(`
          DELETE FROM edges
          WHERE id NOT IN (
            SELECT MIN(id)
            FROM edges
            GROUP BY from_id, to_id, relation
          )
        `);
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
          ON edges(from_id, to_id, relation)
        `);
      }

      if (currentVersion < 5) {
        // Evidential provenance (design §2.2/§2.3/§3.1):
        //   - nodes.status: node epistemic status (nullable, NO DEFAULT — NULL = legacy/unknown)
        //   - edges.removed_at: edge tombstone column so node removal preserves lineage
        // Both ALTERs are additive and idempotent (guarded by a column-presence check),
        // running inside the existing BEGIN IMMEDIATE + post-lock re-check above.
        const nodeColumns = this.db
          .prepare("PRAGMA table_info(nodes)")
          .all() as Array<{ name: string }>;
        const nodeColNames = new Set(nodeColumns.map((c) => c.name));
        if (!nodeColNames.has("status")) {
          this.db.exec("ALTER TABLE nodes ADD COLUMN status TEXT");
        }

        const edgeColumns = this.db
          .prepare("PRAGMA table_info(edges)")
          .all() as Array<{ name: string }>;
        const edgeColNames = new Set(edgeColumns.map((c) => c.name));
        if (!edgeColNames.has("removed_at")) {
          this.db.exec(
            "ALTER TABLE edges ADD COLUMN removed_at TEXT;" +
              "CREATE INDEX IF NOT EXISTS idx_edges_removed ON edges(removed_at);"
          );
        }
      }

      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  runInTransaction<T>(fn: () => T): T {
    if (this._txDepth > 0) {
      // Already inside a transaction — just run the function
      this._txDepth++;
      try {
        return fn();
      } finally {
        this._txDepth--;
      }
    }

    this._txDepth++;
    try {
      return this.runWithRetry(() => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const result = fn();
          this.db.exec("COMMIT");
          return result;
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
      });
    } finally {
      this._txDepth--;
    }
  }

  runWithRetry<T>(fn: () => T, maxRetries = 3): T {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (err: unknown) {
        const isBusy =
          err instanceof Error &&
          (err.message.includes("SQLITE_BUSY") ||
            err.message.includes("database is locked"));
        if (!isBusy || attempt >= maxRetries) {
          throw err;
        }
        const delayMs = 50 * Math.pow(2, attempt);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      }
    }
  }

  // ---- Node CRUD ----

  insertNode(node: {
    id: string;
    name: string;
    kind: string;
    summary: string;
    why?: string | null;
    file_refs?: string[] | null;
    parent_id?: string | null;
    created_by_task?: string | null;
    embedding?: Buffer | null;
    status?: NodeStatus | null;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, kind, summary, why, file_refs, parent_id, created_by_task, embedding, status)
      VALUES (@id, @name, @kind, @summary, @why, @file_refs, @parent_id, @created_by_task, @embedding, @status)
    `);
    stmt.run({
      id: node.id,
      name: node.name,
      kind: node.kind,
      summary: node.summary,
      why: node.why ?? null,
      file_refs: node.file_refs ? JSON.stringify(node.file_refs) : null,
      parent_id: node.parent_id ?? null,
      created_by_task: node.created_by_task ?? null,
      embedding: node.embedding ?? null,
      status: node.status ?? null,
    });
  }

  insertNodeAndEdges(
    node: {
      id: string;
      name: string;
      kind: string;
      summary: string;
      why: string | null;
      file_refs: string | null;
      parent_id: string | null;
      created_by_task: string | null;
      embedding: Buffer | null;
      status?: NodeStatus | null;
    },
    edges: Array<{ to_id: string; relation: string; description: string | null }>
  ): void {
    this.runInTransaction(() => {
      this.insertNode({
        id: node.id,
        name: node.name,
        kind: node.kind,
        summary: node.summary,
        why: node.why,
        file_refs: node.file_refs
          ? (JSON.parse(node.file_refs) as string[])
          : null,
        parent_id: node.parent_id,
        created_by_task: node.created_by_task,
        embedding: node.embedding,
        status: node.status,
      });

      for (const edge of edges) {
        if (this.nodeExists(edge.to_id)) {
          this.insertEdge({
            from_id: node.id,
            to_id: edge.to_id,
            relation: edge.relation,
            description: edge.description,
          });
        }
      }
    });
  }

  getNode(id: string): NodeRow | undefined {
    return this.db
      .prepare("SELECT * FROM nodes WHERE id = ? AND removed_at IS NULL")
      .get(id) as NodeRow | undefined;
  }

  getNodeIncludingRemoved(id: string): NodeRow | undefined {
    return this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
      | NodeRow
      | undefined;
  }

  updateNode(
    id: string,
    changes: {
      name?: string;
      kind?: string;
      summary?: string;
      why?: string;
      file_refs?: string[];
      embedding?: Buffer;
      status?: NodeStatus;
    }
  ): boolean {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (changes.name !== undefined) {
      fields.push("name = @name");
      values.name = changes.name;
    }
    if (changes.kind !== undefined) {
      fields.push("kind = @kind");
      values.kind = changes.kind;
    }
    if (changes.summary !== undefined) {
      fields.push("summary = @summary");
      values.summary = changes.summary;
    }
    if (changes.why !== undefined) {
      fields.push("why = @why");
      values.why = changes.why;
    }
    if (changes.file_refs !== undefined) {
      fields.push("file_refs = @file_refs");
      values.file_refs = JSON.stringify(changes.file_refs);
    }
    if (changes.embedding !== undefined) {
      fields.push("embedding = @embedding");
      values.embedding = changes.embedding;
    }
    if (changes.status !== undefined) {
      fields.push("status = @status");
      values.status = changes.status;
    }

    if (fields.length === 0) return false;

    fields.push("updated_at = datetime('now')");

    const stmt = this.db.prepare(
      `UPDATE nodes SET ${fields.join(", ")} WHERE id = @id AND removed_at IS NULL`
    );
    const result = stmt.run(values);
    return result.changes > 0;
  }

  softDeleteNode(id: string, reason: string): boolean {
    let changed = false;
    this.runInTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE nodes SET removed_at = datetime('now'), removed_reason = @reason, updated_at = datetime('now')
        WHERE id = @id AND removed_at IS NULL
      `);
      const result = stmt.run({ id, reason });

      if (result.changes > 0) {
        changed = true;
        // Tombstone (not physically delete) incident edges so provenance lineage
        // is preserved (design §2.3). Normal reads filter removed_at IS NULL.
        this.db
          .prepare(
            "UPDATE edges SET removed_at = datetime('now') WHERE (from_id = ? OR to_id = ?) AND removed_at IS NULL"
          )
          .run(id, id);
      }
    });
    return changed;
  }

  // ---- Edge CRUD ----

  insertEdge(edge: {
    from_id: string;
    to_id: string;
    relation: string;
    description?: string | null;
  }): { id: number; inserted: boolean } {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO edges (from_id, to_id, relation, description)
      VALUES (@from_id, @to_id, @relation, @description)
    `);
    const result = stmt.run({
      from_id: edge.from_id,
      to_id: edge.to_id,
      relation: edge.relation,
      description: edge.description ?? null,
    });
    return {
      id: Number(result.lastInsertRowid),
      inserted: result.changes > 0,
    };
  }

  deleteEdge(fromId: string, toId: string, relation: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM edges WHERE from_id = ? AND to_id = ? AND relation = ?"
      )
      .run(fromId, toId, relation);
    return result.changes > 0;
  }

  // ---- Query methods ----

  getChildren(parentId: string): NodeRow[] {
    return this.db
      .prepare(
        "SELECT * FROM nodes WHERE parent_id = ? AND removed_at IS NULL"
      )
      .all(parentId) as NodeRow[];
  }

  getOutgoingEdges(
    nodeId: string
  ): Array<EdgeRow & { to_name: string; to_summary: string }> {
    return this.db
      .prepare(
        `
      SELECT e.*, n.name as to_name, n.summary as to_summary
      FROM edges e
      JOIN nodes n ON e.to_id = n.id
      WHERE e.from_id = ? AND n.removed_at IS NULL AND e.removed_at IS NULL
    `
      )
      .all(nodeId) as Array<EdgeRow & { to_name: string; to_summary: string }>;
  }

  getIncomingEdges(
    nodeId: string
  ): Array<EdgeRow & { from_name: string; from_summary: string }> {
    return this.db
      .prepare(
        `
      SELECT e.*, n.name as from_name, n.summary as from_summary
      FROM edges e
      JOIN nodes n ON e.from_id = n.id
      WHERE e.to_id = ? AND n.removed_at IS NULL AND e.removed_at IS NULL
    `
      )
      .all(nodeId) as Array<
      EdgeRow & { from_name: string; from_summary: string }
    >;
  }

  getParent(parentId: string): NodeRow | undefined {
    return this.db
      .prepare("SELECT * FROM nodes WHERE id = ? AND removed_at IS NULL")
      .get(parentId) as NodeRow | undefined;
  }

  getRootNodes(): NodeRow[] {
    return this.db
      .prepare(
        "SELECT * FROM nodes WHERE parent_id IS NULL AND removed_at IS NULL ORDER BY name"
      )
      .all() as NodeRow[];
  }

  getAllActiveNodesWithEmbeddings(): Array<{
    id: string;
    name: string;
    kind: string;
    summary: string;
    embedding: Buffer | null;
  }> {
    const rows = this.db
      .prepare(
        "SELECT id, name, kind, summary, embedding FROM nodes WHERE removed_at IS NULL AND embedding IS NOT NULL"
      )
      .all() as Array<any>;
    
    return rows.map((row) => ({
      ...row,
      embedding: row.embedding ? Buffer.from(row.embedding) : null
    }));
  }

  nodeExists(id: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM nodes WHERE id = ? AND removed_at IS NULL"
      )
      .get(id);
    return row !== undefined;
  }

  // ---- Web API query methods ----

  getAllActiveNodes(): Array<Omit<NodeRow, "embedding">> {
    return this.db
      .prepare(
        `SELECT id, name, kind, summary, why, file_refs, parent_id,
                created_by_task, created_at, updated_at, removed_at, removed_reason
         FROM nodes WHERE removed_at IS NULL ORDER BY name`
      )
      .all() as Array<Omit<NodeRow, "embedding">>;
  }

  getAllEdges(): EdgeRow[] {
    return this.db
      .prepare(
        `SELECT e.*
         FROM edges e
         JOIN nodes n1 ON e.from_id = n1.id
         JOIN nodes n2 ON e.to_id = n2.id
         WHERE n1.removed_at IS NULL AND n2.removed_at IS NULL AND e.removed_at IS NULL`
      )
      .all() as EdgeRow[];
  }

  getKindsBreakdown(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT kind, COUNT(*) as count FROM nodes WHERE removed_at IS NULL GROUP BY kind"
      )
      .all() as Array<{ kind: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.kind] = row.count;
    }
    return result;
  }

  getStats(): { nodes: number; edges: number; removed: number } {
    const nodes = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM nodes WHERE removed_at IS NULL")
        .get() as { count: number }
    ).count;
    const edges = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM edges WHERE removed_at IS NULL")
        .get() as {
        count: number;
      }
    ).count;
    const removed = (
      this.db
        .prepare(
          "SELECT COUNT(*) as count FROM nodes WHERE removed_at IS NOT NULL"
        )
        .get() as { count: number }
    ).count;
    return { nodes, edges, removed };
  }

  // ---- Merge-related methods ----

  getConflictNodes(): NodeRow[] {
    // Don't filter by removed_at — removal conflicts are valid (one side removed, other didn't)
    return this.db
      .prepare("SELECT * FROM nodes WHERE needs_merge = 1")
      .all() as NodeRow[];
  }

  getConflictEdges(): EdgeRow[] {
    return this.db
      .prepare("SELECT * FROM edges WHERE needs_merge = 1")
      .all() as EdgeRow[];
  }

  getNodesByMergeGroup(mergeGroup: string): NodeRow[] {
    return this.db
      .prepare("SELECT * FROM nodes WHERE merge_group = ?")
      .all(mergeGroup) as NodeRow[];
  }

  getEdgesByMergeGroup(mergeGroup: string): EdgeRow[] {
    return this.db
      .prepare("SELECT * FROM edges WHERE merge_group = ?")
      .all(mergeGroup) as EdgeRow[];
  }

  clearNodeMergeFlags(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE nodes SET merge_group = NULL, needs_merge = 0, source_branch = NULL,
         merge_timestamp = NULL, updated_at = datetime('now') WHERE id = ?`
      )
      .run(id);
    return result.changes > 0;
  }

  clearEdgeMergeFlagsByGroup(mergeGroup: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE edges SET merge_group = NULL, needs_merge = 0, source_branch = NULL,
         merge_timestamp = NULL WHERE merge_group = ?`
      )
      .run(mergeGroup);
    return result.changes > 0;
  }

  renameNodeId(oldId: string, newId: string): boolean {
    // Temporarily disable foreign keys for the rename operation,
    // since self-referencing FKs (parent_id → id) would block the update.
    // Wrapped in a transaction so all 4 updates succeed or none do.
    this.db.pragma("foreign_keys = OFF");
    try {
      let changed = false;
      this.runInTransaction(() => {
        const result = this.db
          .prepare("UPDATE nodes SET id = @newId, updated_at = datetime('now') WHERE id = @oldId")
          .run({ oldId, newId });

        if (result.changes > 0) {
          changed = true;
          // Update parent_id references in children
          this.db
            .prepare("UPDATE nodes SET parent_id = @newId WHERE parent_id = @oldId")
            .run({ oldId, newId });
          // Update edge references
          this.db
            .prepare("UPDATE edges SET from_id = @newId WHERE from_id = @oldId")
            .run({ oldId, newId });
          this.db
            .prepare("UPDATE edges SET to_id = @newId WHERE to_id = @oldId")
            .run({ oldId, newId });
        }
      });
      return changed;
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  getAllNodesRaw(): NodeRow[] {
    return this.db.prepare("SELECT * FROM nodes").all() as NodeRow[];
  }

  getAllEdgesRaw(): EdgeRow[] {
    return this.db.prepare("SELECT * FROM edges").all() as EdgeRow[];
  }

  // ---- Provenance (informed_by) traversal reads ----

  /**
   * One-hop `informed_by` adjacency for a frontier of node ids (design §5.1, B3).
   *
   * - `direction: "upstream"`  → out-edges (from_id IN ids): ancestry/reasoning lineage.
   * - `direction: "downstream"`→ in-edges  (to_id IN ids):   impact/blast radius.
   *
   * Only the `informed_by` projection is traversed; `parent_id` and other relations
   * are never followed. The result is a flat, referentially-closed adjacency: every
   * node referenced by a returned edge is present in `nodes` (never a dangling edge).
   *
   * `includeRemoved=false` (default): only active edges between active nodes.
   * `includeRemoved=true` (retrospective): tombstoned edges are included and a
   * tombstoned/removed endpoint node is returned as a stub so closure is preserved.
   */
  getProvenanceEdges(
    ids: string[],
    opts: { direction: "upstream" | "downstream"; includeRemoved?: boolean }
  ): { nodes: NodeRow[]; edges: EdgeRow[] } {
    if (ids.length === 0) return { nodes: [], edges: [] };

    const includeRemoved = opts.includeRemoved ?? false;
    const anchorCol = opts.direction === "upstream" ? "from_id" : "to_id";
    const idPlaceholders = ids.map(() => "?").join(",");
    const edgeRemovedFilter = includeRemoved ? "" : " AND removed_at IS NULL";

    const candidateEdges = this.db
      .prepare(
        `SELECT * FROM edges WHERE relation = 'informed_by' AND ${anchorCol} IN (${idPlaceholders})${edgeRemovedFilter}`
      )
      .all(...ids) as EdgeRow[];

    if (candidateEdges.length === 0) return { nodes: [], edges: [] };

    // Resolve every referenced endpoint node (both ends) for referential closure.
    const referenced = new Set<string>();
    for (const e of candidateEdges) {
      referenced.add(e.from_id);
      referenced.add(e.to_id);
    }
    const refIds = [...referenced];
    const nodePlaceholders = refIds.map(() => "?").join(",");
    const nodeRemovedFilter = includeRemoved ? "" : " AND removed_at IS NULL";
    const nodes = this.db
      .prepare(
        `SELECT * FROM nodes WHERE id IN (${nodePlaceholders})${nodeRemovedFilter}`
      )
      .all(...refIds) as NodeRow[];

    // Drop any edge whose endpoint was filtered out — never emit a dangling edge.
    const resolved = new Set(nodes.map((n) => n.id));
    const edges = candidateEdges.filter(
      (e) => resolved.has(e.from_id) && resolved.has(e.to_id)
    );

    // Keep only nodes still referenced by a surviving edge.
    const survivingRefs = new Set<string>();
    for (const e of edges) {
      survivingRefs.add(e.from_id);
      survivingRefs.add(e.to_id);
    }
    return {
      nodes: nodes.filter((n) => survivingRefs.has(n.id)),
      edges,
    };
  }

  /**
   * True if `to` is reachable from `from` by following active `informed_by`
   * out-edges (`from` → ... → `to`). Other relations and tombstoned edges are
   * never traversed; `parent_id` is excluded. The visited set makes traversal
   * safe against legacy/corrupt cycles; a self-path is only reported when a real
   * cycle leads back to `from`.
   */
  informedByReaches(from: string, to: string): boolean {
    const stmt = this.db.prepare(
      "SELECT to_id FROM edges WHERE from_id = ? AND relation = 'informed_by' AND removed_at IS NULL"
    );
    const visited = new Set<string>();
    const stack: string[] = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const outs = stmt.all(cur) as Array<{ to_id: string }>;
      for (const { to_id } of outs) {
        if (to_id === to) return true;
        if (!visited.has(to_id)) {
          visited.add(to_id);
          stack.push(to_id);
        }
      }
    }
    return false;
  }

  /**
   * True if adding `from informed_by to` would violate the strict `informed_by`
   * DAG invariant (§2.1): a self-loop (`from === to`), or an existing active
   * `informed_by` path `to` → ... → `from` that the new edge would close.
   */
  wouldCreateCycle(from: string, to: string): boolean {
    if (from === to) return true;
    return this.informedByReaches(to, from);
  }

  /**
   * Read-time epistemic-participation guard for remove_concept (design §4.4).
   * A node is epistemically protected (must not be silently removed) if ANY of:
   *   - it has a non-null `status` (an epistemic record);
   *   - `kind === 'decision'` (legacy fallback before status existed);
   *   - it has an active incoming `informed_by` edge (evidence depended upon);
   *   - it is a legacy `status IS NULL` node with an active outgoing `informed_by`
   *     edge (a legacy conclusion/result that has ancestry);
   *   - it is an endpoint (either direction) of an active `contradicts`/`supersedes`
   *     discourse edge.
   * All edge lookups require `removed_at IS NULL`. `reasons` lists the stable
   * identifiers of every condition that matched (empty ⇒ not protected).
   */
  isEpistemicallyProtected(id: string): {
    protected: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];
    const node = this.getNodeIncludingRemoved(id);
    if (!node) return { protected: false, reasons };

    if (node.status !== null && node.status !== undefined) {
      reasons.push("status_set");
    }
    if (node.kind === "decision") {
      reasons.push("decision_kind");
    }

    const incomingInformedBy = this.db
      .prepare(
        "SELECT 1 FROM edges WHERE to_id = ? AND relation = 'informed_by' AND removed_at IS NULL LIMIT 1"
      )
      .get(id);
    if (incomingInformedBy) reasons.push("incoming_informed_by");

    if (node.status === null || node.status === undefined) {
      const outgoingInformedBy = this.db
        .prepare(
          "SELECT 1 FROM edges WHERE from_id = ? AND relation = 'informed_by' AND removed_at IS NULL LIMIT 1"
        )
        .get(id);
      if (outgoingInformedBy) reasons.push("legacy_outgoing_informed_by");
    }

    const contradictsEndpoint = this.db
      .prepare(
        "SELECT 1 FROM edges WHERE (from_id = ? OR to_id = ?) AND relation = 'contradicts' AND removed_at IS NULL LIMIT 1"
      )
      .get(id, id);
    if (contradictsEndpoint) reasons.push("contradicts_endpoint");

    const supersedesEndpoint = this.db
      .prepare(
        "SELECT 1 FROM edges WHERE (from_id = ? OR to_id = ?) AND relation = 'supersedes' AND removed_at IS NULL LIMIT 1"
      )
      .get(id, id);
    if (supersedesEndpoint) reasons.push("supersedes_endpoint");

    return { protected: reasons.length > 0, reasons };
  }

  deleteEdgesForNode(nodeId: string): void {
    this.db
      .prepare("DELETE FROM edges WHERE from_id = ? OR to_id = ?")
      .run(nodeId, nodeId);
  }

  hardDeleteNode(id: string): boolean {
    let changed = false;
    this.runInTransaction(() => {
      this.deleteEdgesForNode(id);
      const result = this.db
        .prepare("DELETE FROM nodes WHERE id = ?")
        .run(id);
      changed = result.changes > 0;
    });
    return changed;
  }

  insertNodeRaw(node: {
    id: string;
    name: string;
    kind: string;
    summary: string;
    why?: string | null;
    file_refs?: string | null;
    parent_id?: string | null;
    created_by_task?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    removed_at?: string | null;
    removed_reason?: string | null;
    embedding?: Buffer | null;
    merge_group?: string | null;
    needs_merge?: number;
    source_branch?: string | null;
    merge_timestamp?: string | null;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, kind, summary, why, file_refs, parent_id, created_by_task,
        created_at, updated_at, removed_at, removed_reason, embedding,
        merge_group, needs_merge, source_branch, merge_timestamp)
      VALUES (@id, @name, @kind, @summary, @why, @file_refs, @parent_id, @created_by_task,
        @created_at, @updated_at, @removed_at, @removed_reason, @embedding,
        @merge_group, @needs_merge, @source_branch, @merge_timestamp)
    `);
    stmt.run({
      id: node.id,
      name: node.name,
      kind: node.kind,
      summary: node.summary,
      why: node.why ?? null,
      file_refs: node.file_refs ?? null,
      parent_id: node.parent_id ?? null,
      created_by_task: node.created_by_task ?? null,
      created_at: node.created_at ?? null,
      updated_at: node.updated_at ?? null,
      removed_at: node.removed_at ?? null,
      removed_reason: node.removed_reason ?? null,
      embedding: node.embedding ?? null,
      merge_group: node.merge_group ?? null,
      needs_merge: node.needs_merge ?? 0,
      source_branch: node.source_branch ?? null,
      merge_timestamp: node.merge_timestamp ?? null,
    });
  }

  insertEdgeRaw(edge: {
    from_id: string;
    to_id: string;
    relation: string;
    description?: string | null;
    created_at?: string | null;
    removed_at?: string | null;
    merge_group?: string | null;
    needs_merge?: number;
    source_branch?: string | null;
    merge_timestamp?: string | null;
  }): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO edges (from_id, to_id, relation, description, created_at, removed_at,
        merge_group, needs_merge, source_branch, merge_timestamp)
      VALUES (@from_id, @to_id, @relation, @description, @created_at, @removed_at,
        @merge_group, @needs_merge, @source_branch, @merge_timestamp)
    `);
    const result = stmt.run({
      from_id: edge.from_id,
      to_id: edge.to_id,
      relation: edge.relation,
      description: edge.description ?? null,
      created_at: edge.created_at ?? null,
      removed_at: edge.removed_at ?? null,
      merge_group: edge.merge_group ?? null,
      needs_merge: edge.needs_merge ?? 0,
      source_branch: edge.source_branch ?? null,
      merge_timestamp: edge.merge_timestamp ?? null,
    });
    return Number(result.lastInsertRowid);
  }

  // ---- Timeline Methods ----

  insertTimelineEntry(entry: {
    tool: string;
    params: string;
    result_summary: string;
    is_write: boolean;
    is_error: boolean;
    affected_ids: string[];
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO timeline (tool, params, result_summary, is_write, is_error, affected_ids)
      VALUES (@tool, @params, @result_summary, @is_write, @is_error, @affected_ids)
    `);
    const result = stmt.run({
      tool: entry.tool,
      params: entry.params,
      result_summary: entry.result_summary,
      is_write: entry.is_write ? 1 : 0,
      is_error: entry.is_error ? 1 : 0,
      affected_ids: JSON.stringify(entry.affected_ids),
    });
    return Number(result.lastInsertRowid);
  }

  getTimelineBounds(): { first: string | null; last: string | null; count: number } {
    const stmt = this.db.prepare(`
      SELECT 
        MIN(timestamp) as first,
        MAX(timestamp) as last,
        COUNT(*) as count
      FROM timeline
    `);
    const result = stmt.get() as { first: string | null; last: string | null; count: number };
    return {
      first: result.first,
      last: result.last,
      count: result.count,
    };
  }

  getTimelineEntries(options: {
    limit?: number;
    tool?: string;
    writesOnly?: boolean;
    since?: string;
    until?: string;
  } = {}): Array<{
    seq: number;
    timestamp: string;
    tool: string;
    params: string;
    result_summary: string;
    is_write: number;
    is_error: number;
    affected_ids: string;
  }> {
    let query = `SELECT * FROM timeline WHERE 1=1`;
    const params: Record<string, unknown> = {};

    if (options.tool) {
      query += ` AND tool = @tool`;
      params.tool = options.tool;
    }

    if (options.writesOnly) {
      query += ` AND is_write = 1`;
    }

    if (options.since) {
      query += ` AND timestamp >= @since`;
      params.since = options.since;
    }

    if (options.until) {
      query += ` AND timestamp <= @until`;
      params.until = options.until;
    }

    query += ` ORDER BY seq`;

    if (options.limit) {
      query += ` LIMIT @limit`;
      params.limit = options.limit;
    }

    const stmt = this.db.prepare(query);
    return stmt.all(params) as Array<{
      seq: number;
      timestamp: string;
      tool: string;
      params: string;
      result_summary: string;
      is_write: number;
      is_error: number;
      affected_ids: string;
    }>;
  }

  getTimelineTicks(n: number): Array<{
    seq: number;
    timestamp: string;
    tool: string;
    params: string;
    result_summary: string;
    is_write: number;
    is_error: number;
    affected_ids: string;
  }> {
    const totalCount = this.getTimelineBounds().count;
    
    if (totalCount === 0 || n >= totalCount) {
      return this.getTimelineEntries();
    }

    // Sample entries evenly distributed across the timeline
    // We want to select n entries from the range [1, totalCount]
    const step = totalCount / (n - 1); // -1 to ensure we include the last entry
    const selectedSeqs: number[] = [];
    
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        selectedSeqs.push(1); // Always start with the first entry
      } else if (i === n - 1 && n > 1) {
        selectedSeqs.push(totalCount); // Always end with the last entry
      } else {
        selectedSeqs.push(Math.round(1 + i * step));
      }
    }

    // Remove duplicates and sort
    const uniqueSeqs = [...new Set(selectedSeqs)].sort((a, b) => a - b);
    
    const placeholders = uniqueSeqs.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT * FROM timeline 
      WHERE seq IN (${placeholders})
      ORDER BY seq
    `);
    return stmt.all(...uniqueSeqs) as Array<{
      seq: number;
      timestamp: string;
      tool: string;
      params: string;
      result_summary: string;
      is_write: number;
      is_error: number;
      affected_ids: string;
    }>;
  }

  getNodesAtTime(timestamp: string): NodeRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM nodes
      WHERE created_at <= @timestamp
        AND (removed_at IS NULL OR removed_at > @timestamp)
    `);
    return stmt.all({ timestamp }) as NodeRow[];
  }

  getEdgesAtTime(timestamp: string): EdgeRow[] {
    const stmt = this.db.prepare(`
      SELECT e.* FROM edges e
      INNER JOIN nodes nf ON e.from_id = nf.id
      INNER JOIN nodes nt ON e.to_id = nt.id
      WHERE e.created_at <= @timestamp
        AND e.removed_at IS NULL
        AND nf.created_at <= @timestamp
        AND nt.created_at <= @timestamp
        AND (nf.removed_at IS NULL OR nf.removed_at > @timestamp)
        AND (nt.removed_at IS NULL OR nt.removed_at > @timestamp)
    `);
    return stmt.all({ timestamp }) as EdgeRow[];
  }

  close(): void {
    this.db.close();
  }
}
