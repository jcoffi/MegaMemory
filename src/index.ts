#!/usr/bin/env node

import { readFileSync, realpathSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import pc from "picocolors";
import { errorBold, validatePort } from "./cli-utils.js";
import { createTimelineLogger } from "./timeline.js";

// ---- CLI routing ----

const VERSION = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8"
  )
).version;

const HELP = `
${pc.bold(pc.cyan("megamemory"))} ${pc.green(`v${VERSION}`)} ${pc.dim("— persistent project knowledge graph for coding agents")}

${pc.bold("Commands:")}
  ${pc.cyan("(no command)")}    Start the MCP stdio server ${pc.dim("(invoked by your editor)")}
  ${pc.cyan("install")}         Configure editor/agent integration (interactive)
  ${pc.cyan("serve")}           Start the web graph explorer
  ${pc.cyan("stats")}           Show knowledge graph statistics
  ${pc.cyan("merge")}           Merge two knowledge.db files
  ${pc.cyan("conflicts")}       List unresolved merge conflicts
  ${pc.cyan("resolve")}         Resolve a merge conflict

${pc.bold("Options:")}
  ${pc.cyan("--target")} ${pc.dim("NAME")}    Install target (opencode, claudecode, antigravity, codex)
  ${pc.cyan("--port")} ${pc.dim("PORT")}     Port for the web explorer ${pc.dim("(default: 4321)")}
  ${pc.cyan("--into")} ${pc.dim("FILE")}     Output path for merge ${pc.dim("(default: overwrites file1)")}
  ${pc.cyan("--left-label")}    Label for left side in merge ${pc.dim("(default: left)")}
  ${pc.cyan("--right-label")}   Label for right side in merge ${pc.dim("(default: right)")}
  ${pc.cyan("--keep")}          Resolution strategy: left, right, or both
  ${pc.cyan("--json")}          Machine-readable output for conflicts
  ${pc.cyan("--db")} ${pc.dim("PATH")}       Database path for stats/conflicts/resolve
  ${pc.cyan("--help, -h")}      Show this help
  ${pc.cyan("--version, -v")}   Show version

${pc.bold("Examples:")}
  ${pc.dim("$")} megamemory install                                   ${pc.dim("Interactive editor integration setup")}
  ${pc.dim("$")} megamemory install --target claudecode              ${pc.dim("Non-interactive Claude Code setup")}
  ${pc.dim("$")} megamemory serve                                     ${pc.dim(`Open graph explorer at ${pc.underline("http://localhost:4321")}`)}
  ${pc.dim("$")} megamemory serve --port 8080                         ${pc.dim("Custom port")}
  ${pc.dim("$")} megamemory merge main.db feature.db --into merged.db ${pc.dim("Merge two knowledge DBs")}
  ${pc.dim("$")} megamemory conflicts                                 ${pc.dim("View unresolved conflicts")}
  ${pc.dim("$")} megamemory resolve <group-id> --keep left            ${pc.dim("Resolve a conflict")}
`.trim();

const KNOWN_COMMANDS = new Set(["install", "serve", "stats", "merge", "conflicts", "resolve", "--help", "-h", "--version", "-v"]);

function parseFlags(args: string[]): { port?: number; rawPort?: string } {
  const portIdx = args.indexOf("--port");
  const rawPort = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : undefined;
  const port = rawPort ? parseInt(rawPort, 10) : undefined;
  return { port, rawPort };
}

