import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";
import { KnowledgeDB } from "../db.js";
import { createTimelineLogger } from "../timeline.js";
import { registerTools, instructionsStaleFrom } from "../index.js";

// ---- Test harness ----
//
// index.ts registers MCP tools on an McpServer via `registerTools`. To exercise
// the registration (descriptions, Zod schemas, handlers) without standing up a
// stdio transport, we pass a lightweight "capture" server that records every
// `server.tool(name, description, schema, handler)` call. This drives the REAL
// schemas and handlers against a REAL in-memory KnowledgeDB.

type ToolEntry = {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (params: any) => Promise<{ content: { type: string; text: string }[] }>;
};

function buildRegistry(): {
  registry: Record<string, ToolEntry>;
  server: any;
} {
  const registry: Record<string, ToolEntry> = {};
  const server = {
    tool(
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      handler: ToolEntry["handler"]
    ) {
      registry[name] = { name, description, schema, handler };
    },
  };
  return { registry, server };
}

function parseHandlerJson(out: {
  content: { type: string; text: string }[];
}): any {
  return JSON.parse(out.content[0].text);
}

let tmpDir: string;
let db: KnowledgeDB;

async function setup(opts?: {
  isInstructionsStale?: () => boolean;
}): Promise<Record<string, ToolEntry>> {
  const { registry, server } = buildRegistry();
  db = new KnowledgeDB(path.join(tmpDir, "index-test.db"));
  const timeline = createTimelineLogger(db);
  await registerTools(server, {
    db,
    timeline,
    version: "9.9.9",
    isInstructionsStale: opts?.isInstructionsStale ?? (() => false),
  });
  return registry;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-index-test-"));
});

