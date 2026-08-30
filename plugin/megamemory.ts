import { tool } from "@opencode-ai/plugin";

const SKILL = `
---
name: megamemory
description: Project knowledge graph — persistent memory across sessions. Use at session start, before tasks (to load context), and after tasks (to record what you built). The graph stores concepts, architecture, decisions, and relationships — written by you, for you.
allowed-tools: "megamemory:*"
---

# Megamemory — Project Knowledge Graph

Your persistent memory of the codebase. You have no implicit memory of this project between sessions, so this graph is your continuity. You write concepts as you work, and you query them before starting tasks.

## When to Use

- **Session start** → You must call \`list_roots\` before beginning work
- **Before any task** → You must call \`understand\` before reading source files for project understanding
- **After any task** → You must call \`create_concept\` / \`update_concept\` / \`link\` to record what you did
- **Refactoring or removing features** → You must call \`remove_concept\` to mark things as gone (with reason)

## Core Principles

1. **Query before work, update after work.** This is required, not optional.
2. **Concepts, not code.** Nodes are features, patterns, decisions — not files or symbols.
3. **Be specific.** Include parameter names, defaults, file paths, rationale.
4. **Keep it shallow.** Max 3 levels deep. Useful beats exhaustive.
5. **Link every memory.** Creating a memory without linking it to another memory greatly degrades its usefulness — unlinked concepts don't surface through graph traversal. Connect each new concept to the graph (\`edges\` at creation, a \`parent_id\`, or \`link\` immediately after).

## Concept Kinds

\`feature\` | \`module\` | \`pattern\` | \`config\` | \`decision\` | \`component\`

## Relationship Types

**Structural:**
- \`depends_on\` — A requires B to function
- \`implements\` — A is the concrete implementation of B
- \`calls\` — A invokes B at runtime
- \`connects_to\` — A and B interact or share data
- \`configured_by\` — A's behavior is controlled by B

**Evidential provenance** (authored support, not causal inference):
- \`informed_by\` — A (a decision/finding) was materially supported by B (evidence, a prior result, an assumption, or a decision basis). Strict DAG — cycles are rejected; put the rationale in the edge description.
- \`supersedes\` — A replaces B; also set B's status to \`superseded\`.
- \`contradicts\` — A and B conflict; both records stay visible.

## Concept Status

For decisions / experiments / results: \`open\` (proposed — not a correctness claim) · \`validated\` (confirmed for a stated scope, by explicit evidence — never assumed) · \`refuted\` · \`superseded\` · \`abandoned\`. Omit for descriptive concepts that mirror code; legacy NULL means unknown, not validated. Prefer a status transition over deleting an epistemic record.

## MCP Tools Reference

> Call each tool by the exact name shown in your available-tools list. Clients namespace them differently (e.g. Claude Code exposes them as \`megamemory:list_roots\`), so use your client's actual name — do not invoke a literal \`megamemory:\`-prefixed name unless your tool list shows it.

| Tool | When | What it does |
|---|---|---|
| \`understand\` | Before tasks | Semantic search — returns matching concepts with children, edges, parent |
| \`create_concept\` | After tasks | Add a concept (summary, kind, status, edges, file refs) |
| \`update_concept\` | After tasks | Patch fields, including \`status\` |
| \`link\` | After tasks | Create a relationship (structural or evidential provenance) |
| \`remove_concept\` | On refactor/delete | Soft-delete; refuses epistemic nodes unless \`treat_as_descriptive\` |
| \`list_roots\` | Session start | All top-level concepts with children + stats |
| \`provenance_trace\` | Auditing | Trace \`informed_by\` lineage — \`upstream\` (evidence a decision rests on) or \`downstream\` (impact) |
| \`provenance_audit\` | Auditing | \`retrospective\` (refuted/superseded/abandoned lineage) · \`frontier\` (open concepts ranked by what depends on them — what to validate next) · \`triage\` (legacy unstatused) |
| \`list_conflicts\` | After merge | Lists unresolved merge conflicts grouped by merge_group |
| \`resolve_conflict\` | During /merge | Resolve a conflict by providing verified, correct content |
`;