async function runCli(): Promise<void> {
  const cmd = process.argv[2];

  switch (cmd) {
    case "install": {
      const { runInstall } = await import("./install.js");
      await runInstall(process.argv.slice(3));
      process.exit(0);
      break;
    }

    case "serve": {
      const flags = parseFlags(process.argv.slice(3));
      const port = flags.port ?? 4321;

      const portError = validatePort(port, flags.rawPort);
      if (portError) {
        errorBold(portError);
        process.exit(1);
      }

      const { runServe } = await import("./web.js");
      await runServe(port);
      break;
    }

    case "stats": {
      const { runStats } = await import("./stats.js");
      await runStats(process.argv.slice(3));
      process.exit(0);
      break;
    }

    case "merge": {
      const { runMerge } = await import("./merge-cli.js");
      await runMerge(process.argv.slice(3));
      process.exit(0);
      break;
    }

    case "conflicts": {
      const { runConflicts } = await import("./merge-cli.js");
      await runConflicts(process.argv.slice(3));
      process.exit(0);
      break;
    }

    case "resolve": {
      const { runResolve } = await import("./merge-cli.js");
      await runResolve(process.argv.slice(3));
      process.exit(0);
      break;
    }

    case "--help":
    case "-h":
      console.log(HELP);
      process.exit(0);
      break;

    case "--version":
    case "-v":
      console.log(`${pc.bold("megamemory")} ${pc.green(`v${VERSION}`)}`);
      process.exit(0);
      break;

    default:
      if (cmd && !KNOWN_COMMANDS.has(cmd)) {
        // User typed an unknown command — don't silently start MCP
        errorBold(`Unknown command '${cmd}'.`);
        console.log(pc.dim(`  Run ${pc.cyan("megamemory --help")} for usage.\n`));
        process.exit(1);
      }
      // No command → start MCP server (normal invocation by editor)
      try {
        await startMcpServer();
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`MEGAMEMORY_ERROR: ${errorMsg}`);
        process.exit(1);
      }
      break;
  }
}

/**
 * True only when this module is executed directly as the CLI entry point
 * (`megamemory` / `node dist/index.js`), false when imported (e.g. by tests).
 * `realpathSync` resolves the bin symlink created by global installs so the
 * path matches `import.meta.url` (which is already the real module path).
 */
function isEntryPoint(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  await runCli();
}

// ---- MCP Server ----

async function startMcpServer() {
  const { McpServer } = await import(
    "@modelcontextprotocol/sdk/server/mcp.js"
  );
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const path = await import("path");
  const { KnowledgeDB } = await import("./db.js");

  // ---- Configuration ----
  const DB_PATH =
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db");

  const db = new KnowledgeDB(DB_PATH);
  const timeline = createTimelineLogger(db);

  let dbClosed = false;
  function shutdown() {
    if (dbClosed) return;
    dbClosed = true;
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  const server = new McpServer({
    name: "megamemory",
    version: VERSION,
  });

  await registerTools(server, {
    db,
    timeline,
    version: VERSION,
    isInstructionsStale: () =>
      instructionsStaleFrom(process.env.MEGAMEMORY_INSTRUCTIONS_VERSION, VERSION),
  });

  // ---- Start ----
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`megamemory MCP server started (db: ${DB_PATH})`);
}

/**
 * Pure staleness check for the installed agent-instruction files. Returns true
 * only when an installed instruction version is KNOWN and strictly older than
 * the running server version; when the installed version is unknown it returns
 * false rather than fabricating staleness (§3.3 — never manufacture state).
 *
 * The installed version is stamped by the install layer (Phase 9.3, into the
 * AGENTS.md/CLAUDE.md provenance block) and read here from
 * MEGAMEMORY_INSTRUCTIONS_VERSION. The signal is surfaced on the MCP-visible
 * read tools (list_roots / understand), never on stderr/console.error.
 */
export function instructionsStaleFrom(
  installedVersion: string | undefined | null,
  serverVersion: string
): boolean {
  if (!installedVersion) return false;
  return compareSemver(installedVersion, serverVersion) < 0;
}

/** Numeric dot-segment compare: -1 if a<b, 1 if a>b, 0 if equal or unparseable. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Registers every MegaMemory tool on the given MCP server. Extracted from the
 * server bootstrap so the tool surface (descriptions, Zod schemas, handlers)
 * is unit-testable without standing up a stdio transport. `deps` injects the
 * open knowledge DB, the timeline logger, the server version, and a staleness
 * predicate used to decorate read-tool output.
 */
