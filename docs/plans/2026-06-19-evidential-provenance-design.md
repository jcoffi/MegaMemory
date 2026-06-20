# Evidential Provenance for MegaMemory — Design

- **Date:** 2026-06-19
- **Status:** Validated design — three A2A review rounds (causal-inference, MCP tooling, graph theory); round-3 verification verdict **ready-with-changes** + a focused causal↔mcp resolution exchange (verdict **residual-gaps-remain**), all edits incorporated below.
- **Feature branch:** `feature/informed-by-provenance`
- **Schema:** v4 → **v5**

---

## 1. Context & Motivation

### 1.1 What we tried first (and why we abandoned it)

We evaluated implementing arXiv:2505.10476 (*Causal discovery on vector-valued variables and consistency-guided aggregation*) to **discover** causal links between memories from the access-log `timeline`. We tested it empirically on a real graph (`HOPE_Backtest`: 108 nodes, 297 timeline events, 51 multi-concept sessions):

- Naive lagged co-occurrence looked promising (261/355 strong directional pairs).
- After conditioning on workflow position (position-preserving Monte-Carlo null) and hub ablation, **~99% of the signal was artifact**.
- **Zero** edges survived multiple-comparison correction at concept level **or** at k-means campaign (aggregate) level (clusters were internally coherent — cohesion 0.80–0.88 — but **no statistically defensible aggregate signal survived correction**).

**Conclusion:** statistical causal discovery from access logs is not trustworthy at single-project scale (absence of evidence + underpowered). It becomes viable only if timelines pool across many projects — deferred (see §7).

### 1.2 The pivot

Capture epistemic provenance **explicitly at write-time** (LLM-declared), and reason over it as a **scaffold** — the LLM reasons; the system does **not** compute causal effects, do-calculus, or counterfactuals. This delivers the reflective goals ("what should we test next?", "where did our thinking go wrong?") using the epistemic link the access log structurally cannot provide.

### 1.3 Terminology (review-mandated)

This is **authored evidential provenance**, NOT causal inference. `informed_by` means *material support* — evidence, assumption, prior result, or decision basis — not loose inspiration. Documentation and tool descriptions must avoid claiming causal effects, counterfactuals, or statistical causal discovery. (Causal-reviewer: BLOCKING if framed as causal.)

---

## 2. Data Model

### 2.1 Relations (no migration — `edges.relation` is already `TEXT`)

Add three relations to `RelationType` (`types.ts`) + the MCP relation enum (`index.ts`). Convention reads `from → relation → to` (matches `depends_on`).

| Relation | Reads as | Layer | Notes |
|---|---|---|---|
| `informed_by` | *from* (decision/finding) was materially shaped by *to* (evidence) | **strict DAG** | ancestry = out-edges; impact = in-edges; require a rationale (`description`) |
| `supersedes` | *from* replaces *to* | separate (may cycle) | pairs with setting `to.status = superseded` |
| `contradicts` | *from* conflicts with *to* | separate (may cycle) | symmetric meaning, stored directed → check both directions |

The v4 dedup key `(from_id, to_id, relation)` lets `informed_by` and `depends_on` coexist on the same pair.

**Invariant (graph-reviewer, BLOCKING):** `informed_by` must be a strict DAG, enforced at **`create_concept.edges`, `link`, import, and merge**. Reject `u informed_by v` if `u == v` or if `v` already reaches `u` through active `informed_by`.

- **Atomic post-batch validation (round-3):** batch/import/merge must validate the **post-batch union graph atomically** — two individually-acyclic inputs can union into a cycle. On a merge-introduced cycle, **flag `needs_merge`** (do not abort the merge).
- `supersedes`/`contradicts` live in a separate layer that may cycle and **must never expand** ancestry/impact/frontier closure (single-relation projection).
- **`parent_id` exclusion (round-3):** the parent/child hierarchy is excluded from provenance closure, DAG checks, frontier scoring, and hygiene reachability. Provenance is the `informed_by` projection only.

### 2.2 Node status (schema v5, column 1)

`ALTER TABLE nodes ADD COLUMN status TEXT` (nullable, **no DEFAULT**).

