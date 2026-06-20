import { describe, expect, it } from "vitest";
import { KnowledgeDB } from "../db.js";
import {
  computeHygieneFlags,
  createConcept,
  getConcept,
  link,
  provenanceAudit,
  provenanceTrace,
  removeConcept,
  updateConcept,
} from "../tools.js";
import type { NodeStatus } from "../types.js";

function insertNode(
  db: KnowledgeDB,
  id: string,
  options: { kind?: string; status?: NodeStatus | null; parent_id?: string | null; summary?: string } = {}
): void {
  db.insertNode({
    id,
    name: id,
    kind: options.kind ?? "feature",
    summary: options.summary ?? `${id} summary`,
    status: options.status,
    parent_id: options.parent_id,
  });
}

function ids(items: Array<{ id: string }>): string[] {
  return items.map((item) => item.id);
}

describe("tools provenance status threading", () => {
  it("includes node status in get_concept context", () => {
    const db = new KnowledgeDB(":memory:");
    db.insertNode({
      id: "decision",
      name: "Decision",
      kind: "decision",
      summary: "A decision with explicit status",
    });

    const raw = (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    raw.prepare("UPDATE nodes SET status = ? WHERE id = ?").run("validated", "decision");

    expect(getConcept(db, { id: "decision" }).status).toBe("validated");
  });

  it("includes null status for legacy concepts", () => {
    const db = new KnowledgeDB(":memory:");
    db.insertNode({
      id: "legacy",
      name: "Legacy",
      kind: "decision",
      summary: "A legacy decision without an explicit status",
    });

    const context = getConcept(db, { id: "legacy" });

    expect(context).toHaveProperty("status", null);
  });

  it("persists explicit status on create and update", async () => {
    const db = new KnowledgeDB(":memory:");

    const created = await createConcept(db, {
      name: "Validated Result",
      kind: "feature",
      summary: "A result with explicit validation status",
      status: "validated",
    });

    expect(getConcept(db, { id: created.id }).status).toBe("validated");

    await updateConcept(db, {
      id: created.id,
      changes: { status: "refuted", why: "Validation evidence was overturned by a follow-up check." },
    });

    expect(getConcept(db, { id: created.id }).status).toBe("refuted");
  });

  it("requires a rationale when updating status", async () => {
    const db = new KnowledgeDB(":memory:");
    const created = await createConcept(db, {
      name: "Rationale Required",
      kind: "decision",
      summary: "A decision whose status transition needs a reason",
    });

    await expect(
      updateConcept(db, {
        id: created.id,
        changes: { status: "abandoned" },
      })
    ).rejects.toThrow("Status changes require a non-empty why rationale");
  });

  it("defaults new decision concepts to open status", async () => {
    const db = new KnowledgeDB(":memory:");

    const created = await createConcept(db, {
      name: "Pending Decision",
      kind: "decision",
      summary: "A decision with no explicit status yet",
    });

    expect(getConcept(db, { id: created.id }).status).toBe("open");
  });
});

describe("tools informed_by write guards", () => {
  it("rejects informed_by links that would create a cycle", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "a");
    insertNode(db, "b");
    db.insertEdge({ from_id: "a", to_id: "b", relation: "informed_by" });

    expect(() =>
      link(db, { from: "b", to: "a", relation: "informed_by", description: "material support" })
    ).toThrow("would create an informed_by cycle");

    expect(db.getAllEdges().map((edge) => `${edge.from_id}->${edge.to_id}`)).toEqual(["a->b"]);
  });

  it("rejects create_concept self informed_by edges before insertion", async () => {
    const db = new KnowledgeDB(":memory:");

    await expect(
      createConcept(db, {
        name: "Self Cycle",
        kind: "decision",
        summary: "A decision cannot cite itself as material support",
        edges: [{ to: "self-cycle", relation: "informed_by", description: "self citation" }],
      })
    ).rejects.toThrow("would create an informed_by cycle");

    expect(db.getNode("self-cycle")).toBeUndefined();
  });
});

