import fs from "fs";
import path from "path";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { errorBold } from "./cli-utils.js";
import { listRoots } from "./tools.js";

const KIND_ORDER = ["feature", "module", "component", "pattern", "config", "decision"];

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function getDefaultDbPath(): string {
  return process.env.MEGAMEMORY_DB_PATH ?? path.join(process.cwd(), ".megamemory", "knowledge.db");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = -1;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }

  const formatted = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formatted} ${units[idx]}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function printRow(label: string, value: string, detail?: string): void {
  const prefix = `    ${pc.cyan(`${label}:`.padEnd(16))}${pc.green(value)}`;
  if (detail) {
    console.log(`${prefix} ${pc.dim(detail)}`);
    return;
  }
  console.log(prefix);
}

const STATUS_ORDER = ["open", "validated", "refuted", "superseded", "abandoned", "(none)"];

export interface GraphCensus {
  /** Active nodes by status; unstatused nodes are counted under "(none)". */
  statuses: Record<string, number>;
  /** Active (non-tombstoned) edges by relation. */
  relations: Record<string, number>;
  tombstonedEdges: number;
  /**
   * Unstatused nodes split by whether anything cites them as evidence. Only the
   * cited ones can reach the frontier — an uncited node scores zero and is
   * filtered out — so this is the number that says how much of the graph the
   * frontier can actually see.
   */
  provenance: { unstatused: number; unstatusedCited: number; unstatusedUncited: number };
}

export function computeCensus(db: KnowledgeDB): GraphCensus {
  const nodes = db.getAllActiveNodes();
  const statuses: Record<string, number> = {};
  for (const node of nodes) {
    const key = node.status ?? "(none)";
    statuses[key] = (statuses[key] ?? 0) + 1;
  }

  const rawEdges = db.getAllEdgesRaw();
  const activeEdges = rawEdges.filter((edge) => edge.removed_at === null);
  const relations: Record<string, number> = {};
  for (const edge of activeEdges) {
    relations[edge.relation] = (relations[edge.relation] ?? 0) + 1;
  }

  const cited = new Set(
    activeEdges.filter((edge) => edge.relation === "informed_by").map((edge) => edge.to_id)
  );
  const unstatusedNodes = nodes.filter((node) => node.status === null);
  const unstatusedCited = unstatusedNodes.filter((node) => cited.has(node.id)).length;

  return {
    statuses,
    relations,
    tombstonedEdges: rawEdges.length - activeEdges.length,
    provenance: {
      unstatused: unstatusedNodes.length,
      unstatusedCited,
      unstatusedUncited: unstatusedNodes.length - unstatusedCited,
    },
  };
}

