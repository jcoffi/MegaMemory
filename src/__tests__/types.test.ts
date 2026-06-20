import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function compileContract(sourceFor: (tempDir: string) => string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-types-"));
  const contractPath = path.join(tempDir, "contract.mts");
  try {
    fs.writeFileSync(contractPath, sourceFor(tempDir));

    const program = ts.createProgram([contractPath], {
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: ["node"],
    });

    const diagnostics = ts.getPreEmitDiagnostics(program);
    return diagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
      .join("\n");
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

describe("provenance type contract", () => {
  it("accepts provenance relations, node status, and edge tombstone fields", () => {
    const diagnostics = compileContract((tempDir) => {
      const typesImport = path
        .relative(tempDir, path.resolve(process.cwd(), "src/types.js"))
        .replace(/\\/g, "/");

      return `
      import type {
        CreateConceptInput,
        Edge,
        EdgeRow,
        Node,
        NodeRow,
        NodeStatus,
        NodeWithContext,
        RelationType,
        UpdateConceptInput,
      } from "${typesImport.startsWith(".") ? typesImport : `./${typesImport}`}";

      const relation: RelationType = "informed_by";
      const supersedes: RelationType = "supersedes";
      const contradiction: RelationType = "contradicts";
      const status: NodeStatus = "open";

      const createInput: CreateConceptInput = {
        name: "Decision",
        kind: "decision",
        summary: "Summary",
        status,
        edges: [{ to: "evidence", relation, description: "material support" }],
      };

      const updateInput: UpdateConceptInput = {
        id: "decision",
        changes: { status: "validated" },
      };

      const node: Node = {
        id: "decision",
        name: "Decision",
        kind: "decision",
        summary: "Summary",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        created_at: "2026-06-19T00:00:00.000Z",
        updated_at: "2026-06-19T00:00:00.000Z",
        removed_at: null,
        removed_reason: null,
        merge_group: null,
        needs_merge: false,
        source_branch: null,
        merge_timestamp: null,
        status: null,
      };

      const nodeRow: NodeRow = {
        ...node,
        kind: "decision",
        file_refs: null,
        embedding: null,
        needs_merge: 0,
      };

      const edge: Edge = {
        id: 1,
        from_id: "decision",
        to_id: "evidence",
        relation: supersedes,
        description: null,
        created_at: "2026-06-19T00:00:00.000Z",
        merge_group: null,
        needs_merge: false,
        source_branch: null,
        merge_timestamp: null,
        removed_at: null,
      };

      const edgeRow: EdgeRow = {
        ...edge,
        relation: contradiction,
        needs_merge: 0,
      };

      const context: NodeWithContext = {
        id: "decision",
        name: "Decision",
        kind: "decision",
        summary: "Summary",
        why: null,
        file_refs: null,
        status: "refuted",
        children: [],
        edges: [{ to: "evidence", to_name: "Evidence", relation, description: null }],
        incoming_edges: [],
        parent: null,
      };

      void createInput;
      void updateInput;
      void nodeRow;
      void edgeRow;
      void context;
    `;
    });

    expect(diagnostics).toBe("");
  });
});