export default tool({
  description: SKILL,
  args: {
    action: tool.schema
      .enum(["query", "record", "overview", "merge"])
      .describe(
        "Workflow action: query (before task — understand context), record (after task — create/update/link), overview (session start — list roots), merge (resolve merge conflicts)",
      ),
    query: tool.schema
      .string()
      .optional()
      .describe("Natural language query for the 'query' action"),
    concepts: tool.schema
      .string()
      .optional()
      .describe(
        "For 'record' action: brief description of what concepts to create/update/link",
      ),
  },
  async execute({ action, query, concepts }) {
    switch (action) {
      case "overview":
        return `To get a project overview, call:

1. list_roots — Returns all top-level concepts with their children and graph stats.

Use this at the start of every session to orient yourself. If the graph is empty, proceed normally and create concepts as you work.`;

      case "query":
        if (!query) {
          return "Error: query is required for the query action. Describe what you need to understand about the project.";
        }
        return `To load context for "${query}", call:

1. understand — query="${query}"
   Returns: matched concepts ranked by relevance, each with:
   - summary, why, file_refs
   - children (1 level)
   - outgoing and incoming edges
   - parent context

Use the returned context instead of re-reading source files when possible. If no relevant results come back, proceed normally — the graph may not cover this area yet.`;

      case "record":
        return `After completing your task, update the knowledge graph:

1. **New concepts** → create_concept
   - name: human-readable name
   - kind: feature | module | pattern | config | decision | component
   - status (decisions/experiments/results): open for a proposal not yet confirmed; omit for descriptive concepts that mirror code
   - summary: specific — include param names, defaults, file paths, behavior
   - why: rationale for this design
   - parent_id: parent concept slug (for nesting)
   - file_refs: relevant file paths + line ranges
   - edges: [{to: "concept-id", relation: "depends_on|implements|calls|connects_to|configured_by|informed_by|supersedes|contradicts", description: "why"}] (provenance relations require the rationale in description)
     ALWAYS link: creating a memory without linking it to another memory greatly degrades its usefulness — include at least one edge (or a parent_id), or call link right after.
   - created_by_task: what task/prompt created this

2. **Changed concepts** → update_concept
   - id: the concept slug
   - changes: {summary?, why?, file_refs?, name?, kind?, status?} (transition a decision's status — validated/refuted/superseded/abandoned — instead of deleting it)

3. **New relationships** → link
   - from, to: concept IDs
   - relation: depends_on | implements | calls | connects_to | configured_by | informed_by | supersedes | contradicts
   - description: why this relationship exists (required for informed_by / supersedes / contradicts)

4. **Removed / superseded** → remove_concept
   - id: concept to remove
   - reason: why it was removed
   - treat_as_descriptive: set true ONLY for a genuinely descriptive concept (mirrors code, re-derivable); decisions, status-bearing nodes, and informed_by targets are refused by default — transition their status instead${concepts ? `\n\nContext about what to record: "${concepts}"` : ""}`;

      case "merge":
        return `To resolve merge conflicts in the knowledge graph:

1. **List conflicts** → list_conflicts
   - Returns all unresolved conflicts grouped by merge_group
   - Each group has competing versions with summaries, file_refs, edges

2. **For each conflict:**
   a. Read both versions' summaries, file_refs, and edges
   b. Read the actual source files referenced in file_refs to determine what the code ACTUALLY does now
   c. Write the correct resolved content based on the current codebase — do NOT just pick a side

3. **Resolve** → resolve_conflict
   - merge_group: the UUID of the conflict
   - resolved: {summary, why?, file_refs?} — the verified, correct content
   - reason: what you verified and why this resolution is correct

The goal is accuracy: the resolved concept should describe the code as it actually exists. If referenced files no longer exist, the concept may be outdated — update or remove accordingly.`;

      default:
        return `Unknown action: ${action}. Use: overview (session start), query (before task), record (after task), merge (resolve conflicts).`;
    }
  },
});