describe("tools remove_concept epistemic guard", () => {
  it("refuses and redirects protected epistemic nodes", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "decision", { kind: "decision", status: "open" });

    expect(() => removeConcept(db, { id: "decision", reason: "cleanup" })).toThrow(
      "Use update_concept to set status"
    );
    expect(db.getNode("decision")).toBeTruthy();
  });

  it("protects evidence with active incoming informed_by unless explicitly descriptive", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "decision", { kind: "decision", status: "open" });
    insertNode(db, "evidence", { kind: "feature" });
    db.insertEdge({ from_id: "decision", to_id: "evidence", relation: "informed_by" });

    expect(() => removeConcept(db, { id: "evidence", reason: "stale" })).toThrow(
      "incoming_informed_by"
    );

    const removed = removeConcept(db, {
      id: "evidence",
      reason: "descriptive code mirror removed",
      treat_as_descriptive: true,
    });
    expect(removed.message).toContain("Removed concept");
    expect(db.getNodeIncludingRemoved("evidence")?.removed_at).not.toBeNull();
  });
});

describe("provenance_trace", () => {
  it("traverses only active informed_by edges and annotates discourse cross-edges", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "container");
    insertNode(db, "decision", { kind: "decision", status: "open", parent_id: "container" });
    insertNode(db, "evidence", { status: "validated" });
    insertNode(db, "source", { status: "validated" });
    insertNode(db, "outside", { status: "validated" });
    db.insertEdge({ from_id: "decision", to_id: "evidence", relation: "informed_by" });
    db.insertEdge({ from_id: "evidence", to_id: "source", relation: "informed_by" });
    db.insertEdge({ from_id: "decision", to_id: "outside", relation: "depends_on" });
    db.insertEdge({ from_id: "evidence", to_id: "source", relation: "contradicts" });
    db.insertEdge({ from_id: "outside", to_id: "evidence", relation: "supersedes" });

    const trace = provenanceTrace(db, { target: "decision", direction: "upstream" });

    expect(ids(trace.nodes)).toEqual(["decision", "evidence", "source"]);
    expect(trace.edges.map((edge) => edge.relation)).toEqual(["informed_by", "informed_by"]);
    expect(trace.cross_edges.map((edge) => `${edge.from_id}:${edge.relation}:${edge.to_id}`)).toEqual([
      "evidence:contradicts:source",
    ]);
    expect(ids(trace.nodes)).not.toContain("container");
    expect(ids(trace.nodes)).not.toContain("outside");
    expect(trace.truncated).toBe(false);
  });

  it("enforces post-dedup traversal caps while traversing", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "decision", { kind: "decision", status: "open" });
    insertNode(db, "evidence");
    insertNode(db, "source");
    db.insertEdge({ from_id: "decision", to_id: "evidence", relation: "informed_by" });
    db.insertEdge({ from_id: "evidence", to_id: "source", relation: "informed_by" });

    const trace = provenanceTrace(db, {
      target: "decision",
      direction: "upstream",
      max_nodes: 2,
      max_edges: 10,
    });

    expect(ids(trace.nodes)).toEqual(["decision", "evidence"]);
    expect(trace.edges).toHaveLength(1);
    expect(trace.truncated).toBe(true);
    expect(trace.truncation_reason).toBe("max_nodes");
  });

  it("keeps full detail bounded by text and byte caps", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "decision", { kind: "decision", status: "open", summary: "x".repeat(200) });

    const trace = provenanceTrace(db, {
      target: "decision",
      direction: "upstream",
      detail: "full",
      max_text_chars: 25,
      max_bytes: 400,
    });

    expect(trace.nodes[0].summary.length).toBeLessThanOrEqual(25);
    expect(Buffer.byteLength(JSON.stringify(trace), "utf-8")).toBeLessThanOrEqual(400);
  });

  it("traverses downstream informed_by impact without following parent containment", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "container");
    insertNode(db, "source", { status: "validated", parent_id: "container" });
    insertNode(db, "evidence", { status: "validated" });
    insertNode(db, "decision", { kind: "decision", status: "open" });
    insertNode(db, "unrelated");
    db.insertEdge({ from_id: "decision", to_id: "evidence", relation: "informed_by" });
    db.insertEdge({ from_id: "evidence", to_id: "source", relation: "informed_by" });
    db.insertEdge({ from_id: "unrelated", to_id: "source", relation: "depends_on" });

    const trace = provenanceTrace(db, { target: "source", direction: "downstream" });

    expect(ids(trace.nodes)).toEqual(["source", "evidence", "decision"]);
    expect(trace.edges.map((edge) => `${edge.from_id}->${edge.to_id}`)).toEqual([
      "evidence->source",
      "decision->evidence",
    ]);
    expect(ids(trace.nodes)).not.toContain("container");
    expect(ids(trace.nodes)).not.toContain("unrelated");
  });

  it("honors depth limits during traversal", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "decision", { kind: "decision", status: "open" });
    insertNode(db, "evidence", { status: "validated" });
    insertNode(db, "source", { status: "validated" });
    db.insertEdge({ from_id: "decision", to_id: "evidence", relation: "informed_by" });
    db.insertEdge({ from_id: "evidence", to_id: "source", relation: "informed_by" });

    const trace = provenanceTrace(db, { target: "decision", direction: "upstream", depth: 1 });

    expect(ids(trace.nodes)).toEqual(["decision", "evidence"]);
    expect(trace.edges.map((edge) => `${edge.from_id}->${edge.to_id}`)).toEqual([
      "decision->evidence",
    ]);
    expect(trace.max_depth_reached).toBe(1);
    expect(trace.truncated).toBe(false);
  });

  it("does not enqueue disconnected nodes after the edge cap is exhausted", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "decision", { kind: "decision", status: "open" });
    insertNode(db, "evidence", { status: "validated" });
    insertNode(db, "source", { status: "validated" });
    db.insertEdge({ from_id: "decision", to_id: "evidence", relation: "informed_by" });
    db.insertEdge({ from_id: "evidence", to_id: "source", relation: "informed_by" });

    const trace = provenanceTrace(db, { target: "decision", direction: "upstream", max_edges: 0 });

    expect(ids(trace.nodes)).toEqual(["decision"]);
    expect(trace.edges).toHaveLength(0);
    expect(trace.truncated).toBe(true);
    expect(trace.truncation_reason).toBe("max_edges");
  });
});

