# Save Session Knowledge

You are saving what you learned this session into the megamemory knowledge graph.
This is YOUR memory — record anything valuable for future sessions: what you
understood about the project, what you built, decisions that were made, patterns
you noticed, or intent the user shared.

## Step 1: Load existing graph

Call `list_roots` to see what's already recorded. Understanding the
current state prevents duplicates and helps you decide what to update vs create.

## Step 2: Reflect on this session

Think about what happened this session. Consider:
- What did you learn about the project's purpose or intent?
- What features, modules, or components did you build or change?
- What design decisions were made and why?
- What patterns or conventions did you discover?
- What architectural understanding do you have now that isn't in the graph?
- Did anything get removed, replaced, or deprecated?

## Step 3: Search for overlap

Before creating anything new, call `understand` with queries based on
what you worked on this session. For each area you touched, search to see if
concepts already exist that should be updated rather than duplicated.

For example, if you worked on authentication, call:
  understand — query="authentication"

Do this for each distinct area. Existing concepts that are stale or incomplete
should be updated — don't create a new node when an update will do.

## Step 4: Write to the knowledge graph

For each thing worth remembering:

**New understanding** → `create_concept`
  - name: human-readable name
  - kind: use `decision` for intent/rationale, `feature` for capabilities,
    `module` for subsystems, `pattern` for conventions, `config` for setup,
    `component` for distinct pieces of a system
  - status (decisions/experiments/results only): `open` for a proposal not yet
    confirmed; omit for descriptive concepts that mirror code (see Evidential
    Provenance below)
  - summary: be specific — include parameter names, defaults, file paths,
    behavior details, and the WHY behind things
  - why: the rationale — this is often the most valuable part
  - file_refs: relevant files if applicable
  - edges: connect to existing concepts where relationships exist
    [{to: "concept-id", relation: "depends_on|implements|calls|connects_to|configured_by|informed_by|supersedes|contradicts", description: "why"}]
    Provenance relations (`informed_by`, `supersedes`, `contradicts`) require the
    rationale in `description` — see Evidential Provenance below.
  - created_by_task: brief description of what you were doing this session

**Updated understanding** → `update_concept`
  - id: the concept slug
  - changes: {summary?, why?, file_refs?, name?, kind?, status?}
  If an existing concept is now stale or incomplete based on what you learned,
  update it. This is often more valuable than creating new nodes. To change a
  decision's epistemic state (`open` → `validated`/`refuted`/`superseded`/
  `abandoned`), update its `status` with a `why` rather than deleting it.

**New connections** → `link`
  - from, to: concept IDs
  - relation: depends_on | implements | calls | connects_to | configured_by |
    informed_by | supersedes | contradicts
  - description: why this relationship exists (required for `informed_by`,
    `supersedes`, and `contradicts`)
  If you discovered how existing concepts relate to each other.

**Removed/replaced things** → `remove_concept`
  - id: concept to remove
  - reason: why it was removed
  - treat_as_descriptive: set `true` only for a genuinely descriptive concept
    (mirrors code, re-derivable). Decisions, status-bearing nodes, and anything
    other concepts are `informed_by` are refused by default — transition their
    `status` (`abandoned`/`refuted`/`superseded`) instead of removing them.
  If something descriptive in the graph is no longer true.

## Step 5: Verify

Call `list_roots` again. Confirm the graph reflects your current
understanding. Report what you saved.

## Guidelines

- Record what a future you (with no memory of this session) would need to know.
- Intent and rationale ("why") are more valuable than implementation details.
- Update existing concepts before creating new ones — keep the graph lean.
- Don't record trivial things. If it's obvious from the code, skip it.
- Max 2 levels of nesting. Flat is better than deep.
- Connect concepts — isolated nodes are less useful than a connected graph.
- Be specific. "Handles auth" is useless. "JWT auth with RS256, validated in
  middleware at src/middleware/auth.ts, refresh tokens in Redis with 7d TTL" is useful.

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