afterEach(() => {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("registerTools — baseline registration", () => {
  it("registers the core read and write tools", async () => {
    const registry = await setup();
    for (const name of [
      "understand",
      "get_concept",
      "create_concept",
      "update_concept",
      "link",
      "remove_concept",
      "list_roots",
      "list_conflicts",
      "resolve_conflict",
    ]) {
      expect(registry[name], `tool ${name} should be registered`).toBeDefined();
      expect(typeof registry[name].handler).toBe("function");
      expect(registry[name].description.length).toBeGreaterThan(0);
    }
  });
});

describe("provenance relation enum (P1.2 / §2.1)", () => {
  const newRelations = ["informed_by", "supersedes", "contradicts"] as const;

  it("link accepts the three provenance relations", async () => {
    const registry = await setup();
    const linkSchema = z.object(registry.link.schema);
    for (const relation of newRelations) {
      const parsed = linkSchema.safeParse({ from: "a", to: "b", relation });
      expect(parsed.success, `link should accept relation ${relation}`).toBe(
        true
      );
    }
  });

  it("link still accepts the pre-existing relations", async () => {
    const registry = await setup();
    const linkSchema = z.object(registry.link.schema);
    for (const relation of [
      "connects_to",
      "depends_on",
      "implements",
      "calls",
      "configured_by",
    ]) {
      expect(
        linkSchema.safeParse({ from: "a", to: "b", relation }).success,
        `link should still accept ${relation}`
      ).toBe(true);
    }
  });

  it("link rejects an unknown relation", async () => {
    const registry = await setup();
    const linkSchema = z.object(registry.link.schema);
    expect(
      linkSchema.safeParse({ from: "a", to: "b", relation: "inspired_by" })
        .success
    ).toBe(false);
  });

  it("create_concept edges accept the provenance relations", async () => {
    const registry = await setup();
    const createSchema = z.object(registry.create_concept.schema);
    for (const relation of newRelations) {
      const parsed = createSchema.safeParse({
        name: "n",
        kind: "decision",
        summary: "s",
        edges: [{ to: "ev", relation, description: "materially supported by" }],
      });
      expect(
        parsed.success,
        `create_concept.edges should accept ${relation}`
      ).toBe(true);
    }
  });
});

describe("evidential tool descriptions (P9.1 / §1.3)", () => {
  it("no tool description makes causal claims — BLOCKING §1.3", async () => {
    const registry = await setup();
    for (const tool of Object.values(registry)) {
      // The only sanctioned use of the word is the explicit disclaimer
      // "not causal inference"; strip it, then forbid any remaining "causal".
      const stripped = tool.description.replace(/not causal inference/gi, "");
      expect(
        /causal/i.test(stripped),
        `${tool.name} description must not make causal claims`
      ).toBe(false);
      expect(
        /counterfactual/i.test(tool.description),
        `${tool.name} description must not mention counterfactuals`
      ).toBe(false);
      expect(
        /do-?calculus/i.test(tool.description),
        `${tool.name} description must not mention do-calculus`
      ).toBe(false);
      expect(
        /causal discovery/i.test(tool.description),
        `${tool.name} description must not claim causal discovery`
      ).toBe(false);
    }
  });

  it("create_concept guidance covers informed_by + evidential framing", async () => {
    const registry = await setup();
    const d = registry.create_concept.description;
    expect(d).toMatch(/informed_by/);
    expect(d).toMatch(/evidenc/i); // evidence / evidential
  });

  it("link guidance covers the three provenance relations, evidentially", async () => {
    const registry = await setup();
    const d = registry.link.description;
    expect(d).toMatch(/informed_by/);
    expect(d).toMatch(/supersedes/);
    expect(d).toMatch(/contradicts/);
    expect(d).toMatch(/not causal inference/i);
  });

  it("remove_concept drops the false 'preserved in history' claim and redirects epistemic records", async () => {
    const registry = await setup();
    const d = registry.remove_concept.description;
    expect(d).not.toMatch(/preserved in history/i);
    expect(d).toMatch(/informed_by|epistemic|lifecycle|transition/i);
  });

  it("update_concept guidance covers how understanding evolved", async () => {
    const registry = await setup();
    const d = registry.update_concept.description;
    expect(d).toMatch(/evolv|supersed|lifecycle|status/i);
  });
});

describe("stale-instructions signal on read tools (P9.2 / §3.3)", () => {
  it("list_roots output carries server_version + instructions_stale (MCP-visible, not stderr)", async () => {
    const registry = await setup({ isInstructionsStale: () => false });
    const json = parseHandlerJson(await registry.list_roots.handler({}));
    expect(json.server_version).toBe("9.9.9");
    expect(json.instructions_stale).toBe(false);
    // existing payload is preserved
    expect(Array.isArray(json.roots)).toBe(true);
    expect(json.stats).toBeDefined();
  });

  it("list_roots reflects a stale predicate", async () => {
    const registry = await setup({ isInstructionsStale: () => true });
    const json = parseHandlerJson(await registry.list_roots.handler({}));
    expect(json.instructions_stale).toBe(true);
    expect(json.server_version).toBe("9.9.9");
  });

  it("understand output carries server_version + instructions_stale", async () => {
    const registry = await setup({ isInstructionsStale: () => true });
    const json = parseHandlerJson(
      await registry.understand.handler({ query: "anything" })
    );
    expect(json.server_version).toBe("9.9.9");
    expect(json.instructions_stale).toBe(true);
    expect(Array.isArray(json.matches)).toBe(true);
  });

  it("instructionsStaleFrom: stale only when installed version is known AND older than server", () => {
    expect(instructionsStaleFrom("1.5.0", "1.6.1")).toBe(true);
    expect(instructionsStaleFrom("1.6.0", "1.6.1")).toBe(true);
    expect(instructionsStaleFrom("1.6.1", "1.6.1")).toBe(false);
    expect(instructionsStaleFrom("1.7.0", "1.6.1")).toBe(false);
    expect(instructionsStaleFrom(undefined, "1.6.1")).toBe(false);
    expect(instructionsStaleFrom(null, "1.6.1")).toBe(false);
    expect(instructionsStaleFrom("", "1.6.1")).toBe(false);
  });
});

describe("status params on create/update (P2.3 / §2.2, §4.1)", () => {
  const statuses = [
    "open",
    "validated",
    "refuted",
    "superseded",
    "abandoned",
  ] as const;

  it("create_concept recognizes each valid status (not stripped) and rejects invalid", async () => {
    const registry = await setup();
    const schema = z.object(registry.create_concept.schema);
    for (const s of statuses) {
      const p = schema.safeParse({
        name: "n",
        kind: "decision",
        summary: "sum",
        status: s,
      });
      expect(p.success).toBe(true);
      // status must be a recognized field (Zod would strip it if absent from the schema)
      expect(p.success && p.data.status).toBe(s);
    }
    expect(
      schema.safeParse({
        name: "n",
        kind: "decision",
        summary: "sum",
        status: "bogus",
      }).success
    ).toBe(false);
  });

  it("create_concept status is optional", async () => {
    const registry = await setup();
    const schema = z.object(registry.create_concept.schema);
    expect(
      schema.safeParse({ name: "n", kind: "feature", summary: "sum" }).success
    ).toBe(true);
  });

  it("update_concept.changes recognizes a valid status (not stripped) and rejects invalid", async () => {
    const registry = await setup();
    const schema = z.object(registry.update_concept.schema);
    const p = schema.safeParse({
      id: "x",
      changes: { status: "validated", why: "confirmed by the test scope" },
    });
    expect(p.success).toBe(true);
    expect(p.success && p.data.changes.status).toBe("validated");
    expect(
      schema.safeParse({ id: "x", changes: { status: "bogus" } }).success
    ).toBe(false);
  });
});

describe("treat_as_descriptive on remove_concept (P5.2 / §4.4)", () => {
  it("remove_concept recognizes treat_as_descriptive (not stripped) and requires a boolean", async () => {
    const registry = await setup();
    const schema = z.object(registry.remove_concept.schema);
    const p = schema.safeParse({
      id: "x",
      reason: "re-derivable from code",
      treat_as_descriptive: true,
    });
    expect(p.success).toBe(true);
    expect(p.success && p.data.treat_as_descriptive).toBe(true);
    expect(
      schema.safeParse({ id: "x", reason: "r", treat_as_descriptive: "yes" })
        .success
    ).toBe(false);
  });

  it("remove_concept treat_as_descriptive is optional", async () => {
    const registry = await setup();
    const schema = z.object(registry.remove_concept.schema);
    expect(schema.safeParse({ id: "x", reason: "r" }).success).toBe(true);
  });
});
