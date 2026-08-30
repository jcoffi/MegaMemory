import { describe, expect, it } from "vitest";
import { KnowledgeDB } from "../db.js";
import { computeCensus } from "../stats.js";
import type { NodeStatus } from "../types.js";

function addNode(db: KnowledgeDB, id: string, status?: NodeStatus): void {
  db.insertNode({
    id,
    name: id,
    kind: "feature",
    summary: "s",
    why: null,
    file_refs: null,
    parent_id: null,
    created_by_task: null,
    embedding: null,
    ...(status ? { status } : {}),
  });
}

describe("computeCensus", () => {
  it("counts nodes by status, filing unstatused under (none)", () => {
    const db = new KnowledgeDB(":memory:");
    addNode(db, "a", "open");
    addNode(db, "b", "validated");
    addNode(db, "c", "validated");
    addNode(db, "d");

    const census = computeCensus(db);

    expect(census.statuses).toEqual({ open: 1, validated: 2, "(none)": 1 });
    db.close();
  });

  it("counts active edges by relation and reports tombstoned separately", () => {
    const db = new KnowledgeDB(":memory:");
    addNode(db, "a");
    addNode(db, "b");
    addNode(db, "c");
    db.insertEdge({ from_id: "a", to_id: "b", relation: "informed_by", description: "why" });
    db.insertEdge({ from_id: "a", to_id: "c", relation: "depends_on", description: null });
    // Removing a node tombstones its incident edges rather than deleting them.
    db.softDeleteNode("c", "gone");

    const census = computeCensus(db);

    expect(census.relations).toEqual({ informed_by: 1 });
    expect(census.tombstonedEdges).toBe(1);
    db.close();
  });

  it("splits unstatused nodes by whether anything cites them as evidence", () => {
    const db = new KnowledgeDB(":memory:");
    addNode(db, "decision", "open");
    addNode(db, "cited-basis");
    addNode(db, "lonely-descriptive");
    db.insertEdge({ from_id: "decision", to_id: "cited-basis", relation: "informed_by", description: "why" });

    const census = computeCensus(db);

    expect(census.provenance).toEqual({ unstatused: 2, unstatusedCited: 1, unstatusedUncited: 1 });
    db.close();
  });

  it("does not count a tombstoned informed_by edge as a citation", () => {
    const db = new KnowledgeDB(":memory:");
    addNode(db, "decision", "open");
    addNode(db, "basis");
    db.insertEdge({ from_id: "decision", to_id: "basis", relation: "informed_by", description: "why" });
    // Tombstone the citing side; the edge is tombstoned with it.
    db.softDeleteNode("decision", "gone");

    const census = computeCensus(db);

    expect(census.provenance.unstatusedCited).toBe(0);
    expect(census.provenance.unstatusedUncited).toBe(1);
    db.close();
  });

  it("reports empty groups for an empty graph", () => {
    const db = new KnowledgeDB(":memory:");
    const census = computeCensus(db);
    expect(census.statuses).toEqual({});
    expect(census.relations).toEqual({});
    expect(census.tombstonedEdges).toBe(0);
    expect(census.provenance).toEqual({ unstatused: 0, unstatusedCited: 0, unstatusedUncited: 0 });
    db.close();
  });
});
