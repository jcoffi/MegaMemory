import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import Database from "libsql";
import fs from "fs";
import path from "path";
import os from "os";

let db: KnowledgeDB;
let dbPath: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-test-"));
  dbPath = path.join(tmpDir, "knowledge.db");
  db = new KnowledgeDB(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("KnowledgeDB", () => {
  describe("schema", () => {
    it("creates the database file on construction", () => {
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it("runs migrations cleanly on a fresh database", () => {
      const stats = db.getStats();
      expect(stats.nodes).toBe(0);
      expect(stats.edges).toBe(0);
    });
  });

  describe("schema v5 - provenance columns", () => {
    function userVersion(d: KnowledgeDB): number {
      const raw = (d as any).db;
      return (raw.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
    }

    function columnNames(d: KnowledgeDB, table: string): string[] {
      const raw = (d as any).db;
      return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((c) => c.name);
    }

    it("adds nodes.status, edges.removed_at, and sets user_version=5", () => {
      expect(columnNames(db, "nodes")).toContain("status");
      expect(columnNames(db, "edges")).toContain("removed_at");
      expect(userVersion(db)).toBe(5);
    });
  });

  describe("status (provenance write)", () => {
    it("updateNode persists a status-only change", () => {
      db.insertNode({ id: "d1", name: "D", kind: "decision", summary: "s" });
      expect(db.updateNode("d1", { status: "validated" })).toBe(true);
      expect(db.getNode("d1")!.status).toBe("validated");
    });

    it("insertNode persists status when provided", () => {
      db.insertNode({
        id: "d2",
        name: "D2",
        kind: "decision",
        summary: "s",
        status: "open",
      });
      expect(db.getNode("d2")!.status).toBe("open");
    });

    it("insertNode leaves status NULL when omitted", () => {
      db.insertNode({ id: "d3", name: "D3", kind: "feature", summary: "s" });
      expect(db.getNode("d3")!.status).toBeNull();
    });

    it("insertNodeAndEdges persists status", () => {
      db.insertNode({ id: "ev", name: "Ev", kind: "feature", summary: "evidence" });
      db.insertNodeAndEdges(
        {
          id: "d4",
          name: "D4",
          kind: "decision",
          summary: "s",
          why: null,
          file_refs: null,
          parent_id: null,
          created_by_task: null,
          embedding: null,
          status: "open",
        },
        [{ to_id: "ev", relation: "informed_by", description: "based on" }]
      );
      expect(db.getNode("d4")!.status).toBe("open");
    });
  });

  describe("tombstones (provenance §2.3)", () => {
    function tombstoneEdge(from: string, to: string): void {
      (db as any).db
        .prepare(
          "UPDATE edges SET removed_at = datetime('now') WHERE from_id = ? AND to_id = ?"
        )
        .run(from, to);
    }

    it("softDeleteNode tombstones incident edges (no physical delete)", () => {
      db.insertNode({ id: "ta", name: "A", kind: "feature", summary: "s" });
      db.insertNode({ id: "tb", name: "B", kind: "decision", summary: "s" });
      db.insertEdge({ from_id: "tb", to_id: "ta", relation: "informed_by" });

      db.softDeleteNode("ta", "cleanup");

      const row = (db as any).db
        .prepare("SELECT removed_at FROM edges WHERE from_id = 'tb' AND to_id = 'ta'")
        .get() as { removed_at: string | null } | undefined;
      expect(row).toBeTruthy(); // row still exists — not physically deleted
      expect(row!.removed_at).not.toBeNull(); // tombstoned
    });

    it("tombstone-aware reads exclude tombstoned edges (endpoints still active)", () => {
      db.insertNode({ id: "ra", name: "A", kind: "feature", summary: "s" });
      db.insertNode({ id: "rb", name: "B", kind: "decision", summary: "s" });
      db.insertNode({ id: "rc", name: "C", kind: "feature", summary: "s" });
      db.insertEdge({ from_id: "rb", to_id: "ra", relation: "informed_by" });
      db.insertEdge({ from_id: "rb", to_id: "rc", relation: "depends_on" });

      tombstoneEdge("rb", "ra"); // both nodes stay active; only the edge is tombstoned

      expect(db.getOutgoingEdges("rb").map((e) => e.to_id)).toEqual(["rc"]);
      expect(db.getIncomingEdges("ra")).toHaveLength(0);
      expect(db.getAllEdges().map((e) => `${e.from_id}->${e.to_id}`)).toEqual([
        "rb->rc",
      ]);
    });

    it("getStats edge count excludes tombstoned edges", () => {
      db.insertNode({ id: "sa", name: "A", kind: "feature", summary: "s" });
      db.insertNode({ id: "sb", name: "B", kind: "decision", summary: "s" });
      db.insertEdge({ from_id: "sb", to_id: "sa", relation: "informed_by" });
      expect(db.getStats().edges).toBe(1);

      tombstoneEdge("sb", "sa");
      expect(db.getStats().edges).toBe(0);
    });

    it("getAllEdgesRaw stays unfiltered (includes tombstoned for merge)", () => {
      db.insertNode({ id: "ga", name: "A", kind: "feature", summary: "s" });
      db.insertNode({ id: "gb", name: "B", kind: "decision", summary: "s" });
      db.insertEdge({ from_id: "gb", to_id: "ga", relation: "informed_by" });

      tombstoneEdge("gb", "ga");

      const all = db.getAllEdgesRaw();
      expect(all).toHaveLength(1);
      expect(all[0].removed_at).not.toBeNull();
    });

    it("getEdgesAtTime excludes tombstoned edges", () => {
      db.insertNode({ id: "ea", name: "A", kind: "feature", summary: "s" });
      db.insertNode({ id: "eb", name: "B", kind: "decision", summary: "s" });
      db.insertEdge({ from_id: "eb", to_id: "ea", relation: "informed_by" });
      const future = "2099-01-01 00:00:00";
      expect(
        db.getEdgesAtTime(future).map((e) => `${e.from_id}->${e.to_id}`)
      ).toContain("eb->ea");

      tombstoneEdge("eb", "ea");
      expect(
        db.getEdgesAtTime(future).map((e) => `${e.from_id}->${e.to_id}`)
      ).not.toContain("eb->ea");
    });

    it("insertEdgeRaw round-trips removed_at (no tombstone resurrection)", () => {
      db.insertNode({ id: "ia", name: "A", kind: "feature", summary: "s" });
      db.insertNode({ id: "ib", name: "B", kind: "decision", summary: "s" });
      db.insertEdgeRaw({
        from_id: "ib",
        to_id: "ia",
        relation: "informed_by",
        removed_at: "2026-01-01 00:00:00",
      });

      const all = db.getAllEdgesRaw();
      expect(all).toHaveLength(1);
      expect(all[0].removed_at).toBe("2026-01-01 00:00:00");
      // Stays tombstoned: excluded from active reads.
      expect(db.getAllEdges()).toHaveLength(0);
    });
  });

  describe("getProvenanceEdges (informed_by adjacency, B3)", () => {
    function buildChain(): void {
      // c -informed_by-> b -informed_by-> a   (a = ultimate ancestor)
      // c -depends_on-> a   (non-informed_by; must be ignored)
      // d -informed_by-> a  (TOMBSTONED edge; d node stays active)
      db.insertNode({ id: "a", name: "A", kind: "decision", summary: "s" });
      db.insertNode({ id: "b", name: "B", kind: "decision", summary: "s" });
      db.insertNode({ id: "c", name: "C", kind: "decision", summary: "s" });
      db.insertNode({ id: "d", name: "D", kind: "decision", summary: "s" });
      db.insertEdge({ from_id: "b", to_id: "a", relation: "informed_by" });
      db.insertEdge({ from_id: "c", to_id: "b", relation: "informed_by" });
      db.insertEdge({ from_id: "c", to_id: "a", relation: "depends_on" });
      db.insertEdgeRaw({
        from_id: "d",
        to_id: "a",
        relation: "informed_by",
        removed_at: "2026-01-01 00:00:00",
      });
    }

    it("upstream = active informed_by out-edges (ancestry), referentially closed", () => {
      buildChain();
      const { nodes, edges } = db.getProvenanceEdges(["c"], { direction: "upstream" });
      expect(edges.map((e) => `${e.from_id}->${e.to_id}`)).toEqual(["c->b"]);
      expect(edges.every((e) => e.relation === "informed_by")).toBe(true);
      // referentially closed: both endpoints present in nodes
      expect(nodes.map((n) => n.id).sort()).toEqual(["b", "c"]);
    });

    it("downstream = active informed_by in-edges (impact); tombstoned edge excluded by default", () => {
      buildChain();
      const { nodes, edges } = db.getProvenanceEdges(["a"], { direction: "downstream" });
      expect(edges.map((e) => `${e.from_id}->${e.to_id}`)).toEqual(["b->a"]);
      expect(nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    });

    it("includeRemoved=true includes tombstoned edges (endpoint active)", () => {
      buildChain();
      const { nodes, edges } = db.getProvenanceEdges(["a"], {
        direction: "downstream",
        includeRemoved: true,
      });
      expect(edges.map((e) => `${e.from_id}->${e.to_id}`).sort()).toEqual([
        "b->a",
        "d->a",
      ]);
      expect(nodes.map((n) => n.id).sort()).toEqual(["a", "b", "d"]);
    });

    it("includeRemoved=true returns a removed endpoint node as a stub (referentially closed)", () => {
      db.insertNode({ id: "x", name: "X", kind: "decision", summary: "s" });
      db.insertNode({ id: "y", name: "Y", kind: "decision", summary: "s" });
      db.insertEdge({ from_id: "y", to_id: "x", relation: "informed_by" });
      db.softDeleteNode("y", "removed"); // tombstones y's edges AND removes node y

      const { nodes, edges } = db.getProvenanceEdges(["x"], {
        direction: "downstream",
        includeRemoved: true,
      });
      expect(edges.map((e) => `${e.from_id}->${e.to_id}`)).toEqual(["y->x"]);
      expect(nodes.map((n) => n.id).sort()).toEqual(["x", "y"]);
      expect(nodes.find((n) => n.id === "y")!.removed_at).not.toBeNull(); // stub
    });

    it("includeRemoved=false omits edges to removed endpoints (no dangling)", () => {
      db.insertNode({ id: "x", name: "X", kind: "decision", summary: "s" });
      db.insertNode({ id: "y", name: "Y", kind: "decision", summary: "s" });
      db.insertEdge({ from_id: "y", to_id: "x", relation: "informed_by" });
      db.softDeleteNode("y", "removed");

      const { nodes, edges } = db.getProvenanceEdges(["x"], {
        direction: "downstream",
      });
      expect(edges).toHaveLength(0);
      expect(nodes).toHaveLength(0);
    });

    it("empty ids returns an empty adjacency", () => {
      buildChain();
      expect(db.getProvenanceEdges([], { direction: "upstream" })).toEqual({
        nodes: [],
        edges: [],
      });
    });
  });

  describe("informed_by DAG helpers (P4.1)", () => {
    function chain(): void {
      // a -informed_by-> b -informed_by-> c   (out-edges; a reaches c)
      db.insertNode({ id: "a", name: "A", kind: "decision", summary: "s" });
      db.insertNode({ id: "b", name: "B", kind: "decision", summary: "s" });
      db.insertNode({ id: "c", name: "C", kind: "decision", summary: "s" });
      db.insertEdge({ from_id: "a", to_id: "b", relation: "informed_by" });
      db.insertEdge({ from_id: "b", to_id: "c", relation: "informed_by" });
    }

    it("informedByReaches follows active informed_by out-edges transitively", () => {
      chain();
      expect(db.informedByReaches("a", "c")).toBe(true); // a->b->c
      expect(db.informedByReaches("a", "b")).toBe(true);
      expect(db.informedByReaches("c", "a")).toBe(false); // c has no out-edges
      expect(db.informedByReaches("a", "a")).toBe(false); // no self-path
    });

    it("informedByReaches ignores non-informed_by relations", () => {
      db.insertNode({ id: "p", name: "P", kind: "decision", summary: "s" });
      db.insertNode({ id: "q", name: "Q", kind: "decision", summary: "s" });
      db.insertEdge({ from_id: "p", to_id: "q", relation: "depends_on" });
      expect(db.informedByReaches("p", "q")).toBe(false);
    });

    it("informedByReaches ignores tombstoned informed_by edges", () => {
      db.insertNode({ id: "m", name: "M", kind: "decision", summary: "s" });
      db.insertNode({ id: "n", name: "N", kind: "decision", summary: "s" });
      db.insertEdgeRaw({
        from_id: "m",
        to_id: "n",
        relation: "informed_by",
        removed_at: "2026-01-01 00:00:00",
      });
      expect(db.informedByReaches("m", "n")).toBe(false);
    });

    it("wouldCreateCycle detects a back-edge that closes a cycle", () => {
      chain();
      expect(db.wouldCreateCycle("c", "a")).toBe(true); // c informed_by a closes c->a->b->c
      expect(db.wouldCreateCycle("a", "c")).toBe(false); // a informed_by c: no existing c->a path
    });

    it("wouldCreateCycle rejects self-loops", () => {
      db.insertNode({ id: "s1", name: "S", kind: "decision", summary: "s" });
      expect(db.wouldCreateCycle("s1", "s1")).toBe(true);
    });
  });

  describe("isEpistemicallyProtected (§4.4, P5.1)", () => {
    it("protects a node with a non-null status (status_set)", () => {
      db.insertNode({ id: "n1", name: "N", kind: "feature", summary: "s", status: "open" });
      const r = db.isEpistemicallyProtected("n1");
      expect(r.protected).toBe(true);
      expect(r.reasons).toContain("status_set");
    });

    it("protects a legacy decision node (decision_kind, status NULL)", () => {
      db.insertNode({ id: "n2", name: "N", kind: "decision", summary: "s" });
      const r = db.isEpistemicallyProtected("n2");
      expect(r.protected).toBe(true);
      expect(r.reasons).toContain("decision_kind");
    });

    it("protects a node with an active incoming informed_by", () => {
      db.insertNode({ id: "ev", name: "Ev", kind: "feature", summary: "s" }); // descriptive, status NULL
      db.insertNode({ id: "dec", name: "Dec", kind: "decision", summary: "s" });
      db.insertEdge({ from_id: "dec", to_id: "ev", relation: "informed_by" });
      const r = db.isEpistemicallyProtected("ev");
      expect(r.protected).toBe(true);
      expect(r.reasons).toContain("incoming_informed_by");
    });

    it("protects a legacy NULL node with an active outgoing informed_by", () => {
      db.insertNode({ id: "concl", name: "C", kind: "feature", summary: "s" }); // status NULL, not decision
      db.insertNode({ id: "basis", name: "B", kind: "feature", summary: "s" });
      db.insertEdge({ from_id: "concl", to_id: "basis", relation: "informed_by" });
      const r = db.isEpistemicallyProtected("concl");
      expect(r.protected).toBe(true);
      expect(r.reasons).toContain("legacy_outgoing_informed_by");
    });

    it("does NOT count outgoing informed_by when the node has a status", () => {
      db.insertNode({ id: "sn", name: "S", kind: "feature", summary: "s", status: "validated" });
      db.insertNode({ id: "sb", name: "B", kind: "feature", summary: "s" });
      db.insertEdge({ from_id: "sn", to_id: "sb", relation: "informed_by" });
      const r = db.isEpistemicallyProtected("sn");
      expect(r.reasons).toContain("status_set");
      expect(r.reasons).not.toContain("legacy_outgoing_informed_by");
    });

    it("protects a contradicts endpoint in either direction", () => {
      db.insertNode({ id: "ca", name: "A", kind: "feature", summary: "s" });
      db.insertNode({ id: "cb", name: "B", kind: "feature", summary: "s" });
      db.insertEdge({ from_id: "ca", to_id: "cb", relation: "contradicts" });
      expect(db.isEpistemicallyProtected("ca").reasons).toContain("contradicts_endpoint");
      expect(db.isEpistemicallyProtected("cb").reasons).toContain("contradicts_endpoint");
    });

    it("protects a supersedes endpoint in either direction", () => {
      db.insertNode({ id: "spa", name: "A", kind: "feature", summary: "s" });
      db.insertNode({ id: "spb", name: "B", kind: "feature", summary: "s" });
      db.insertEdge({ from_id: "spa", to_id: "spb", relation: "supersedes" });
      expect(db.isEpistemicallyProtected("spa").reasons).toContain("supersedes_endpoint");
      expect(db.isEpistemicallyProtected("spb").reasons).toContain("supersedes_endpoint");
    });

    it("does NOT protect a plain descriptive node (status NULL, feature, no relations)", () => {
      db.insertNode({ id: "desc", name: "D", kind: "feature", summary: "s" });
      const r = db.isEpistemicallyProtected("desc");
      expect(r.protected).toBe(false);
      expect(r.reasons).toEqual([]);
    });

    it("ignores tombstoned relation edges", () => {
      db.insertNode({ id: "t1", name: "A", kind: "feature", summary: "s" });
      db.insertNode({ id: "t2", name: "B", kind: "feature", summary: "s" });
      db.insertEdgeRaw({ from_id: "t2", to_id: "t1", relation: "informed_by", removed_at: "2026-01-01 00:00:00" });
      db.insertEdgeRaw({ from_id: "t1", to_id: "t2", relation: "contradicts", removed_at: "2026-01-01 00:00:00" });
      expect(db.isEpistemicallyProtected("t1").protected).toBe(false);
    });

    it("returns not-protected for a nonexistent node", () => {
      expect(db.isEpistemicallyProtected("ghost")).toEqual({ protected: false, reasons: [] });
    });
  });

  describe("nodes", () => {
    it("inserts and retrieves a node", () => {
      db.insertNode({
        id: "test-node",
        name: "Test Node",
        kind: "feature",
        summary: "A test node",
        why: "For testing",
        file_refs: ["src/test.ts"],
        parent_id: null,
        created_by_task: "test",
        embedding: null,
      });

      const node = db.getNode("test-node");
      expect(node).not.toBeNull();
      expect(node!.name).toBe("Test Node");
      expect(node!.kind).toBe("feature");
      expect(node!.summary).toBe("A test node");
      expect(node!.why).toBe("For testing");
    });

    it("returns undefined for non-existent node", () => {
      expect(db.getNode("nonexistent")).toBeUndefined();
    });

    it("updates node fields", () => {
      db.insertNode({
        id: "update-me",
        name: "Original",
        kind: "feature",
        summary: "Original summary",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      db.updateNode("update-me", {
        name: "Updated",
        summary: "Updated summary",
      });

      const node = db.getNode("update-me");
      expect(node!.name).toBe("Updated");
      expect(node!.summary).toBe("Updated summary");
    });

    it("soft-deletes a node", () => {
      db.insertNode({
        id: "delete-me",
        name: "To Delete",
        kind: "module",
        summary: "Will be deleted",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      db.softDeleteNode("delete-me", "No longer needed");

      // Should not appear in active queries
      expect(db.getNode("delete-me")).toBeUndefined();

      // Should appear in including-removed query
      const removed = db.getNodeIncludingRemoved("delete-me");
      expect(removed).not.toBeNull();
      expect(removed!.removed_reason).toBe("No longer needed");
    });

    it("nodeExists returns true for existing, false for missing", () => {
      db.insertNode({
        id: "exists",
        name: "Exists",
        kind: "feature",
        summary: "I exist",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      expect(db.nodeExists("exists")).toBe(true);
      expect(db.nodeExists("nope")).toBe(false);
    });
  });

  describe("parent-child relationships", () => {
    it("getRootNodes returns only parentless nodes", () => {
      db.insertNode({
        id: "root",
        name: "Root",
        kind: "module",
        summary: "A root node",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      db.insertNode({
        id: "root/child",
        name: "Child",
        kind: "feature",
        summary: "A child node",
        why: null,
        file_refs: null,
        parent_id: "root",
        created_by_task: null,
        embedding: null,
      });

      const roots = db.getRootNodes();
      expect(roots).toHaveLength(1);
      expect(roots[0].id).toBe("root");
    });

    it("getChildren returns children of a parent", () => {
      db.insertNode({
        id: "parent",
        name: "Parent",
        kind: "module",
        summary: "Parent",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      db.insertNode({
        id: "parent/child-a",
        name: "Child A",
        kind: "feature",
        summary: "First child",
        why: null,
        file_refs: null,
        parent_id: "parent",
        created_by_task: null,
        embedding: null,
      });

      db.insertNode({
        id: "parent/child-b",
        name: "Child B",
        kind: "feature",
        summary: "Second child",
        why: null,
        file_refs: null,
        parent_id: "parent",
        created_by_task: null,
        embedding: null,
      });

      const children = db.getChildren("parent");
      expect(children).toHaveLength(2);
      const names = children.map((c) => c.name).sort();
      expect(names).toEqual(["Child A", "Child B"]);
    });
  });

  describe("getAllActiveNodesWithEmbeddings", () => {
    function makeEmbeddingBuffer(values: number[]): Buffer {
      const arr = new Float32Array(values);
      return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    }

    it("returns embeddings as Buffer instances with correct float32 data", () => {
      const original = makeEmbeddingBuffer([1.0, 2.0, 3.0, 4.0]);
      db.insertNode({
        id: "with-emb",
        name: "With Embedding",
        kind: "feature",
        summary: "Has an embedding",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: original,
      });

      const results = db.getAllActiveNodesWithEmbeddings();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("with-emb");

      const emb = results[0].embedding!;
      expect(Buffer.isBuffer(emb)).toBe(true);

      // Verify the float32 values round-trip correctly
      const floats = new Float32Array(emb.buffer, emb.byteOffset, emb.byteLength / Float32Array.BYTES_PER_ELEMENT);
      expect(floats[0]).toBeCloseTo(1.0);
      expect(floats[1]).toBeCloseTo(2.0);
      expect(floats[2]).toBeCloseTo(3.0);
      expect(floats[3]).toBeCloseTo(4.0);
    });

    it("excludes nodes without embeddings", () => {
      db.insertNode({
        id: "no-emb",
        name: "No Embedding",
        kind: "feature",
        summary: "Missing embedding",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      const results = db.getAllActiveNodesWithEmbeddings();
      expect(results).toHaveLength(0);
    });

    it("excludes soft-deleted nodes", () => {
      const emb = makeEmbeddingBuffer([1.0, 2.0]);
      db.insertNode({
        id: "deleted-emb",
        name: "Deleted",
        kind: "feature",
        summary: "Will be deleted",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: emb,
      });

      db.softDeleteNode("deleted-emb", "No longer needed");

      const results = db.getAllActiveNodesWithEmbeddings();
      expect(results).toHaveLength(0);
    });
  });

  describe("edges", () => {
    beforeEach(() => {
      db.insertNode({
        id: "node-a",
        name: "Node A",
        kind: "feature",
        summary: "Node A",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertNode({
        id: "node-b",
        name: "Node B",
        kind: "module",
        summary: "Node B",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
    });

    it("inserts and retrieves an edge", () => {
      db.insertEdge({
        from_id: "node-a",
        to_id: "node-b",
        relation: "depends_on",
        description: "A depends on B",
      });

      const outgoing = db.getOutgoingEdges("node-a");
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].to_id).toBe("node-b");
      expect(outgoing[0].relation).toBe("depends_on");

      const incoming = db.getIncomingEdges("node-b");
      expect(incoming).toHaveLength(1);
      expect(incoming[0].from_id).toBe("node-a");
    });

    it("cascade-deletes edges when a node is soft-deleted", () => {
      db.insertEdge({
        from_id: "node-a",
        to_id: "node-b",
        relation: "calls",
        description: null,
      });

      db.softDeleteNode("node-a", "Removed");

      // Edges involving node-a should be gone
      const outgoing = db.getOutgoingEdges("node-a");
      expect(outgoing).toHaveLength(0);
      const incoming = db.getIncomingEdges("node-a");
      expect(incoming).toHaveLength(0);
    });

    it("getAllEdges returns all edges", () => {
      db.insertEdge({
        from_id: "node-a",
        to_id: "node-b",
        relation: "depends_on",
        description: null,
      });

      const edges = db.getAllEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0].from_id).toBe("node-a");
      expect(edges[0].to_id).toBe("node-b");
    });

    it("silently ignores duplicate edges", () => {
      const first = db.insertEdge({
        from_id: "node-a",
        to_id: "node-b",
        relation: "depends_on",
        description: "first",
      });
      const second = db.insertEdge({
        from_id: "node-a",
        to_id: "node-b",
        relation: "depends_on",
        description: "duplicate",
      });

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(db.getAllEdges()).toHaveLength(1);
    });

    it("allows multiple relations between the same nodes", () => {
      const depends = db.insertEdge({
        from_id: "node-a",
        to_id: "node-b",
        relation: "depends_on",
        description: null,
      });
      const calls = db.insertEdge({
        from_id: "node-a",
        to_id: "node-b",
        relation: "calls",
        description: null,
      });

      expect(depends.inserted).toBe(true);
      expect(calls.inserted).toBe(true);
      expect(db.getAllEdges()).toHaveLength(2);
    });
  });

  describe("transactions", () => {
    it("insertNodeAndEdges inserts node and valid edges atomically", () => {
      db.insertNode({
        id: "target",
        name: "Target",
        kind: "feature",
        summary: "target",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      db.insertNodeAndEdges(
        {
          id: "source",
          name: "Source",
          kind: "feature",
          summary: "source",
          why: null,
          file_refs: JSON.stringify(["src/source.ts"]),
          parent_id: null,
          created_by_task: null,
          embedding: null,
        },
        [{ to_id: "target", relation: "calls", description: "source calls target" }]
      );

      expect(db.getNode("source")).toBeDefined();
      const outgoing = db.getOutgoingEdges("source");
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].to_id).toBe("target");
      expect(outgoing[0].relation).toBe("calls");
    });

    it("insertNodeAndEdges skips edges to nonexistent targets", () => {
      db.insertNodeAndEdges(
        {
          id: "source-only",
          name: "Source Only",
          kind: "feature",
          summary: "source",
          why: null,
          file_refs: null,
          parent_id: null,
          created_by_task: null,
          embedding: null,
        },
        [{ to_id: "missing", relation: "calls", description: null }]
      );

      expect(db.getNode("source-only")).toBeDefined();
      expect(db.getOutgoingEdges("source-only")).toHaveLength(0);
      expect(db.getAllEdges()).toHaveLength(0);
    });

    it("runInTransaction rolls back when callback throws", () => {
      expect(() => {
        db.runInTransaction(() => {
          db.insertNode({
            id: "rolled-back",
            name: "Rolled Back",
            kind: "feature",
            summary: "should not persist",
            why: null,
            file_refs: null,
            parent_id: null,
            created_by_task: null,
            embedding: null,
          });
          throw new Error("force rollback");
        });
      }).toThrow("force rollback");

      expect(db.getNode("rolled-back")).toBeUndefined();
    });

    it("runInTransaction supports nesting without error", () => {
      db.runInTransaction(() => {
        db.insertNode({
          id: "outer-node",
          name: "Outer",
          kind: "feature",
          summary: "outer",
          why: null,
          file_refs: null,
          parent_id: null,
          created_by_task: null,
          embedding: null,
        });
        db.runInTransaction(() => {
          db.insertNode({
            id: "inner-node",
            name: "Inner",
            kind: "feature",
            summary: "inner",
            why: null,
            file_refs: null,
            parent_id: null,
            created_by_task: null,
            embedding: null,
          });
        });
      });

      expect(db.getNode("outer-node")).toBeDefined();
      expect(db.getNode("inner-node")).toBeDefined();
    });

    it("nested runInTransaction rollback rolls back outer transaction", () => {
      expect(() => {
        db.runInTransaction(() => {
          db.insertNode({
            id: "rollback-outer",
            name: "Outer",
            kind: "feature",
            summary: "outer",
            why: null,
            file_refs: null,
            parent_id: null,
            created_by_task: null,
            embedding: null,
          });
          db.runInTransaction(() => {
            throw new Error("inner failure");
          });
        });
      }).toThrow("inner failure");

      expect(db.getNode("rollback-outer")).toBeUndefined();
    });

    it("runWithRetry retries on SQLITE_BUSY and succeeds", () => {
      let attempts = 0;
      const result = db.runWithRetry(() => {
        attempts++;
        if (attempts < 3) throw new Error("SQLITE_BUSY");
        return "success";
      }, 3);

      expect(result).toBe("success");
      expect(attempts).toBe(3);
    });

    it("runWithRetry throws after max retries exceeded", () => {
      expect(() => {
        db.runWithRetry(() => {
          throw new Error("SQLITE_BUSY");
        }, 2);
      }).toThrow("SQLITE_BUSY");
    });

    it("runWithRetry does not retry non-busy errors", () => {
      let attempts = 0;
      expect(() => {
        db.runWithRetry(() => {
          attempts++;
          throw new Error("UNIQUE constraint failed");
        }, 3);
      }).toThrow("UNIQUE constraint failed");

      expect(attempts).toBe(1);
    });

    it("softDeleteNode removes edges atomically", () => {
      db.insertNode({
        id: "del-a",
        name: "A",
        kind: "feature",
        summary: "a",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertNode({
        id: "del-b",
        name: "B",
        kind: "feature",
        summary: "b",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertEdge({ from_id: "del-a", to_id: "del-b", relation: "calls" });

      db.softDeleteNode("del-a", "test deletion");

      const edges = db.getAllEdges();
      const edgesToA = edges.filter((e) => e.from_id === "del-a" || e.to_id === "del-a");
      expect(edgesToA).toHaveLength(0);
    });
  });

  describe("schema v2 - merge columns", () => {
    it("has merge columns on fresh database", () => {
      // Insert a node with merge fields via insertNodeRaw
      db.insertNodeRaw({
        id: "merge-test",
        name: "Merge Test",
        kind: "feature",
        summary: "Testing merge columns",
        merge_group: "test-uuid",
        needs_merge: 1,
        source_branch: "main",
        merge_timestamp: "2024-01-01 00:00:00",
      });

      const node = db.getAllNodesRaw().find(n => n.id === "merge-test");
      expect(node).toBeDefined();
      expect(node!.merge_group).toBe("test-uuid");
      expect(node!.needs_merge).toBe(1);
      expect(node!.source_branch).toBe("main");
      expect(node!.merge_timestamp).toBe("2024-01-01 00:00:00");
    });

    it("has merge columns on edges", () => {
      db.insertNode({
        id: "from-node", name: "From", kind: "feature", summary: "s",
        why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null,
      });
      db.insertNode({
        id: "to-node", name: "To", kind: "feature", summary: "s",
        why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null,
      });

      db.insertEdgeRaw({
        from_id: "from-node",
        to_id: "to-node",
        relation: "calls",
        merge_group: "edge-uuid",
        needs_merge: 1,
        source_branch: "feature",
        merge_timestamp: "2024-06-01 12:00:00",
      });

      const edges = db.getAllEdgesRaw();
      const mergeEdge = edges.find(e => e.merge_group === "edge-uuid");
      expect(mergeEdge).toBeDefined();
      expect(mergeEdge!.needs_merge).toBe(1);
      expect(mergeEdge!.source_branch).toBe("feature");
    });
  });

  describe("merge query methods", () => {
    it("getConflictNodes returns only nodes with needs_merge=1", () => {
      db.insertNodeRaw({
        id: "clean", name: "Clean", kind: "feature", summary: "clean",
      });
      db.insertNodeRaw({
        id: "conflict", name: "Conflict", kind: "feature", summary: "conflict",
        merge_group: "uuid-1", needs_merge: 1, source_branch: "left",
      });

      const conflicts = db.getConflictNodes();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].id).toBe("conflict");
    });

    it("getNodesByMergeGroup returns nodes sharing a merge_group", () => {
      db.insertNodeRaw({
        id: "a::left", name: "A", kind: "feature", summary: "left",
        merge_group: "group-1", needs_merge: 1, source_branch: "left",
      });
      db.insertNodeRaw({
        id: "a::right", name: "A", kind: "feature", summary: "right",
        merge_group: "group-1", needs_merge: 1, source_branch: "right",
      });
      db.insertNodeRaw({
        id: "other", name: "Other", kind: "feature", summary: "other",
        merge_group: "group-2", needs_merge: 1, source_branch: "left",
      });

      const group1 = db.getNodesByMergeGroup("group-1");
      expect(group1).toHaveLength(2);
      expect(group1.map(n => n.id).sort()).toEqual(["a::left", "a::right"]);
    });

    it("clearNodeMergeFlags resets merge fields to null/0", () => {
      db.insertNodeRaw({
        id: "flagged", name: "Flagged", kind: "feature", summary: "s",
        merge_group: "uuid", needs_merge: 1, source_branch: "main",
        merge_timestamp: "2024-01-01",
      });

      db.clearNodeMergeFlags("flagged");
      const node = db.getAllNodesRaw().find(n => n.id === "flagged")!;
      expect(node.merge_group).toBeNull();
      expect(node.needs_merge).toBe(0);
      expect(node.source_branch).toBeNull();
      expect(node.merge_timestamp).toBeNull();
    });

    it("renameNodeId updates id and all references", () => {
      db.insertNode({
        id: "old-id", name: "Node", kind: "feature", summary: "s",
        why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null,
      });
      db.insertNode({
        id: "target", name: "Target", kind: "feature", summary: "s",
        why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null,
      });
      db.insertEdge({ from_id: "old-id", to_id: "target", relation: "calls", description: null });

      const renamed = db.renameNodeId("old-id", "new-id");
      expect(renamed).toBe(true);

      expect(db.getNode("old-id")).toBeUndefined();
      expect(db.getNode("new-id")).toBeDefined();

      // Edge should reference new-id
      const edges = db.getOutgoingEdges("new-id");
      expect(edges).toHaveLength(1);
      expect(edges[0].from_id).toBe("new-id");
    });

    it("renameNodeId on an edge-bearing node succeeds inside an outer transaction (deferred FK)", () => {
      db.insertNode({
        id: "old-edged", name: "Old", kind: "decision", summary: "s",
        why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null,
      });
      db.insertNode({
        id: "evidence", name: "Ev", kind: "feature", summary: "s",
        why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null,
      });
      db.insertEdge({ from_id: "old-edged", to_id: "evidence", relation: "informed_by", description: "x" });

      // resolveConflict renames inside an outer transaction; `foreign_keys = OFF` is a no-op
      // there, so without deferred FK this FK-throws on the edge-bearing node.
      expect(() =>
        db.runInTransaction(() => {
          expect(db.renameNodeId("old-edged", "new-edged")).toBe(true);
        })
      ).not.toThrow();

      expect(db.getNode("old-edged")).toBeUndefined();
      expect(db.getNode("new-edged")).toBeDefined();
      const edges = db.getOutgoingEdges("new-edged");
      expect(edges).toHaveLength(1);
      expect(edges[0].from_id).toBe("new-edged");
      expect(edges[0].to_id).toBe("evidence");
    });

    it("hardDeleteNode removes node and its edges permanently", () => {
      db.insertNode({
        id: "to-hard-delete", name: "Del", kind: "feature", summary: "s",
        why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null,
      });
      db.insertNode({
        id: "other", name: "Other", kind: "feature", summary: "s",
        why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null,
      });
      db.insertEdge({ from_id: "to-hard-delete", to_id: "other", relation: "calls", description: null });

      db.hardDeleteNode("to-hard-delete");

      // Completely gone, not even in raw query
      const all = db.getAllNodesRaw();
      expect(all.find(n => n.id === "to-hard-delete")).toBeUndefined();
      expect(db.getAllEdgesRaw()).toHaveLength(0);
    });
  });

  describe("stats", () => {
    it("returns correct counts", () => {
      db.insertNode({
        id: "s1",
        name: "S1",
        kind: "feature",
        summary: "s",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertNode({
        id: "s2",
        name: "S2",
        kind: "module",
        summary: "s",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertEdge({
        from_id: "s1",
        to_id: "s2",
        relation: "calls",
        description: null,
      });

      const stats = db.getStats();
      expect(stats.nodes).toBe(2);
      expect(stats.edges).toBe(1);
    });

    it("getKindsBreakdown returns counts per kind", () => {
      db.insertNode({
        id: "k1",
        name: "K1",
        kind: "feature",
        summary: "s",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertNode({
        id: "k2",
        name: "K2",
        kind: "feature",
        summary: "s",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertNode({
        id: "k3",
        name: "K3",
        kind: "module",
        summary: "s",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      const kinds = db.getKindsBreakdown();
      expect(kinds.feature).toBe(2);
      expect(kinds.module).toBe(1);
    });
  });

  describe("schema v5 - upgrade from v4 (Task 0.2)", () => {
    function rawUserVersion(raw: any): number {
      return (raw.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
    }
    function rawColumns(raw: any, table: string): string[] {
      return (
        raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      ).map((c) => c.name);
    }

    // Build a GENUINE v4-shaped DB: nodes WITHOUT `status`, edges WITHOUT
    // `removed_at`, PRAGMA user_version=4, plus existing node + edge rows.
    function seedV4Db(p: string): void {
      const raw = new Database(p);
      raw.exec(`
        CREATE TABLE nodes (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
          why TEXT, file_refs TEXT, parent_id TEXT, created_by_task TEXT,
          created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
          removed_at TEXT, removed_reason TEXT, embedding BLOB,
          merge_group TEXT, needs_merge INTEGER DEFAULT 0, source_branch TEXT, merge_timestamp TEXT
        );
        CREATE TABLE edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
          relation TEXT NOT NULL, description TEXT, created_at TEXT DEFAULT (datetime('now')),
          merge_group TEXT, needs_merge INTEGER DEFAULT 0, source_branch TEXT, merge_timestamp TEXT
        );
        CREATE UNIQUE INDEX idx_edges_unique ON edges(from_id, to_id, relation);
      `);
      raw
        .prepare("INSERT INTO nodes (id, name, kind, summary) VALUES (?, ?, ?, ?)")
        .run("legacy-a", "Legacy A", "decision", "old decision");
      raw
        .prepare("INSERT INTO nodes (id, name, kind, summary) VALUES (?, ?, ?, ?)")
        .run("legacy-b", "Legacy B", "feature", "old feature");
      raw
        .prepare(
          "INSERT INTO edges (from_id, to_id, relation, description) VALUES (?, ?, ?, ?)"
        )
        .run("legacy-a", "legacy-b", "informed_by", "legacy lineage");
      raw.pragma("user_version = 4");
      raw.close();
    }

    it("upgrades a v4 DB to v5: adds columns, preserves rows, new cols NULL", () => {
      const p = path.join(tmpDir, "v4-upgrade.db");
      seedV4Db(p);

      // Sanity: the seed really is v4-shaped (no status / no edge removed_at).
      const pre = new Database(p);
      expect(rawColumns(pre, "nodes")).not.toContain("status");
      expect(rawColumns(pre, "edges")).not.toContain("removed_at");
      expect(rawUserVersion(pre)).toBe(4);
      pre.close();

      // Reopen via KnowledgeDB → triggers the v5 migration.
      const upgraded = new KnowledgeDB(p);
      try {
        const raw = (upgraded as any).db;
        expect(rawColumns(raw, "nodes")).toContain("status");
        expect(rawColumns(raw, "edges")).toContain("removed_at");
        expect(rawUserVersion(raw)).toBe(5);

        // Existing rows preserved (count + key fields); new cols default NULL.
        expect(upgraded.getAllNodesRaw().length).toBe(2);
        const nodeA = upgraded.getNode("legacy-a")!;
        expect(nodeA.name).toBe("Legacy A");
        expect(nodeA.status).toBeNull();

        const edge = raw
          .prepare(
            "SELECT relation, removed_at FROM edges WHERE from_id = 'legacy-a' AND to_id = 'legacy-b'"
          )
          .get() as { relation: string; removed_at: string | null };
        expect(edge.relation).toBe("informed_by");
        expect(edge.removed_at).toBeNull();
      } finally {
        upgraded.close();
      }
    });

    it("is idempotent: reopening an already-v5 DB is a no-op", () => {
      const p = path.join(tmpDir, "v5-idempotent.db");
      seedV4Db(p);

      const first = new KnowledgeDB(p);
      const firstNodeCols = rawColumns((first as any).db, "nodes").sort();
      first.close();

      // Reopen → migrate() must short-circuit (version >= SCHEMA_VERSION).
      const second = new KnowledgeDB(p);
      try {
        const raw = (second as any).db;
        expect(rawUserVersion(raw)).toBe(5);
        expect(rawColumns(raw, "nodes").sort()).toEqual(firstNodeCols);
        expect(rawColumns(raw, "edges")).toContain("removed_at");
        // Data still intact after the second open.
        expect(second.getAllNodesRaw().length).toBe(2);
        expect(second.getNode("legacy-a")!.status).toBeNull();
      } finally {
        second.close();
      }
    });
  });
});