| status | meaning |
|---|---|
| `open` | proposed / in progress — **explicitly not a correctness claim**; default for new epistemic nodes |
| `validated` | confirmed correct **for a stated scope** by explicit evidence/rationale — **earned, explicit transition only**; never inferred |
| `refuted` | concluded incorrect — **kept** (highest-value "where did we go wrong" signal) |
| `superseded` | replaced by a later decision (with `supersedes` edge) |
| `abandoned` | dropped without a verdict |
| `NULL` | legacy / **unknown — never treated as validated** |

**Epistemic hygiene:** `open` and `validated` are distinct; validity is never assumed from "still being worked on" or mere existence. Only `validated` is eligible as trusted evidence by default (causal-reviewer softened "ground truth" → "trusted-by-default eligible"). **Every status transition requires a non-empty rationale** (round-3; until phase-2 validation metadata exists). **Scope (resolution):** `validated` is trusted-by-default **only within the stated scope** recorded in that rationale; when scope is absent or unclear, tools treat the node as not scope-validated for downstream trust/hygiene.

### 2.3 Edge tombstones (schema v5, column 2) — closes a BLOCKING bug

`ALTER TABLE edges ADD COLUMN removed_at TEXT` + index.

**Why (mcp-reviewer, source-verified):** `softDeleteNode` (`db.ts:372-374`) currently runs `DELETE FROM edges WHERE from_id = ? OR to_id = ?` — a *physical* delete of every incident edge, in the same call as any "discouraging message." So soft-warn alone is cosmetic, and even removing a legitimate **descriptive** node that a decision is `informed_by` silently severs that decision's lineage. Fix: edges are **tombstoned** (`removed_at` set), not physically deleted; normal reads filter `removed_at IS NULL`; `retrospective` mode may resurrect tombstoned edges.

- New edges leave `removed_at = NULL` by column default (`insertEdge` needs no change), **but `insertEdgeRaw` (the merge write path) MUST carry `removed_at`** or merges silently resurrect tombstones — see §6 / B1.
- **Predicate symmetry (round-3 / B3):** retrospective resurrection must keep node/edge predicates symmetric — a resurrected edge's tombstoned **endpoint node** is included as a stub (counted toward `max_nodes`) **or** the edge is suppressed. Never emit a dangling edge whose endpoint was filtered out.

---

## 3. Upgrade Path (v4 → v5)

### 3.1 Schema migration (follows the existing `migrate()` pattern)

```js
if (currentVersion < 5) {
  const ncols = new Set(db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name));
  if (!ncols.has("status")) db.exec("ALTER TABLE nodes ADD COLUMN status TEXT");
  const ecols = new Set(db.prepare("PRAGMA table_info(edges)").all().map(c => c.name));
  if (!ecols.has("removed_at")) db.exec(
    "ALTER TABLE edges ADD COLUMN removed_at TEXT;" +
    "CREATE INDEX IF NOT EXISTS idx_edges_removed ON edges(removed_at);");
}
```
Bump `SCHEMA_VERSION = 5`. Runs inside the existing `BEGIN IMMEDIATE` + post-lock re-check (`db.ts:44-48`), with `busy_timeout=5000` → multi-process safe (mcp-reviewer confirmed).

### 3.2 Guarantees

- **Old DB + new code** → `migrate()` adds both columns on first open; existing node rows `status=NULL`, existing edges `removed_at=NULL`; no data loss.
- **New DB + old code** → extra columns ignored (`insertNode`/`insertEdge` list explicit columns).
- **Embeddings untouched** — `embeddingText` uses name/kind/summary only (`tools.ts`) → no re-embed.
- **Merge** — edge key already relation-aware; `nodesAreIdentical` **must compare `status`** (else open/refuted divergence is silently lost); `removed_at` must round-trip (B1); merge-time DAG re-validation required (§2.1).

### 3.3 The prompt-upgrade hole (review-strengthened)

The DB migrates silently; **the prompts do not.** `install.ts` writes `AGENTS_MD_SNIPPET` + `commands/*.md` at install time, and `npm update -g` never re-runs install. Worse (mcp-reviewer, source-verified): `setupInstructionFile` (`install.ts:214-219`) is **marker-gated**, so even *re-running install* does not refresh the AGENTS.md/CLAUDE.md snippet (only command files are overwritten).

