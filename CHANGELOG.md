# Changelog

## 1.7.0 — Evidential Provenance

### Features

- **Evidential provenance relations** — `informed_by` (strict DAG; material evidential support), `supersedes`, `contradicts`. Authored provenance, **not** causal inference.
- **Decision status lifecycle** — `open` · `validated` · `refuted` · `superseded` · `abandoned` (absent/NULL = legacy/unknown, never treated as validated).
- **`provenance_trace` tool** — walk `informed_by` upstream (reasoning lineage) or downstream (impact); bounded subgraph with status, supersedes/contradicts cross-edges, and hygiene flags.
- **`provenance_audit` tool** — `retrospective` (refuted/superseded/abandoned decisions + lineage + replacements), `frontier` (open/unvalidated concepts ranked by hub-penalized downstream dependence), `triage` (legacy NULL-status concepts that participate in provenance).
- **Hygiene flags** — surfaces validated conclusions resting on unvalidated/refuted ancestors, broken chains, contradictions, and cycles.
- **Refuse-and-redirect deletion** — `remove_concept` protects epistemic records (anything with a status, or that others are `informed_by`); transition status instead. `treat_as_descriptive` escape for re-derivable concepts.
- **Edge tombstones** — removals preserve provenance lineage (`edges.removed_at`) rather than hard-deleting it.

### Schema

- **v5 migration** — adds `nodes.status` + `edges.removed_at` (idempotent, multi-process-safe). Backward compatible; existing graphs upgrade on first open with no re-embedding.

## 1.0.0 — Initial Release

### Features

- **MCP server** with 6 tools: `understand`, `create_concept`, `update_concept`, `link`, `remove_concept`, `list_roots`
- **Semantic search** via in-process embeddings (all-MiniLM-L6-v2, 384 dimensions) — no external API calls
- **SQLite persistence** with soft-delete, schema migrations, and WAL mode
- **Web explorer** — browser-based graph visualization with Cytoscape.js at `megamemory serve`
- **CLI** with colored output, graceful error handling, and interactive port conflict resolution
- **`megamemory init`** — one-command setup for opencode (MCP config, AGENTS.md, skill plugin, bootstrap command)
- **Concept kinds**: feature, module, pattern, config, decision, component
- **Relationship types**: connects_to, depends_on, implements, calls, configured_by
- **Knowledge graph** designed for LLM agents — concepts in natural language, not code symbols
