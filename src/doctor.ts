import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import Database from "libsql";
import pc from "picocolors";
import { errorBold } from "./cli-utils.js";
import { SCHEMA_VERSION } from "./db.js";

/**
 * Read-only health diagnostics for a knowledge database.
 *
 * Deliberately does NOT go through KnowledgeDB: that constructor writes
 * (`journal_mode = WAL`) and runs migrations, which must never happen to a
 * database you are inspecting *because* you suspect it. Every query here opens
 * the file `{ readonly: true }`. Doctor diagnoses and reports; it never repairs.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

type ReadonlyDb = InstanceType<typeof Database>;

const PROBE_FLAG = "--probe-rows";
const PROBE_TIMEOUT_MS = 30_000;

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function getDefaultDbPath(): string {
  return process.env.MEGAMEMORY_DB_PATH ?? path.join(process.cwd(), ".megamemory", "knowledge.db");
}

export function checkSchemaVersion(db: ReadonlyDb): Check {
  const raw = db.pragma("user_version", { simple: true }) as unknown;
  const version = typeof raw === "number" ? raw : Number((raw as { user_version?: number })?.user_version ?? NaN);
  if (Number.isNaN(version)) {
    return { name: "schema version", status: "unknown", detail: "could not read user_version" };
  }
  if (version === SCHEMA_VERSION) {
    return { name: "schema version", status: "ok", detail: `v${version}` };
  }
  if (version < SCHEMA_VERSION) {
    return {
      name: "schema version",
      status: "warn",
      detail: `v${version}, older than this build's v${SCHEMA_VERSION} — it will migrate on next server start`,
    };
  }
  return {
    name: "schema version",
    status: "fail",
    detail: `v${version} is NEWER than this build's v${SCHEMA_VERSION} — this megamemory is too old for the database`,
  };
}

export function checkIntegrity(db: ReadonlyDb): Check {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare("PRAGMA integrity_check(20)").all() as Array<Record<string, unknown>>;
  } catch (err) {
    return {
      name: "integrity",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const messages = rows.map((r) => String(Object.values(r)[0] ?? "")).filter(Boolean);
  if (messages.length === 1 && messages[0] === "ok") {
    return { name: "integrity", status: "ok", detail: "ok" };
  }
  return {
    name: "integrity",
    status: "fail",
    detail: messages.slice(0, 5).join("; ") + (messages.length > 5 ? ` (+${messages.length - 5} more)` : ""),
  };
}

export function checkDanglingEdges(db: ReadonlyDb): Check {
  try {
    const row = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM edges e WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.from_id)) AS bad_from,
           (SELECT COUNT(*) FROM edges e WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.to_id)) AS bad_to`
      )
      .get() as { bad_from: number; bad_to: number };
    const total = row.bad_from + row.bad_to;
    if (total === 0) return { name: "edge endpoints", status: "ok", detail: "no dangling edges" };
    return {
      name: "edge endpoints",
      status: "fail",
      detail: `${total} dangling (${row.bad_from} missing from_id, ${row.bad_to} missing to_id)`,
    };
  } catch (err) {
    return { name: "edge endpoints", status: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
}

export function checkWal(dbPath: string): Check {
  const wal = `${dbPath}-wal`;
  if (!fs.existsSync(wal)) {
    return { name: "write-ahead log", status: "ok", detail: "no -wal file (checkpointed)" };
  }
  const walBytes = fs.statSync(wal).size;
  if (walBytes === 0) {
    return { name: "write-ahead log", status: "ok", detail: "-wal present but empty (checkpointed)" };
  }
  const dbBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  // A WAL larger than the database means a great deal is uncheckpointed. That
  // is expected while a server holds the database open, and is also what a
  // process that died mid-write leaves behind — this check cannot tell the two
  // apart, so it reports the observation and names both causes.
  if (dbBytes > 0 && walBytes > dbBytes) {
    return {
      name: "write-ahead log",
      status: "warn",
      detail: `-wal is ${walBytes} B, larger than the database (${dbBytes} B) — heavily uncheckpointed; normal if a server currently holds it open, otherwise it suggests a process died mid-write`,
    };
  }
  return { name: "write-ahead log", status: "ok", detail: `-wal present, ${walBytes} B uncheckpointed` };
}

/**
 * Reads every row of every table in a CHILD process.
 *
 * This cannot be done in-process: corrupt row data makes the libsql driver
 * *panic* (Utf8Error), which is not a catchable JS exception — it kills the
 * process outright. Running it as a child turns that fatal crash into an exit
 * code the parent can report. This check exists because `COUNT(*)` and
 * index-only scans succeed over corrupt table pages and give false confidence.
 */