**Therefore:** anchor the load-bearing capture guidance in the **MCP tool descriptions/enums** (`index.ts`), which ship with the server and reach users on `npm update`. Command files become best-effort reinforcement. Surface a staleness signal on an **MCP-visible surface** — decorate `list_roots`/`understand` output with `{instructions_stale, server_version}` or an MCP resource — **not** `console.error`/stderr (`index.ts:541`), which the agent never sees. The install fix must use a **versioned marker-block replacement** (replace content between markers, preserve surrounding user edits) — not a naive overwrite. Version-stamp installed files.

---

## 4. Capture (write-time, LLM-declared)

### 4.1 Mechanism (reuses existing surfaces)

- `create_concept` already accepts `edges:[{to,relation,description}]` → attach `informed_by` in the same call as the decision.
- `link` handles after-the-fact edges and `supersedes`/`contradicts`.
- Add `status?` to `CreateConceptInput` (default `open` for epistemic) and `UpdateConceptInput.changes`, plus the two MCP tool schemas.

### 4.2 BLOCKING fixes for status threading (mcp-reviewer, source-verified)

1. **`db.updateNode` (`db.ts:311-358`) has no `status` branch** → a status-only update hits `fields.length===0 → return false` (silent no-op). Add a `status` branch.
2. **`buildNodeWithContext` (`tools.ts:92-104`) omits `status`** (and `NodeWithContext` in `types.ts:97-124` lacks it) → status is write-only/invisible on `understand`/`get_concept`. Thread `status` through both.

Without both, the feature is non-functional (unwritable + invisible).

### 4.3 Lifecycle rule — re-derivability, not "is it true now"