function sortedByPreference(counts: Record<string, number>, order: string[]): Array<[string, number]> {
  const preferred = order
    .filter((key) => counts[key] !== undefined)
    .map((key) => [key, counts[key]] as [string, number]);
  const extra = Object.entries(counts)
    .filter(([key]) => !order.includes(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return [...preferred, ...extra];
}

function sortedKinds(kinds: Record<string, number>): Array<[string, number]> {
  const preferred = KIND_ORDER.filter((kind) => kinds[kind] !== undefined).map((kind) => [kind, kinds[kind]] as [string, number]);
  const extra = Object.entries(kinds)
    .filter(([kind]) => !KIND_ORDER.includes(kind))
    .sort(([a], [b]) => a.localeCompare(b));
  return [...preferred, ...extra];
}

export async function runStats(args: string[]): Promise<void> {
  const dbPath = path.resolve(getFlag(args, "--db") ?? getDefaultDbPath());

  if (!fs.existsSync(dbPath)) {
    errorBold(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  let dbStat: fs.Stats;
  try {
    dbStat = fs.statSync(dbPath);
  } catch (err) {
    errorBold(`Failed to stat database file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const db = new KnowledgeDB(dbPath);
  try {
    const stats = db.getStats();
    const rootCount = db.getRootNodes().length;
    const timelineCount = db.getTimelineBounds().count;
    const kinds = db.getKindsBreakdown();
    const nodes = db.getAllActiveNodes();

    const childCount = nodes.filter((node) => node.parent_id !== null).length;

    // Per-node size analysis
    let totalChars = 0;
    let totalBytes = 0;
    let totalTokens = 0;
    let largest: { name: string; tokens: number } | null = null;
    let smallest: { name: string; tokens: number } | null = null;

    for (const node of nodes) {
      const payload = JSON.stringify({
        name: node.name,
        summary: node.summary,
        why: node.why ?? "",
        file_refs: node.file_refs ?? "",
      });
      const chars = payload.length;
      const bytes = Buffer.byteLength(payload, "utf8");
      const tokens = Math.ceil(chars / 4);

      totalChars += chars;
      totalBytes += bytes;
      totalTokens += tokens;

      if (!largest || tokens > largest.tokens) {
        largest = { name: node.name, tokens };
      }
      if (!smallest || tokens < smallest.tokens) {
        smallest = { name: node.name, tokens };
      }
    }

    const avgTokens = nodes.length > 0 ? Math.ceil(totalTokens / nodes.length) : 0;

    // list_roots payload analysis (matches what MCP server actually sends)
    const listRootsResult = listRoots(db);
    const listRootsPayload = JSON.stringify({ ...listRootsResult, stats: db.getStats() }, null, 2);
    const listRootsChars = listRootsPayload.length;
    const listRootsTokens = Math.ceil(listRootsChars / 4);
    const listRootsNodeCount = listRootsResult.roots.reduce(
      (sum, r) => sum + 1 + r.children.length,
      0
    );

    // Print output
    console.log(pc.bold(pc.cyan("megamemory stats")));
    console.log();

    console.log(`  ${pc.bold("Database")}`);
    printRow("Path", dbPath);
    printRow("File size", formatBytes(dbStat.size), `(${formatNumber(dbStat.size)} bytes)`);
    console.log();

    console.log(`  ${pc.bold("Graph")}`);
    printRow("Nodes", formatNumber(stats.nodes), `(${formatNumber(rootCount)} root, ${formatNumber(childCount)} children)`);
    printRow("Edges", formatNumber(stats.edges));
    printRow("Removed", formatNumber(stats.removed));
    printRow("Timeline", `${formatNumber(timelineCount)} entries`);
    console.log();

    console.log(`  ${pc.bold("list_roots")}`);
    printRow("Nodes", formatNumber(listRootsNodeCount), `(${listRootsResult.roots.length} roots + ${listRootsNodeCount - listRootsResult.roots.length} children)`);
    printRow("Response size", `~${formatNumber(listRootsTokens)} tokens`, `(${formatNumber(listRootsChars)} chars)`);
    console.log();

    console.log(`  ${pc.bold("Kinds")}`);
    for (const [kind, count] of sortedKinds(kinds)) {
      printRow(kind, formatNumber(count));
    }
    if (Object.keys(kinds).length === 0) {
      printRow("-", "0");
    }
    console.log();

    const census = computeCensus(db);

    console.log(`  ${pc.bold("Status")}`);
    for (const [status, count] of sortedByPreference(census.statuses, STATUS_ORDER)) {
      printRow(status, formatNumber(count));
    }
    if (Object.keys(census.statuses).length === 0) {
      printRow("-", "0");
    }
    console.log();

    console.log(`  ${pc.bold("Relations")}`);
    for (const [relation, count] of sortedByPreference(census.relations, [])) {
      printRow(relation, formatNumber(count));
    }
    if (Object.keys(census.relations).length === 0) {
      printRow("-", "0");
    }
    printRow("tombstoned", formatNumber(census.tombstonedEdges));
    console.log();

    console.log(`  ${pc.bold("Provenance")}`);
    printRow("Unstatused", formatNumber(census.provenance.unstatused));
    printRow("  cited", formatNumber(census.provenance.unstatusedCited), "(can reach frontier)");
    printRow("  uncited", formatNumber(census.provenance.unstatusedUncited), "(scores zero, filtered out)");
    console.log();

    console.log(`  ${pc.bold("Size")}`);
    printRow("Total tokens", `~${formatNumber(totalTokens)}`);
    printRow("Total chars", formatNumber(totalChars), `(${formatNumber(totalBytes)} bytes)`);
    printRow("Avg node tokens", `~${formatNumber(avgTokens)}`);
    if (largest) {
      printRow("Largest", `${largest.name} (${formatNumber(largest.tokens)} tokens)`);
    } else {
      printRow("Largest", "N/A");
    }
    if (smallest) {
      printRow("Smallest", `${smallest.name} (${formatNumber(smallest.tokens)} tokens)`);
    } else {
      printRow("Smallest", "N/A");
    }
  } finally {
    db.close();
  }
}