export async function registerTools(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  deps: {
    db: import("./db.js").KnowledgeDB;
    timeline: ReturnType<typeof createTimelineLogger>;
    version: string;
    isInstructionsStale?: () => boolean;
  }
): Promise<void> {
  const { z } = await import("zod");
  const { understand, getConcept, createConcept, updateConcept, link, removeConcept, listRoots, listConflicts, resolveConflict, provenanceTrace, provenanceAudit, formatError } =
    await import("./tools.js");

  type NodeKind = import("./types.js").NodeKind;
  type RelationType = import("./types.js").RelationType;

  const { db, timeline, version } = deps;
  const isInstructionsStale = deps.isInstructionsStale ?? (() => false);

  // ---- Zod schemas ----
  const NodeKindEnum = z.enum([
    "feature", "module", "pattern", "config", "decision", "component",
  ]);
  const RelationEnum = z.enum([
    "connects_to", "depends_on", "implements", "calls", "configured_by",
    // Evidential provenance (§2.1): informed_by = material evidential support
    // (strict DAG), supersedes = replacement, contradicts = conflict. These
    // record authored evidential provenance, not causal inference.
    "informed_by", "supersedes", "contradicts",
  ]);
  const NodeStatusEnum = z.enum([
    // Epistemic status (§2.2). NULL/absent = legacy/unknown, never treated as validated.
    "open", "validated", "refuted", "superseded", "abandoned",
  ]);

  // ---- Register tools ----

  server.tool(
    "understand",
    "Query the project knowledge graph. Call this before starting any task to load relevant context about concepts, features, and architecture. Returns matched concepts with their children, edges, and parent context.",
    {
      query: z.string().describe("Natural language query describing what you want to understand about the project"),
      top_k: z.number().int().min(1).max(50).optional().describe("Number of top results to return (default: 10)"),
    },
    async (params) => {
      try {
        const result = await understand(db, { query: params.query, top_k: params.top_k });
        timeline.log({
          tool: "understand",
          params: { query: params.query, top_k: params.top_k },
          result_summary: `${result.matches.length} matches`,
          is_write: false,
          is_error: false,
          affected_ids: result.matches.map((match) => match.id),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...result, server_version: version, instructions_stale: isInstructionsStale() }, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "understand",
          params: { query: params.query, top_k: params.top_k },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "get_concept",
    "Look up a concept by its exact ID. Returns the concept with its full context including children, edges, incoming edges, and parent. Unlike 'understand' which uses semantic search, this does exact ID matching. Use this when you know the specific concept ID.",
    {
      id: z.string().describe("Exact concept ID to look up (e.g., 'auth-module' or 'database-config')"),
    },
    async (params) => {
      try {
        const result = getConcept(db, { id: params.id });
        timeline.log({
          tool: "get_concept",
          params: { id: params.id },
          result_summary: `found ${result.id}`,
          is_write: false,
          is_error: false,
          affected_ids: [result.id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "get_concept",
          params: { id: params.id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "create_concept",
    "Add a new concept to the knowledge graph. Call this after completing a task to record new features, components, patterns, or decisions you built. Include specific details: parameter names, defaults, file locations, and rationale. When recording a decision, experiment, or result, attach `informed_by` edges (in `edges`) to the evidence, prior results, assumptions, or decision basis that materially supported it, with the supporting rationale in each edge's `description`. `informed_by` records authored evidential support, not causal inference.",
    {
      name: z.string().describe("Human-readable name for the concept"),
      kind: NodeKindEnum.describe("Type of concept: feature, module, pattern, config, decision, component"),
      summary: z.string().describe("What this concept is. Be specific: include parameter names, defaults, file paths, behavior details."),
      status: NodeStatusEnum.optional().describe("Epistemic status for decisions/experiments/results: open (proposed — explicitly not a correctness claim) | validated (confirmed correct for a stated scope, by explicit evidence) | refuted (concluded incorrect — kept as a record) | superseded | abandoned. Omit for descriptive concepts that mirror code; new epistemic records start open."),
      why: z.string().optional().describe("Why this exists or was built this way"),
      parent_id: z.string().optional().describe("Parent concept ID for nesting"),
      file_refs: z.array(z.string()).optional().describe("Relevant file paths + optional line ranges"),
      edges: z.array(z.object({
        to: z.string().describe("Target concept ID"),
        relation: RelationEnum.describe("Relationship type"),
        description: z.string().optional().describe("Why this relationship exists"),
      })).optional().describe("Relationships to other existing concepts"),
      created_by_task: z.string().optional().describe("Description of the task that created this concept"),
    },
    async (params) => {
      try {
        const result = await createConcept(db, {
          name: params.name,
          kind: params.kind as NodeKind,
          summary: params.summary,
          status: params.status,
          why: params.why,
          parent_id: params.parent_id,
          file_refs: params.file_refs,
          edges: params.edges?.map((e) => ({ ...e, relation: e.relation as RelationType })),
          created_by_task: params.created_by_task,
        });
        timeline.log({
          tool: "create_concept",
          params: { name: params.name, kind: params.kind, parent_id: params.parent_id },
          result_summary: `created ${result.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [result.id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "create_concept",
          params: { name: params.name, kind: params.kind, parent_id: params.parent_id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "update_concept",
    "Update an existing concept in the knowledge graph. Call this after completing a task that changed existing features or components. Only include fields that changed. Use this to keep a concept's recorded rationale current as understanding evolves — for example when a decision is later confirmed, overturned, or superseded — rather than deleting the reasoning that came before.",
    {
      id: z.string().describe("The concept ID to update"),
      changes: z.object({
        name: z.string().optional().describe("New name"),
        kind: NodeKindEnum.optional().describe("New kind"),
        summary: z.string().optional().describe("Updated summary"),
        status: NodeStatusEnum.optional().describe("New epistemic status (open | validated | refuted | superseded | abandoned). `validated` must be earned by explicit evidence for a stated scope, never assumed; record that scope in `why`. Every status change requires a non-empty `why` rationale."),
        why: z.string().optional().describe("Updated rationale"),
        file_refs: z.array(z.string()).optional().describe("Updated file references"),
      }),
    },
    async (params) => {
      try {
        const result = await updateConcept(db, {
          id: params.id,
          changes: { ...params.changes, kind: params.changes.kind as NodeKind | undefined },
        });
        timeline.log({
          tool: "update_concept",
          params: { id: params.id, changed_fields: Object.keys(params.changes) },
          result_summary: `updated ${params.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [params.id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "update_concept",
          params: { id: params.id, changed_fields: Object.keys(params.changes) },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "link",
    "Create a relationship between two existing concepts. Use `informed_by` to record that one concept (a decision or finding) was materially supported by another (evidence, a prior result, an assumption, or a decision basis), with the supporting rationale in `description`; use `supersedes` when one concept replaces another, and `contradicts` when two conflict. These relations capture authored evidential provenance, not causal inference.",
    {
      from: z.string().describe("Source concept ID"),
      to: z.string().describe("Target concept ID"),
      relation: RelationEnum.describe("Relationship type"),
      description: z.string().optional().describe("Why this relationship exists"),
    },
    async (params) => {
      try {
        const result = link(db, {
          from: params.from, to: params.to,
          relation: params.relation as RelationType,
          description: params.description,
        });
        timeline.log({
          tool: "link",
          params: { from: params.from, to: params.to, relation: params.relation },
          result_summary: `linked ${params.from} -> ${params.to}`,
          is_write: true,
          is_error: false,
          affected_ids: [params.from, params.to],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "link",
          params: { from: params.from, to: params.to, relation: params.relation },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "remove_concept",
    "Remove a concept from the knowledge graph. Use this for descriptive concepts that mirror code and can be re-derived. Epistemic records — decisions, experiments, results, or any concept that other concepts are `informed_by` — should be kept and transitioned through their lifecycle rather than removed, so their reasoning lineage is not lost.",
    {
      id: z.string().describe("The concept ID to remove"),
      reason: z.string().describe("Why this concept is being removed"),
      treat_as_descriptive: z.boolean().optional().describe("Set true only for a genuinely descriptive concept (mirrors code, re-derivable) so it may be removed even though other concepts are `informed_by` it — those edges are tombstoned, not lost. Concepts that carry a status, or are a `decision`, stay protected regardless of this flag; transition their status with update_concept instead."),
    },
    async (params) => {
      try {
        const result = removeConcept(db, { id: params.id, reason: params.reason, treat_as_descriptive: params.treat_as_descriptive });
        timeline.log({
          tool: "remove_concept",
          params: { id: params.id },
          result_summary: `removed ${params.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [params.id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "remove_concept",
          params: { id: params.id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "list_roots",
    "List all top-level concepts in the knowledge graph with their direct children. Call this at the start of a session to get a high-level project overview.",
    {},
    async () => {
      try {
        const result = listRoots(db);
        timeline.log({
          tool: "list_roots",
          params: {},
          result_summary: `${result.roots.length} roots`,
          is_write: false,
          is_error: false,
          affected_ids: [],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...result, stats: db.getStats(), server_version: version, instructions_stale: isInstructionsStale() }, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "list_roots",
          params: {},
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "list_conflicts",
    "List all unresolved merge conflicts in the knowledge graph, grouped by merge_group. Each group contains competing versions with full data. Call this when the user runs /merge to begin AI-assisted conflict resolution.",
    {},
    async () => {
      try {
        const result = listConflicts(db);
        timeline.log({
          tool: "list_conflicts",
          params: {},
          result_summary: `${result.conflicts.length} conflict groups`,
          is_write: false,
          is_error: false,
          affected_ids: [],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "list_conflicts",
          params: {},
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "resolve_conflict",
    "Resolve a merge conflict by providing the correct resolved content. Read both conflict versions, verify against the current codebase, then provide the accurate resolved summary. Do NOT just pick a side — write the truth.",
    {
      merge_group: z.string().describe("The merge_group UUID of the conflict to resolve"),
      resolved: z.object({
        summary: z.string().describe("The correct, resolved summary for this concept — verified against the current codebase"),
        why: z.string().optional().describe("Updated rationale"),
        file_refs: z.array(z.string()).optional().describe("Updated file references"),
      }).describe("The resolved content to write — must reflect current codebase truth"),
      reason: z.string().describe("Explanation of what you verified and why this resolution is correct"),
    },
    async (params) => {
      try {
        const result = await resolveConflict(db, {
          merge_group: params.merge_group,
          resolved: params.resolved,
          reason: params.reason,
        });
        timeline.log({
          tool: "resolve_conflict",
          params: { merge_group: params.merge_group },
          result_summary: `resolved ${params.merge_group}`,
          is_write: true,
          is_error: false,
          affected_ids: [],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "resolve_conflict",
          params: { merge_group: params.merge_group },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "provenance_trace",
    "Trace authored evidential provenance for a concept along `informed_by` edges. direction='upstream' returns the evidence/reasoning lineage a decision was informed_by; direction='downstream' returns what a finding influenced. Returns a bounded provenance subgraph (nodes with status, edges, supersedes/contradicts cross-edges, and hygiene flags). This is authored evidential provenance for reasoning — not causal inference.",
    {
      target: z.string().describe("The concept ID to trace from"),
      direction: z.enum(["upstream", "downstream"]).describe("upstream = what this was informed_by (ancestry); downstream = what this informed (impact)"),
      depth: z.number().int().min(1).max(8).optional().describe("Max traversal depth (default 4)"),
      max_nodes: z.number().int().min(1).max(500).optional().describe("Max nodes returned (default 100)"),
      max_edges: z.number().int().min(0).max(1000).optional().describe("Max edges returned (default 200)"),
      detail: z.enum(["ids_only", "summary", "full"]).optional().describe("Per-node detail level (default summary)"),
      max_text_chars: z.number().int().min(0).max(5000).optional().describe("Cap on per-field text length"),
      max_bytes: z.number().int().min(200).max(1_000_000).optional().describe("Byte cap on the response at detail=full"),
      include_removed: z.boolean().optional().describe("Include tombstoned edges/nodes (default false)"),
    },
    async (params) => {
      try {
        const result = provenanceTrace(db, params);
        timeline.log({
          tool: "provenance_trace",
          params: { target: params.target, direction: params.direction },
          result_summary: `${result.node_count} nodes, ${result.edge_count} edges`,
          is_write: false,
          is_error: false,
          affected_ids: result.nodes.map((node) => node.id),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "provenance_trace",
          params: { target: params.target, direction: params.direction },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "provenance_audit",
    "Audit the evidential-provenance graph (read-only scaffold for reasoning, not causal inference). view='retrospective' surfaces refuted/superseded/abandoned decisions with their `informed_by` lineage and replacements (\"where did our thinking go wrong\"); view='frontier' ranks open/unvalidated concepts by how much downstream work depends on them, hub-penalized (\"what to validate or test next\"); view='triage' lists legacy concepts that have no status yet participate in provenance relations.",
    {
      view: z.enum(["retrospective", "frontier", "triage"]).describe("retrospective | frontier | triage"),
      limit: z.number().int().min(1).max(100).optional().describe("Max items returned (default 25)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async (params) => {
      try {
        const result = provenanceAudit(db, params);
        timeline.log({
          tool: "provenance_audit",
          params: { view: params.view },
          result_summary: `${result.items.length} items`,
          is_write: false,
          is_error: false,
          affected_ids: result.items.map((item) => item.node.id),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "provenance_audit",
          params: { view: params.view },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );
}
