# Evidential Provenance — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add authored evidential provenance (`informed_by`/`supersedes`/`contradicts` relations + decision `status`) to MegaMemory, with tombstone-safe deletion, DAG-enforced lineage, and two read-only reflective tools (`provenance_trace`, `provenance_audit`).

**Architecture:** Extend the existing libsql/SQLite schema to v5 (add `nodes.status` + `edges.removed_at`), thread `status` through write/read paths, replace edge hard-deletion with tombstoning, enforce `informed_by` as a strict DAG at write/merge time, and add two additive MCP tools that traverse the `informed_by` projection as a scaffold for LLM reasoning (no causal computation). Full rationale: `docs/plans/2026-06-19-evidential-provenance-design.md` (read it first).

**Tech Stack:** TypeScript/Node, `libsql` (better-sqlite3-compatible), Zod (MCP schemas in `index.ts`), Vitest. In-process `all-MiniLM-L6-v2` embeddings (unaffected).

---

## Conventions (read once)

- **TDD always:** write failing test → run it red → minimal impl → run green → commit. One behavior per test.
- **Test command:** `npm test -- <file>` for one file, `npm test` for all. Tests live in `src/__tests__/*.test.ts`; follow `db.test.ts` for temp-DB setup.
- **Commit identity:** this repo has no git identity configured — prefix every commit with `git -c user.name="0xk3vin" -c user.email="0xk3vin@users.noreply.github.com" commit ...` (matches existing repo authorship; do **not** set global config).
- **Commit style:** Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`), matching repo history.
- **Design doc is source of truth.** Section refs below (e.g. §4.4) point into the design doc.
- **Reference skills:** @superpowers:test-driven-development, @superpowers:verification-before-completion.
- **Order matters:** phases are dependency-ordered. Do not start a phase until the prior one is green.

---

## Phase 0 — Schema v5 migration (foundation)

### Task 0.1: Migration adds `status` + `removed_at`, bumps version

**Files:**
- Modify: `src/db.ts` (the `SCHEMA_VERSION` const + `migrate()` after the `currentVersion < 4` block, ~`db.ts:157`)
- Test: `src/__tests__/db.test.ts`

**Step 1 — failing test:**
```ts
it("v5 migration adds nodes.status and edges.removed_at and sets user_version=5", () => {
  const db = new KnowledgeDB(":memory:");
  const raw = (db as any).db; // libsql handle (see existing tests)
  const nodeCols = raw.prepare("PRAGMA table_info(nodes)").all().map((c:any)=>c.name);
  const edgeCols = raw.prepare("PRAGMA table_info(edges)").all().map((c:any)=>c.name);
  expect(nodeCols).toContain("status");
  expect(edgeCols).toContain("removed_at");
  expect(raw.pragma ? raw.pragma("user_version", {simple:true}) : raw.prepare("PRAGMA user_version").get().user_version).toBe(5);
});
```
**Step 2 — run red:** `npm test -- db.test.ts` → FAIL (no `status` column).

**Step 3 — implement** in `migrate()`:
```ts
if (currentVersion < 5) {
  const ncols = new Set(this.db.prepare("PRAGMA table_info(nodes)").all().map((c:any)=>c.name));
  if (!ncols.has("status")) this.db.exec("ALTER TABLE nodes ADD COLUMN status TEXT");
  const ecols = new Set(this.db.prepare("PRAGMA table_info(edges)").all().map((c:any)=>c.name));
  if (!ecols.has("removed_at")) this.db.exec(
    "ALTER TABLE edges ADD COLUMN removed_at TEXT;" +
    "CREATE INDEX IF NOT EXISTS idx_edges_removed ON edges(removed_at);");
}
```
Bump `const SCHEMA_VERSION = 5;` (and the final `PRAGMA user_version = ...` setter).

**Step 4 — run green.** **Step 5 — commit:** `feat(db): schema v5 — add nodes.status + edges.removed_at`

### Task 0.2: Idempotency + upgrade-from-v4 test
- Test: open a v4-shaped DB (manually `PRAGMA user_version=4`, drop the new cols via a fresh table) → reopen → migration runs once, existing rows get `status=NULL`/`removed_at=NULL`, no data loss; running `migrate()` twice is a no-op. Commit `test(db): v5 idempotent upgrade preserves data`.

---

## Phase 1 — Types + relation enum

### Task 1.1: Extend `RelationType` and `NodeStatus`
**Files:** Modify `src/types.ts` (RelationType `:43-48`, add `NodeStatus`, add `status` to `Node`/`NodeRow`/`CreateConceptInput`/`UpdateConceptInput.changes`/`NodeWithContext`; add `removed_at` to `Edge`/`EdgeRow`).
- `export type RelationType = "connects_to"|"depends_on"|"implements"|"calls"|"configured_by"|"informed_by"|"supersedes"|"contradicts";`
- `export type NodeStatus = "open"|"validated"|"refuted"|"superseded"|"abandoned";`
- Test (`types`/compile-level via a `db.test.ts` round-trip): create node with `status:"open"`, read it back. (Real assertion lands in Phase 2.) Commit `feat(types): add provenance relations + NodeStatus`.

### Task 1.2: MCP relation enum
**Files:** Modify `src/index.ts` `RelationEnum` (`:199-201`) to include the 3 new relations. Test: a `link` call with `relation:"informed_by"` is accepted (add to `index`/tools test). Commit `feat(mcp): accept informed_by/supersedes/contradicts relations`.

---

## Phase 2 — Status write + read (the non-functional BLOCKERS, §4.2)

### Task 2.1: `updateNode` honors `status`
**Files:** Modify `src/db.ts` `updateNode` (`:311-359`) — add `status` to the recognized `fields`. Test (`db.test.ts`): a status-only update returns `true` and persists (currently returns `false`/no-op).
```ts
it("updateNode persists a status-only change", () => {
  const db = new KnowledgeDB(":memory:");
  db.insertNode({ id:"d1", name:"D", kind:"decision", summary:"s" } as any);
  expect(db.updateNode("d1", { status:"validated" } as any)).toBe(true);
  expect(db.getNode("d1")!.status).toBe("validated");
});
```
Commit `fix(db): updateNode persists status (was silent no-op)`.

### Task 2.2: `status` surfaces on reads
**Files:** Modify `src/tools.ts` `buildNodeWithContext` (`:92-105`) to include `status`; ensure `getNode`/`getNodeRow` select it. Test: `understand`/`get_concept` output includes `status`. Commit `fix(tools): expose status in node context`.

### Task 2.3: create/update tool schemas accept `status`
**Files:** Modify `src/index.ts` `create_concept` + `update_concept` Zod schemas (`status: z.enum([...]).optional()`); default `open` for epistemic creates in `tools.ts`. Test: create with `status`, update status, read back. Commit `feat(mcp): status param on create/update`.

---

## Phase 3 — Edge tombstones (§2.3, B1/B2/B3)

### Task 3.1: `softDeleteNode` tombstones edges (no physical DELETE)
**Files:** Modify `src/db.ts` `softDeleteNode` (`:361-378`) — replace `DELETE FROM edges WHERE from_id=? OR to_id=?` with `UPDATE edges SET removed_at=datetime('now') WHERE (from_id=? OR to_id=?) AND removed_at IS NULL`.
**Test:** remove a node → its edges have `removed_at` set, rows still exist.
```ts
it("softDeleteNode tombstones edges instead of deleting them", () => {
  const db = new KnowledgeDB(":memory:");
  db.insertNode({id:"a",name:"a",kind:"feature",summary:"s"} as any);
  db.insertNode({id:"b",name:"b",kind:"decision",summary:"s"} as any);
  db.insertEdge({from_id:"b",to_id:"a",relation:"informed_by"} as any);
  db.softDeleteNode("a","cleanup");
  const raw=(db as any).db;
  const e=raw.prepare("SELECT removed_at FROM edges WHERE from_id='b' AND to_id='a'").get();
  expect(e).toBeTruthy(); expect(e.removed_at).not.toBeNull();
});
```
Commit `fix(db): tombstone edges on node removal (preserve lineage)`.

### Task 3.2: Tombstone-aware reads (B2)
**Files:** Modify `getOutgoingEdges` (`:423-436`), `getIncomingEdges` (`:438-453`), `getAllEdges`, `getStats` edge count, `getEdgesAtTime` → add `AND removed_at IS NULL`. **Leave `getAllEdgesRaw` unfiltered** (merge needs full set). Each gets a test asserting tombstoned edges are excluded (and `getStats` count not inflated). Commit `fix(db): exclude tombstoned edges from normal reads`.

### Task 3.3: `insertEdgeRaw` round-trips `removed_at` (B1 — merge resurrection)
**Files:** Modify `src/db.ts` `insertEdgeRaw` (`:709-738`) to include `removed_at` column; `src/types.ts` add `removed_at` to the raw edge type. **Test:** insert a raw edge with `removed_at` set → it stays tombstoned (does not resurrect).
Commit `fix(db): insertEdgeRaw preserves removed_at`.

### Task 3.4: Retrospective node/edge predicate symmetry (B3)
**Files:** Add new traversal read(s) in `db.ts` — `getProvenanceEdges(ids, {direction, includeRemoved})` filtered to `relation='informed_by'`, with `includeRemoved` parameterizing both the edge filter AND endpoint-node inclusion (tombstoned endpoint returned as a stub or edge suppressed — never dangling). Test both `includeRemoved=false` (normal) and `true` (retrospective) produce referentially-closed adjacency. Commit `feat(db): informed_by traversal reads with parameterized tombstone inclusion`.

---

## Phase 4 — `informed_by` DAG enforcement (§2.1)

### Task 4.1: cycle-check helper
**Files:** Add `db.ts` `informedByReaches(from, to): boolean` (reverse-reachability over active `informed_by`) + `wouldCreateCycle(from, to)`. Test: chain a→b→c; assert `wouldCreateCycle("c","a")` is true, `("a","c")` false. Commit `feat(db): informed_by reachability + cycle check`.

### Task 4.2: reject cycles on create/link
**Files:** Modify `tools.ts` create_concept-edges + link handlers — when `relation==="informed_by"`, reject `u==v` or `wouldCreateCycle`. Test: linking a cycle returns an error; non-cycle ok. Commit `feat: reject informed_by cycles at write time`.

### Task 4.3: merge-time atomic union DAG check
**Files:** Modify `src/merge.ts` — after `deferEdgesClean` (`:493-549`), run a post-pass cycle check on the **union** `informed_by` graph; on cycle, set `needs_merge` (do NOT abort). Also add `status` to `nodesAreIdentical` (`:43-61`) and thread `removed_at` through `DeferredEdge` + all push-sites + final `insertEdgeRaw`. Tests: (a) two acyclic inputs that union into a cycle → flagged `needs_merge`; (b) status divergence → conflict; (c) tombstoned edge survives merge. Commit `fix(merge): union DAG check, status compare, tombstone round-trip`.

---

## Phase 5 — `remove_concept` refuse-and-redirect (§4.4)

### Task 5.1: epistemic-participation guard (read-time)
**Files:** Add `db.ts` `isEpistemicallyProtected(id): {protected, reasons[]}` — true if `status IS NOT NULL` OR `kind='decision'` OR has active incoming `informed_by` OR (status IS NULL AND has active outgoing `informed_by`) OR is an active `contradicts`/`supersedes` endpoint (either direction). All lookups `removed_at IS NULL`. Test each branch. Commit `feat(db): epistemic-participation guard`.

### Task 5.2: remove handler refuses + redirects; `treat_as_descriptive` escape
**Files:** Modify `tools.ts` remove handler + `index.ts` `remove_concept` schema (add `treat_as_descriptive: z.boolean().optional()`; rewrite description — drop the false "preserved in history" edge claim). Behavior: if protected and not `treat_as_descriptive` → refuse with a message naming the reasons + suggesting a `status` transition; `force` does NOT override epistemic. Tests: refuse a decision; refuse a descriptive node with incoming `informed_by`; allow with `treat_as_descriptive`. Commit `feat(mcp): remove_concept refuse-and-redirect for epistemic nodes`.

---

## Phase 6 — `provenance_trace` tool (§5.1, §5.3)

### Task 6.1: traversal core (caps + flat adjacency)
**Files:** Add `tools.ts` `provenanceTrace(target, direction, {depth,max_nodes,max_edges,detail})` using `getProvenanceEdges`; BFS with `visited_nodes` + post-dedup `emitted_edges`, enforce caps **during** traversal, flat `{nodes[],edges[]}`, truncation metadata `{truncated,truncation_reason,node_count,edge_count,max_depth_reached,next_cursor}`, deterministic order `(depth, edge.id)`. `supersedes`/`contradicts` only as annotated cross-edges among emitted nodes. Tests: upstream/downstream correctness on a small graph; depth cap; max_nodes cap sets `truncated`; `parent_id` never traversed. Commit `feat(tools): provenance_trace traversal`.

### Task 6.2: MCP tool registration + Zod caps
**Files:** `index.ts` register `provenance_trace` (rename off generic "trace"); caps in schema (`depth:int.min(1).max(8).default(4)`, `max_nodes≤500 default 100`, `max_edges≤1000 default 200`, `detail` enum default `summary`, `max_text_chars`/`max_bytes` for `full`); description states it is provenance, not causal. Test schema rejects depth>8. Commit `feat(mcp): register provenance_trace`.

---

## Phase 7 — `provenance_audit` tool (§5.2)

### Task 7.1: retrospective view
**Files:** `tools.ts` `provenanceAudit({view:"retrospective", limit, cursor})` → `refuted`/`superseded`/`abandoned` nodes + ancestry (`includeRemoved=true` for tombstoned lineage) + replacements via `supersedes`. Test on a small refuted-with-ancestry graph. Commit `feat(tools): provenance_audit retrospective`.

### Task 7.2: frontier view (formula)
**Files:** add frontier ranking — candidates = `open` + legacy `NULL`; `score(n)=Σ_{d∈downstream via incoming informed_by} weight(d)·decay^dist / hubPenalty(n)`, `decay=0.5`, `hubPenalty=log(1+in_degree)`, tie-break `(score,id)`; expose components. Test: a hub-y node does NOT dominate; a node many *validated* nodes depend on ranks high. Commit `feat(tools): provenance_audit frontier ranking`.

### Task 7.3: register `provenance_audit` (MCP, Zod, cursor). Commit `feat(mcp): register provenance_audit`.

---

## Phase 8 — Hygiene flags (§5.4)

### Task 8.1: flag computation
**Files:** `tools.ts` `computeHygieneFlags(scope)` returning `[{type,node,offending_ancestor,ancestor_status}]` for: `validated_rests_on_unvalidated`, `validated_contradiction`/`trusted_contradicted_by_validated`, `supersedes_target_not_superseded`, `broken_chain`, `broken_contradiction`/`broken_supersedes`, `cycle_detected`. Reachability over `informed_by` filtered by status. Tests per flag type. Surface flags in `provenance_trace`/`provenance_audit` output. Commit `feat(tools): provenance hygiene flags`.

---

## Phase 9 — Upgrade-path: tool descriptions, install, commands, staleness (§3.3)

### Task 9.1: anchor capture guidance in tool descriptions
**Files:** `index.ts` — enrich `create_concept`/`update_concept`/`link`/`remove_concept` descriptions with the provenance discipline (when to use `informed_by`, set `status`, refuse-and-redirect). Commit `docs(mcp): anchor provenance guidance in tool descriptions`.

### Task 9.2: MCP-visible staleness signal
**Files:** `index.ts` — add `{instructions_stale, server_version}` to `list_roots`/`understand` output when installed-instruction version < server version (replace the invisible `console.error` at `:541`). Test the decoration. Commit `feat(mcp): surface stale-instructions signal on read tools`.

### Task 9.3: install refresh (versioned marker block)
**Files:** `install.ts` — fix `setupInstructionFile` (`:214-219`) marker-gating to do a **versioned marker-block replacement** (preserve user content); update `AGENTS_MD_SNIPPET` + `commands/*.md` (relation list, `status`, abandoned-vs-remove rule). Test snippet refresh on re-install. Commit `fix(install): versioned marker-block refresh + provenance prompts`.

---

## Phase 10 — Legacy `NULL` triage (§4.4 resolution)

### Task 10.1: triage/unknown audit view
**Files:** `tools.ts` `provenanceAudit({view:"triage"})` → legacy `NULL` nodes participating in `informed_by`/`contradicts`/`supersedes` (candidates for manual status). **No auto-assignment of `open`.** Test it lists exactly the participating NULL nodes. Commit `feat(tools): legacy NULL triage audit view`.

---

## Final verification (before PR)

- `npm test` → all green (existing 141 + new). @superpowers:verification-before-completion
- `npm run build` (tsc) clean.
- Manual smoke: create a decision with `informed_by`, set `status`, `provenance_trace` upstream, `provenance_audit` frontier/retrospective, attempt to remove an epistemic node (refused), attempt a cycle (rejected).
- Update `CHANGELOG.md`; bump `package.json` minor version.
- Open PR from `feature/informed-by-provenance`; PR body references this plan + the design doc.

---

## Out of scope (design §7)

Statistical causal discovery; validation provenance metadata (who/method/when); validated→refuted descendant re-flag propagation; web-explorer provenance rendering. Defer.
