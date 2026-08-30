import fs from "fs";
import os from "os";
import path from "path";
import Database from "libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeDB, SCHEMA_VERSION } from "../db.js";
import { checkDanglingEdges, checkIntegrity, checkSchemaVersion, checkWal } from "../doctor.js";

let tmpDir: string;
let dbPath: string;

function seedDb(): void {
  const db = new KnowledgeDB(dbPath);
  db.insertNode({
    id: "a", name: "A", kind: "feature", summary: "s",
    why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null,
  });
  db.insertNode({
    id: "b", name: "B", kind: "decision", summary: "s",
    why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null,
  });
  db.insertEdge({ from_id: "b", to_id: "a", relation: "informed_by", description: "why" });
  db.close();
}

function openReadonly(): InstanceType<typeof Database> {
  return new Database(dbPath, { readonly: true });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-doctor-test-"));
  dbPath = path.join(tmpDir, "knowledge.db");
  seedDb();
});

afterEach(() => {
  fs.rmSync(tmpDir, { force: true, recursive: true });
});

describe("doctor checks", () => {
  it("reports ok for a healthy database", () => {
    const db = openReadonly();
    expect(checkSchemaVersion(db).status).toBe("ok");
    expect(checkIntegrity(db).status).toBe("ok");
    expect(checkDanglingEdges(db).status).toBe("ok");
    db.close();
  });

  it("flags a schema version newer than this build as a failure", () => {
    const writable = new Database(dbPath);
    writable.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    writable.close();

    const db = openReadonly();
    const check = checkSchemaVersion(db);
    db.close();

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("NEWER");
  });

  it("warns on an older schema without migrating it", () => {
    const writable = new Database(dbPath);
    writable.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    writable.close();

    const db = openReadonly();
    const check = checkSchemaVersion(db);
    db.close();

    expect(check.status).toBe("warn");
    // The point of inspecting read-only: reporting an old version must not
    // upgrade it, unlike opening through KnowledgeDB which migrates on open.
    // libsql's `simple: true` yields { user_version, _metadata }, not a scalar.
    const after = new Database(dbPath, { readonly: true });
    const raw = after.pragma("user_version", { simple: true }) as unknown;
    after.close();
    const version = typeof raw === "number" ? raw : (raw as { user_version: number }).user_version;
    expect(version).toBe(SCHEMA_VERSION - 1);
  });

  it("detects dangling edges whose endpoint no longer exists", () => {
    // Bypass the app layer to manufacture the inconsistency doctor must catch.
    const writable = new Database(dbPath);
    writable.pragma("foreign_keys = OFF");
    writable.prepare("DELETE FROM nodes WHERE id = 'a'").run();
    writable.close();

    const db = openReadonly();
    const check = checkDanglingEdges(db);
    db.close();

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("dangling");
  });

  it("does not open the database to check WAL state, and flags an oversized WAL", () => {
    // No -wal beside a checkpointed database.
    fs.rmSync(`${dbPath}-wal`, { force: true });
    expect(checkWal(dbPath).status).toBe("ok");

    // A WAL larger than the database signals an unclean exit.
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(fs.statSync(dbPath).size + 1024));
    const check = checkWal(dbPath);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("larger than the database");
  });

  it("leaves the database file untouched while inspecting it", () => {
    const before = fs.statSync(dbPath).mtimeMs;

    const db = openReadonly();
    checkSchemaVersion(db);
    checkIntegrity(db);
    checkDanglingEdges(db);
    db.close();

    expect(fs.statSync(dbPath).mtimeMs).toBe(before);
  });
});