describe("provenance_audit", () => {
  it("returns retrospective nodes with ancestry and replacements", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "bad", { kind: "decision", status: "refuted" });
    insertNode(db, "basis", { status: "validated" });
    insertNode(db, "replacement", { kind: "decision", status: "validated" });
    db.insertEdge({ from_id: "bad", to_id: "basis", relation: "informed_by" });
    db.insertEdge({ from_id: "replacement", to_id: "bad", relation: "supersedes" });

    const audit = provenanceAudit(db, { view: "retrospective" });

    expect(audit.items).toHaveLength(1);
    expect(audit.items[0].node.id).toBe("bad");
    expect(ids(audit.items[0].trace.nodes)).toContain("basis");
    expect(audit.items[0].replacements.map((node) => node.id)).toEqual(["replacement"]);
  });

  it("ranks frontier candidates with hub penalty over open and legacy-null nodes", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "strong", { status: "open" });
    insertNode(db, "legacy-null");
    insertNode(db, "hub", { status: "open" });
    insertNode(db, "validated-dependent", { status: "validated" });
    db.insertEdge({ from_id: "validated-dependent", to_id: "strong", relation: "informed_by" });
    for (let i = 0; i < 5; i += 1) {
      const id = `open-dependent-${i}`;
      insertNode(db, id, { status: "open" });
      db.insertEdge({ from_id: id, to_id: "hub", relation: "informed_by" });
    }
    insertNode(db, "legacy-dependent", { status: "validated" });
    db.insertEdge({ from_id: "legacy-dependent", to_id: "legacy-null", relation: "informed_by" });

    const audit = provenanceAudit(db, { view: "frontier", limit: 3 });

    expect(audit.items.map((item) => item.node.id)).toEqual(["legacy-null", "strong", "hub"]);
    expect(audit.items[0].components.hub_penalty).toBeGreaterThan(0);
    expect(audit.items[2].components.in_degree).toBe(5);
  });

  it("lists only legacy NULL nodes participating in epistemic relations for triage", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "legacy-basis");
    insertNode(db, "legacy-contradiction");
    insertNode(db, "open-node", { status: "open" });
    insertNode(db, "plain-null");
    insertNode(db, "decision", { kind: "decision", status: "open" });
    db.insertEdge({ from_id: "decision", to_id: "legacy-basis", relation: "informed_by" });
    db.insertEdge({ from_id: "legacy-contradiction", to_id: "decision", relation: "contradicts" });

    const audit = provenanceAudit(db, { view: "triage" });

    expect(audit.items.map((item) => item.node.id)).toEqual([
      "legacy-basis",
      "legacy-contradiction",
    ]);
    expect(audit.items.map((item) => item.node.id)).not.toContain("open-node");
    expect(audit.items.map((item) => item.node.id)).not.toContain("plain-null");
  });
});

