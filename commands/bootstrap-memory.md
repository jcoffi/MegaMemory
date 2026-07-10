# Bootstrap Project Knowledge Graph

RUN { git ls-files; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u | xargs wc -l 2>/dev/null | sort -rn | head -150
READ README.md

You are bootstrapping the megamemory knowledge graph for this project.

Your job is to understand the codebase and record its core concepts, architecture,
and patterns as knowledge graph nodes. The file listing above is sorted by line
count — the biggest files are where the core logic lives.

## Step 1: Check existing graph

Call `list_roots` to see what's already recorded. If the graph has
good coverage, report what's there and ask if I want to fill in specific areas.

## Step 2: Identify major modules

From the file listing and README, identify the top-level systems in this project.
Think in terms of:
- What does this project DO? (features)
- What are the distinct subsystems? (modules)
- How is it structured? (patterns, decisions)

## Step 3: Read and create root concepts

For each major module, read its key files to understand what it does. Then call
`create_concept` with a specific, detailed summary. Include parameter
names, defaults, file paths, and behavior details — not vague descriptions.

## Step 4: Create children for important sub-components

For substantial modules, create child concepts for key pieces. Stay max 2 levels
deep. Focus on things a developer would need to know when working in that area.

## Step 5: Link related concepts

Connect concepts that interact across boundaries using `link`.
Structural relationships: `depends_on`, `calls`, `connects_to`, `implements`,
`configured_by`. Provenance relationships (see Evidential Provenance below):
`informed_by`, `supersedes`, `contradicts`.

## Guidelines

- Be specific. "Handles auth" is useless. "JWT auth with RS256, tokens from
  /auth/login, validated in middleware, refresh tokens in Redis with 7d TTL" is useful.
- Focus on the top 10-15 most important concepts first. The graph grows over time.
- Don't document trivial things. If it's obvious from the file name, skip it.

## Evidential Provenance

- Use `informed_by` only when a concept was materially supported by evidence,
  assumptions, prior results, or a decision basis. It records authored evidential
  support, not causal inference, and must stay acyclic (a strict DAG — cycles are
  rejected). Put the rationale in the edge `description`.
- Use `supersedes` when a newer concept replaces an older one, and set the older
  concept's status to `superseded`.
- Use `contradicts` when concepts conflict and both records should remain visible.
- Node status values: `open`, `validated`, `refuted`, `superseded`, `abandoned`.
  New epistemic work should start as `open`; legacy NULL status means unknown,
  not validated. `validated` must be earned by explicit evidence for a stated
  scope, never assumed.
- Prefer status transitions such as `abandoned`, `refuted`, or `superseded` over
  removing epistemic records. `remove_concept` refuses to delete decisions,
  status-bearing nodes, and anything other concepts are `informed_by` unless you
  pass `treat_as_descriptive: true`; remove only descriptive records that are
  clearly re-derivable from the source tree.
- Reflect with the read-only tools: `provenance_trace` (direction
  `upstream` = the evidence a decision rests on; `downstream` = what a finding
  influenced) and `provenance_audit` (`retrospective` = refuted/
  superseded/abandoned lineage; `frontier` = open concepts ranked by how much
  depends on them, i.e. what to validate next; `triage` = legacy concepts with
  no status).