- **Descriptive concepts** (config/feature/module mirroring code, e.g. this repo's lone `repository-test-stack` node) are **re-derivable from code** → update or remove freely when stale.
- **Epistemic records** (decisions/experiments/tests/results/conclusions, correct **or** incorrect) have **no other home** → never remove; transition `status`. `refuted` records are kept deliberately.

### 4.4 `remove_concept` — refuse-and-redirect (replaces the cosmetic soft-warn)

- **Detect epistemic via `status IS NOT NULL`** (with `kind='decision'` as a legacy fallback), **not** `kind` alone (the enum only has `decision`; experiments/results have no kind).
- **Refuse-and-redirect when the target is epistemic OR participates in active epistemic relations** (round-3 + resolution — the narrow incoming-edge guard had holes): incoming `informed_by` (evidence depended upon), **outgoing `informed_by` on `status IS NULL` legacy nodes** (legacy conclusions/results that have ancestry), and **active `contradicts`/`supersedes` endpoints in either direction** — unless the node is explicitly classified descriptive/non-epistemic. Redirect epistemic targets to a `status` transition (`abandoned`/`refuted`/`superseded`).
- **Force-remove is barred for epistemic nodes** (status-flip only); a tombstone-set on a forced epistemic removal would still drop it from `getNode`/`understand`.
- For all removals: edges are **tombstoned** (§2.3), never physically deleted, so no sanctioned action destroys provenance. The `remove_concept` **tool description** (`index.ts:405`, currently "Soft-delete… preserved in history") must be rewritten — that claim is false for edges today.
- **The descriptive/non-epistemic escape needs a NEW explicit `remove_concept` parameter** (e.g. `treat_as_descriptive`) — `force` cannot carry it (force is barred for epistemic). The guard is a **read-time check** using tombstone-aware `getIncomingEdges`/`getOutgoingEdges` + incident `contradicts`/`supersedes` lookups, all `removed_at IS NULL`.
- **Legacy `NULL` triage (resolution):** before enabling v5 removal semantics, run a one-time triage/backfill — known epistemic legacy records get an explicit `status`; until triaged, legacy `NULL` nodes participating in any `informed_by`/`contradicts`/`supersedes` edge are protected by the read-time guard. Backfill must **not** auto-assign `open` to ambiguous `NULL` (that manufactures false epistemic state and pollutes §5.2 frontier/§5.4 hygiene) — prefer the read-time guard + a triage/unknown audit view, with manual status as durable cleanup.

---

## 5. Reflective Tools (scaffold, not engine)

Split at the natural seam (mcp-reviewer; avoids the "target required iff mode∈{ancestry,impact}" schema smell). Both are read-only and additive.

### 5.1 `provenance_trace(target, direction, depth?, caps…)`

- `direction: "upstream"` (ancestry — `informed_by` out-edges → reasoning lineage) | `"downstream"` (impact — in-edges → blast radius).
- Traverses **only the active `informed_by` projection** with a `visited_nodes` set + post-dedup `emitted_edges` set (stable edge identity), even though the DAG invariant exists, for legacy/corrupt-data safety. **`parent_id` is never traversed.**
- `supersedes`/`contradicts` appear only as **annotated cross-edges among already-emitted nodes**, never expanding closure.

### 5.2 `provenance_audit(view, limit?, cursor?)`

- `view: "retrospective"` → `refuted`/`superseded`/`abandoned` nodes + their ancestry (what informed the bad call) + what replaced them ("where did we go wrong").
- `view: "frontier"` → rank **`open` and `legacy_null` (unknown)** nodes (exclude validated/refuted/superseded/abandoned) by **weighted reverse-reachability over incoming `informed_by`**. Concrete formula (round-3, to provably avoid hub artifacts):

  ```
  score(n) = Σ_{d ∈ downstream(n) via incoming informed_by} weight(d) · decay^dist(n,d)
             ────────────────────────────────────────────────────────────────────────
                                  hubPenalty(n)
  weight(d)    = status/kind factor (validated dependents weigh most)
  decay        ∈ (0,1), e.g. 0.5
  hubPenalty(n)= log(1 + in_degree(n))   (or capped per-source contribution)
  tie-break    = deterministic (score, id)
  ```
  Expose the score components in the output. (NOT raw descendant count — that recreates the hub artifact the whole project eliminated.)

### 5.3 Bounds (mcp + graph reviewers; mandatory in the Zod schema)

- Defaults `depth=4`, `max_nodes=100`, `max_edges=200`; hard caps `depth≤8`, `max_nodes≤500`, `max_edges≤1000`. Caps enforced **during** traversal; counters count **post-dedup emitted** items.
- `detail = ids_only | summary | full` (default `summary`, ~200-char caps). `full` is **still bounded** by `max_bytes`/`max_text_chars` — graph cardinality caps alone do not bound JSON byte size.
- **Flat adjacency output** (`nodes[]` + `edges[]`), not nested trees (diamonds duplicate/blow tokens); IDs → `get_concept` for detail (progressive disclosure).
- Truncation metadata: `{truncated, truncation_reason, node_count, edge_count, max_depth_reached, next_cursor}`. Cursor ordering is deterministic `(depth, edge.id)` with a `generated_at` snapshot caveat.

### 5.4 Hygiene flags (first-class structured output)

`[{type, node, offending_ancestor, ancestor_status}]` covering:
- `validated_rests_on_unvalidated` (a `validated` conclusion reachable to an `open`/`refuted`/`superseded`/`abandoned`/`legacy_null` ancestor),
- `validated_contradiction` / `trusted_contradicted_by_validated` (a trusted node `contradicts`/is-contradicted-by a `validated` node) — round-3,
- `supersedes_target_not_superseded` (a `supersedes` edge whose target isn't marked `superseded`) — round-3,
- `broken_chain` (tombstoned `informed_by` ancestor), `cycle_detected` (defensive),
- `broken_contradiction` / `broken_supersedes` (resolution — a tombstoned `contradicts`/`supersedes` edge; without these, removing a discourse-edge endpoint makes a live hygiene flag silently go dark).

Implemented as a reachability query over the `informed_by` ancestry filtered by status; brute force is fine at <10k nodes.

---

## 6. File-Level Change Map

| File | Change |
|---|---|
| `db.ts` | v5 migration (2 ALTERs + index); `updateNode` status branch; `softDeleteNode` → **tombstone** edges (set `removed_at`, no physical DELETE); **add `removed_at` to `insertEdgeRaw`** (B1); **enumerate tombstone-aware reads** — `getOutgoingEdges`/`getIncomingEdges`/`getAllEdges`/`getStats` (don't count tombstones)/`getEdgesAtTime` (B2); `getAllEdgesRaw` stays unfiltered (merge needs full set); new `informed_by`-filtered, removed-**parameterized** traversal methods (B3); DAG cycle-check helper |
| `types.ts` | `RelationType` += 3; `NodeStatus` type; `status?` on Create/Update inputs; `status` on `NodeWithContext`; `removed_at` on `Edge`/`DeferredEdge` |
| `index.ts` | relation enum += 3; `status` params + bounded `provenance_trace`/`provenance_audit` tool schemas (caps in Zod); tool descriptions carry capture guidance; **rewrite `remove_concept` description**; **add `treat_as_descriptive` param to `remove_concept`**; staleness signal on read tools |
| `tools.ts` | persist `status`; thread `status` into `buildNodeWithContext`; trace/audit handlers w/ caps + hygiene flags; refuse-and-redirect in remove handler via a **read-time epistemic-participation guard** (incoming `informed_by`, outgoing `informed_by` on NULL nodes, `contradicts`/`supersedes` endpoints) with a `treat_as_descriptive` escape; legacy `NULL` triage/audit view |
| `merge.ts` | **thread `removed_at` through `DeferredEdge` + all push-sites + final `insertEdgeRaw`** (B1); compare `status` in `nodesAreIdentical`; **post-pass `informed_by` cycle check on the union graph → flag `needs_merge`** (not abort) |
| `install.ts` | refresh `AGENTS_MD_SNIPPET` + `commands/*.md` (relation list, `status`, lifecycle rule); **versioned marker-block replacement** so re-install refreshes the snippet; version-stamp |
| `commands/*.md` | provenance discipline; relation list; `status`; abandoned-vs-remove rule |
| `web.ts` | render new relations + status (optional, later) |

---

## 7. Out of Scope / Deferred

- **Statistical causal discovery** (arXiv:2505.10476) — revisit when timelines pool across many projects (then aggregation + consistency scores become the right tool).
- **Validation provenance metadata** (who/method/when/scope/confidence) — phase 2; for now require it in the status-update rationale text.
- **`validated`-then-later-`refuted` propagation** (re-flag descendants) — phase 2.
- Web-explorer visualization of provenance — later.

---

## 8. Risks

- Capture is prompt-load-bearing; mitigated by anchoring guidance in tool descriptions (§3.3).
- LLM-authored cycles in `informed_by`, incl. merge-induced; mitigated by write/merge-time DAG enforcement + atomic union check (§2.1).
- Silent provenance loss via edge deletion/merge resurrection; mitigated by tombstones + `insertEdgeRaw` round-trip + enumerated tombstone-aware reads (§2.3, §6 B1–B3).
- Over-trusting `open`/`NULL`; mitigated by hygiene flags + "validated-only is trusted" (§2.2, §5.4).
- Payload blowup; mitigated by schema-enforced cardinality **and** byte caps (§5.3).

---

## 9. Review Provenance

- **Round 1** (full design): causal, MCP, graph — converged on de-causalize terminology, NULL=unknown, soft-warn insufficient, mandatory trace caps, supersedes/contradicts excluded from closure.
- **Round 2** (corrected A2A choreography): closed cross-questions; confirmed frontier=weighted reverse-reachability, strict-DAG `informed_by`, tombstone + refuse-and-redirect.
- **Round 3** (verification of this doc): verdict **ready-with-changes** across all three; surfaced B1 (merge resurrects tombstones via `insertEdgeRaw`), B2 (unenumerated tombstone-aware reads), B3 (retrospective node/edge predicate asymmetry), plus the frontier formula, `parent_id` exclusion, status-in-merge comparison, `detail=full` byte cap, and the `§9` fix — all incorporated above.
- **Resolution exchange (causal↔mcp, focused 2-agent, A2A-state-verified):** the round-3 leg that dropped (mcp→causal) was re-run and closed — confirmed against the server: `resolution-causal-mcp` interface published by `causal-reviewer`, both reviewers unregistered, bus drained. Verdict **residual-gaps-remain**: the §4.4 guard was broadened to outgoing-`informed_by` legacy `NULL` nodes and `contradicts`/`supersedes` endpoints; a legacy-`NULL` triage requirement + `treat_as_descriptive` escape were added; §2.2 gained scope hardening; §5.4 gained `broken_contradiction`/`broken_supersedes`.