export function probeRowReadability(dbPath: string): Check {
  const entry = process.argv[1];
  if (!entry) {
    return { name: "row readability", status: "unknown", detail: "probe unavailable (no entry point)" };
  }
  const probe = spawnSync(process.execPath, [entry, "doctor", PROBE_FLAG, dbPath], {
    encoding: "utf-8",
    timeout: PROBE_TIMEOUT_MS,
  });

  if (probe.error) {
    // Distinguish "the probe could not run" from "the data is bad" — reporting
    // corruption because a subprocess failed to launch would be fabrication.
    return { name: "row readability", status: "unknown", detail: `probe could not run: ${probe.error.message}` };
  }
  if (probe.status === 0) {
    const counts = (probe.stdout || "").trim();
    return { name: "row readability", status: "ok", detail: counts ? `all rows read (${counts})` : "all rows read" };
  }
  const reason = (probe.stderr || "").trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
  const how = probe.signal ? `killed by ${probe.signal}` : `exit ${probe.status}`;
  return {
    name: "row readability",
    status: "fail",
    detail: `unreadable row data (${how})${reason ? `: ${reason.slice(0, 160)}` : ""}`,
  };
}

function probeRowsAndExit(dbPath: string): void {
  let db: ReadonlyDb;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    process.stderr.write(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  try {
    const nodes = db.prepare("SELECT * FROM nodes").all() as unknown[];
    const edges = db.prepare("SELECT * FROM edges").all() as unknown[];
    process.stdout.write(`${nodes.length} nodes, ${edges.length} edges`);
    db.close();
    process.exit(0);
  } catch (err) {
    process.stderr.write(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const SYMBOL: Record<CheckStatus, string> = {
  ok: pc.green("✓"),
  warn: pc.yellow("!"),
  fail: pc.red("✗"),
  unknown: pc.dim("?"),
};

export async function runDoctor(args: string[]): Promise<void> {
  // Hidden child-process mode used by probeRowReadability.
  const probeTarget = getFlag(args, PROBE_FLAG);
  if (probeTarget) {
    probeRowsAndExit(path.resolve(probeTarget));
    return;
  }

  const dbPath = path.resolve(getFlag(args, "--db") ?? getDefaultDbPath());
  if (!fs.existsSync(dbPath)) {
    errorBold(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  console.log(pc.bold(pc.cyan("megamemory doctor")));
  console.log();
  console.log(`  ${pc.cyan("Database:")} ${dbPath}`);
  console.log(`  ${pc.dim("read-only — no migration, no repair")}`);
  console.log();

  const checks: Check[] = [];
  let db: ReadonlyDb | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    // Not reported as a failure: a read-only open of a WAL database can fail
    // for reasons unrelated to the data — SQLite may need to create the -shm
    // shared-memory file, which it cannot do when the file or directory is not
    // writable, or when a stale -shm is left without its -wal. Calling that
    // "corrupt" would fabricate a verdict.
    checks.push({
      name: "open database",
      status: "unknown",
      detail: `${err instanceof Error ? err.message : String(err)} — could not open read-only; for a WAL database this can mean the -shm file cannot be created (directory not writable, or a stale -shm without its -wal) rather than damaged data`,
    });
  }

  if (db) {
    checks.push(checkSchemaVersion(db));
    checks.push(checkIntegrity(db));
    checks.push(checkDanglingEdges(db));
    db.close();
  }
  checks.push(checkWal(dbPath));
  checks.push(probeRowReadability(dbPath));

  for (const check of checks) {
    console.log(`  ${SYMBOL[check.status]} ${pc.cyan(`${check.name}:`.padEnd(20))}${check.detail}`);
  }
  console.log();

  const failed = checks.filter((c) => c.status === "fail");
  if (failed.length > 0) {
    console.log(
      `  ${pc.red(pc.bold(`${failed.length} check(s) failed.`))} ${pc.dim(
        "A corrupt database crashes the MCP server on read, which presents as megamemory's tools disappearing from that project."
      )}`
    );
    console.log(
      pc.dim(
        "  Recovery: quarantine the database together with its -wal/-shm. When restoring a backup, delete the corrupt -wal first — SQLite re-applies a stale WAL to whatever file is named knowledge.db and will re-corrupt a clean backup."
      )
    );
    process.exit(1);
  }
  const warned = checks.filter((c) => c.status === "warn").length;
  const unknown = checks.filter((c) => c.status === "unknown").length;
  const notes = [
    warned > 0 ? `${warned} warning${warned === 1 ? "" : "s"}` : "",
    unknown > 0 ? `${unknown} inconclusive` : "",
  ].filter(Boolean);
  console.log(
    `  ${pc.green(pc.bold("No failures."))}${notes.length > 0 ? pc.dim(` (${notes.join(", ")})`) : ""}`
  );
}