describe("provenance hygiene flags", () => {
  it("flags unvalidated ancestry, discourse inconsistencies, tombstones, and cycles", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "validated", { status: "validated" });
    insertNode(db, "open-basis", { status: "open" });
    insertNode(db, "validated-a", { status: "validated" });
    insertNode(db, "validated-b", { status: "validated" });
    insertNode(db, "newer", { status: "validated" });
    insertNode(db, "old-target", { status: "open" });
    insertNode(db, "broken-a", { status: "validated" });
    insertNode(db, "broken-b", { status: "validated" });
    db.insertEdge({ from_id: "validated", to_id: "open-basis", relation: "informed_by" });
    db.insertEdge({ from_id: "validated-a", to_id: "validated-b", relation: "contradicts" });
    db.insertEdge({ from_id: "newer", to_id: "old-target", relation: "supersedes" });
    db.insertEdge({ from_id: "broken-a", to_id: "broken-b", relation: "contradicts" });
    db.softDeleteNode("broken-b", "obsolete endpoint");
    // Defensive cycle detection uses raw active data, including corruption from pre-v5 imports.
    db.insertEdge({ from_id: "open-basis", to_id: "validated", relation: "informed_by" });

    const flags = computeHygieneFlags(db);
    const flagTypes = flags.map((flag) => flag.type);

    expect(flagTypes).toContain("validated_rests_on_unvalidated");
    expect(flagTypes).toContain("validated_contradiction");
    expect(flagTypes).toContain("trusted_contradicted_by_validated");
    expect(flagTypes).toContain("supersedes_target_not_superseded");
    expect(flagTypes).toContain("broken_contradiction");
    expect(flagTypes).toContain("cycle_detected");
  });

  it("flags tombstoned informed_by chains", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "decision", { kind: "decision", status: "open" });
    insertNode(db, "evidence", { status: "validated" });
    db.insertEdge({ from_id: "decision", to_id: "evidence", relation: "informed_by" });
    db.softDeleteNode("evidence", "source removed");

    const flags = computeHygieneFlags(db);

    expect(flags).toContainEqual(
      expect.objectContaining({
        type: "broken_chain",
        node: "decision",
        offending_ancestor: "evidence",
      })
    );
  });

  it("flags tombstoned supersedes relations", () => {
    const db = new KnowledgeDB(":memory:");
    insertNode(db, "newer", { status: "validated" });
    insertNode(db, "old", { status: "superseded" });
    db.insertEdge({ from_id: "newer", to_id: "old", relation: "supersedes" });
    db.softDeleteNode("old", "obsolete version removed");

    const flags = computeHygieneFlags(db);

    expect(flags).toContainEqual(
      expect.objectContaining({
        type: "broken_supersedes",
        node: "newer",
        offending_ancestor: "old",
      })
    );
  });
});
