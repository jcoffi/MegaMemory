import { KnowledgeDB } from "./db.js";
import { embed, embeddingText, findTopK } from "./embeddings.js";
import type {
  UnderstandInput,
  GetConceptInput,
  CreateConceptInput,
  UpdateConceptInput,
  LinkInput,
  RemoveConceptInput,
  ResolveConflictInput,
  NodeWithContext,
  UnderstandOutput,
  ListRootsOutput,
  ListConflictsOutput,
  ConflictGroup,
  NodeRow,
  EdgeRow,
  NodeStatus,
  RelationType,
} from "./types.js";
import { stripMergeSuffix } from "./merge.js";

export type TraceDirection = "upstream" | "downstream";
export type TraceDetail = "ids_only" | "summary" | "full";
export type AuditView = "retrospective" | "frontier" | "triage";

export interface TraceInput {
  target: string;
  direction: TraceDirection;
  depth?: number;
  max_nodes?: number;
  max_edges?: number;
  detail?: TraceDetail;
  max_text_chars?: number;
  max_bytes?: number;
  include_removed?: boolean;
}

export interface TraceNode {
  id: string;
  name?: string;
  kind?: string;
  status?: NodeStatus | null;
  summary?: string;
  why?: string | null;
  removed_at?: string | null;
}

export interface TraceEdge {
  id: number;
  from_id: string;
  to_id: string;
  relation: RelationType;
  description: string | null;
  removed_at: string | null;
}

export interface HygieneFlag {
  type:
    | "validated_rests_on_unvalidated"
    | "validated_contradiction"
    | "trusted_contradicted_by_validated"
    | "supersedes_target_not_superseded"
    | "broken_chain"
    | "cycle_detected"
    | "broken_contradiction"
    | "broken_supersedes";
  node: string;
  offending_ancestor?: string;
  ancestor_status?: NodeStatus | null;
  edge_id?: number;
}

export interface TraceOutput {
  target: string;
  direction: TraceDirection;
  nodes: TraceNode[];
  edges: TraceEdge[];
  cross_edges: TraceEdge[];
  hygiene_flags: HygieneFlag[];
  truncated: boolean;
  truncation_reason: string | null;
  node_count: number;
  edge_count: number;
  max_depth_reached: number;
  next_cursor: string | null;
}

export type AuditOutput =
  | {
      view: "retrospective";
      items: Array<{ node: TraceNode; trace: TraceOutput; replacements: TraceNode[] }>;
      hygiene_flags: HygieneFlag[];
      next_cursor: string | null;
    }
  | {
      view: "frontier";
      items: Array<{
        node: TraceNode;
        score: number;
        components: {
          downstream_weight: number;
          hub_penalty: number;
          in_degree: number;
          decay: number;
        };
      }>;
      hygiene_flags: HygieneFlag[];
      next_cursor: string | null;
    }
  | {
      view: "triage";
      items: Array<{ node: TraceNode; reasons: string[] }>;
      hygiene_flags: HygieneFlag[];
      next_cursor: string | null;
    };

export function formatError(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const errorMsg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `MEGAMEMORY_ERROR: ${errorMsg}` }],
    isError: true,
  };
}

/**
 * Generate a slug ID from a name, optionally prefixed with parent ID.
 * Converts underscores and spaces to hyphens, lowercases, strips non-alphanumeric.
 */
export function makeId(name: string, parentId?: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[_\s]+/g, "-")          // underscores/spaces → hyphens
    .replace(/[^a-z0-9-]/g, "")       // strip everything else
    .replace(/-+/g, "-")              // collapse multiple hyphens
    .replace(/^-|-$/g, "");           // trim leading/trailing hyphens
  return parentId ? `${parentId}/${normalized}` : normalized;
}

/**
 * Parse file_refs from JSON string to array.
 */
function parseFileRefs(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function truncateText(value: string | null | undefined, maxChars: number): string | null | undefined {
  if (value === null || value === undefined) return value;
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function toTraceNode(node: NodeRow, detail: TraceDetail, maxTextChars: number): TraceNode {
  const base: TraceNode = { id: node.id };
  if (detail === "ids_only") return base;

  base.name = node.name;
  base.kind = node.kind;
  base.status = node.status;
  base.summary = truncateText(node.summary, maxTextChars) ?? "";
  if (node.removed_at) base.removed_at = node.removed_at;
  if (detail === "full") {
    base.why = truncateText(node.why, maxTextChars) ?? null;
  }
  return base;
}

function toTraceEdge(edge: EdgeRow, maxTextChars: number): TraceEdge {
  return {
    id: edge.id,
    from_id: edge.from_id,
    to_id: edge.to_id,
    relation: edge.relation as RelationType,
    description: truncateText(edge.description, maxTextChars) ?? null,
    removed_at: edge.removed_at,
  };
}

function enforceTraceByteCap(trace: TraceOutput, maxBytes: number): TraceOutput {
  if (Buffer.byteLength(JSON.stringify(trace), "utf-8") <= maxBytes) return trace;

  trace.truncated = true;
  trace.truncation_reason = "max_bytes";
  for (const node of trace.nodes) {
    if (node.summary !== undefined) node.summary = "";
    if (node.why !== undefined) node.why = null;
  }
  for (const edge of [...trace.edges, ...trace.cross_edges]) {
    edge.description = null;
  }

  while (Buffer.byteLength(JSON.stringify(trace), "utf-8") > maxBytes) {
    if (trace.cross_edges.length > 0) {
      trace.cross_edges.pop();
      continue;
    }
    if (trace.edges.length > 0) {
      trace.edges.pop();
      trace.edge_count = trace.edges.length;
      continue;
    }
    if (trace.nodes.length > 1) {
      trace.nodes.pop();
      trace.node_count = trace.nodes.length;
      continue;
    }
    break;
  }

  return trace;
}

function allActiveNodes(db: KnowledgeDB): NodeRow[] {
  return db.getAllNodesRaw().filter((node) => node.removed_at === null);
}

function allActiveEdges(db: KnowledgeDB): EdgeRow[] {
  return db.getAllEdges().sort((a, b) => a.id - b.id);
}

function validateInformedByEdge(db: KnowledgeDB, from: string, to: string, description: string | null | undefined): void {
  if (!description?.trim()) {
    throw new Error("informed_by relationships require a non-empty description rationale.");
  }
  if (db.wouldCreateCycle(from, to)) {
    throw new Error(`Adding informed_by from "${from}" to "${to}" would create an informed_by cycle.`);
  }
}

function ancestryIds(db: KnowledgeDB, start: string, includeRemoved = false): Map<string, NodeRow> {
  const result = new Map<string, NodeRow>();
  const visited = new Set<string>([start]);
  let frontier = [start];

  while (frontier.length > 0) {
    const { nodes, edges } = db.getProvenanceEdges(frontier, {
      direction: "upstream",
      includeRemoved,
    });
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const next: string[] = [];
    for (const edge of edges.sort((a, b) => a.id - b.id)) {
      const ancestor = edge.to_id;
      if (visited.has(ancestor)) continue;
      const node = nodeById.get(ancestor);
      if (!node) continue;
      visited.add(ancestor);
      result.set(ancestor, node);
      next.push(ancestor);
    }
    frontier = next;
  }

  return result;
}

function nodeWeight(node: NodeRow): number {
  if (node.status === "validated") return 6;
  if (node.status === "open" || node.status === null) return 1;
  return 0.5;
}

/**
 * Build a NodeWithContext from a node row and DB lookups.
 */
export function buildNodeWithContext(
  db: KnowledgeDB,
  node: NodeRow,
  similarity?: number
): NodeWithContext {
  const children = db.getChildren(node.id).map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind as NodeWithContext["kind"],
    summary: c.summary,
  }));

  const outgoing = db.getOutgoingEdges(node.id).map((e) => ({
    to: e.to_id,
    to_name: e.to_name,
    relation: e.relation as RelationType,
    description: e.description,
  }));

  const incoming = db.getIncomingEdges(node.id).map((e) => ({
    from: e.from_id,
    from_name: e.from_name,
    relation: e.relation as RelationType,
    description: e.description,
  }));

  let parent: { id: string; name: string } | null = null;
  if (node.parent_id) {
    const p = db.getParent(node.parent_id);
    if (p) {
      parent = { id: p.id, name: p.name };
    }
  }

  return {
    id: node.id,
    name: node.name,
    kind: node.kind as NodeWithContext["kind"],
    summary: node.summary,
    status: node.status,
    why: node.why,
    file_refs: parseFileRefs(node.file_refs),
    children,
    edges: outgoing,
    incoming_edges: incoming,
    parent,
    ...(similarity !== undefined ? { similarity } : {}),
  };
}

export function provenanceTrace(db: KnowledgeDB, input: TraceInput): TraceOutput {
  const target = db.getNode(input.target);
  if (!target) {
    throw new Error(`Concept "${input.target}" not found.`);
  }

  const depth = clampInteger(input.depth, 4, 1, 8);
  const maxNodes = clampInteger(input.max_nodes, 100, 1, 500);
  const maxEdges = clampInteger(input.max_edges, 200, 0, 1000);
  const detail = input.detail ?? "summary";
  const maxTextChars = clampInteger(input.max_text_chars, detail === "full" ? 1000 : 200, 0, 5000);
  const maxBytes = clampInteger(input.max_bytes, 100_000, 200, 1_000_000);
  const includeRemoved = input.include_removed ?? false;

  const nodeRows = new Map<string, NodeRow>([[target.id, target]]);
  const visitedNodes = new Set<string>([target.id]);
  const emittedEdges = new Map<number, EdgeRow>();
  let frontier = [target.id];
  let truncated = false;
  let truncationReason: string | null = null;
  let maxDepthReached = 0;

  for (let currentDepth = 0; currentDepth < depth && frontier.length > 0; currentDepth += 1) {
    const { nodes, edges } = db.getProvenanceEdges(frontier, {
      direction: input.direction,
      includeRemoved,
    });
    const adjacentNodes = new Map(nodes.map((node) => [node.id, node]));
    const nextFrontier: string[] = [];

    for (const edge of edges.sort((a, b) => a.id - b.id)) {
      const neighborId = input.direction === "upstream" ? edge.to_id : edge.from_id;
      const neighbor = adjacentNodes.get(neighborId);
      if (!neighbor) continue;

      const edgeAlreadyEmitted = emittedEdges.has(edge.id);
      if (!edgeAlreadyEmitted && emittedEdges.size >= maxEdges) {
        truncated = true;
        truncationReason = truncationReason ?? "max_edges";
        continue;
      }

      if (!visitedNodes.has(neighborId)) {
        if (nodeRows.size >= maxNodes) {
          truncated = true;
          truncationReason = truncationReason ?? "max_nodes";
          continue;
        }
        visitedNodes.add(neighborId);
        nodeRows.set(neighborId, neighbor);
        nextFrontier.push(neighborId);
      }

      if (!edgeAlreadyEmitted) {
        if (nodeRows.has(edge.from_id) && nodeRows.has(edge.to_id)) {
          emittedEdges.set(edge.id, edge);
        }
      }
    }

    if (nextFrontier.length > 0 || edges.length > 0) {
      maxDepthReached = currentDepth + 1;
    }
    frontier = nextFrontier;
  }

  const emittedNodeIds = new Set(nodeRows.keys());
  const crossEdges = allActiveEdges(db).filter(
    (edge) =>
      (edge.relation === "supersedes" || edge.relation === "contradicts") &&
      emittedNodeIds.has(edge.from_id) &&
      emittedNodeIds.has(edge.to_id)
  );

  const trace: TraceOutput = {
    target: input.target,
    direction: input.direction,
    nodes: [...nodeRows.values()].map((node) => toTraceNode(node, detail, maxTextChars)),
    edges: [...emittedEdges.values()].map((edge) => toTraceEdge(edge, maxTextChars)),
    cross_edges: crossEdges.map((edge) => toTraceEdge(edge, maxTextChars)),
    hygiene_flags: computeHygieneFlags(db, emittedNodeIds),
    truncated,
    truncation_reason: truncationReason,
    node_count: nodeRows.size,
    edge_count: emittedEdges.size,
    max_depth_reached: maxDepthReached,
    next_cursor: truncated ? `${maxDepthReached}:${emittedEdges.size}` : null,
  };

  return detail === "full" ? enforceTraceByteCap(trace, maxBytes) : trace;
}

export function provenanceAudit(
  db: KnowledgeDB,
  input: { view: AuditView; limit?: number; cursor?: string }
): AuditOutput {
  const limit = clampInteger(input.limit, 25, 1, 100);
  const hygieneFlags = computeHygieneFlags(db);

  if (input.view === "retrospective") {
    const replacementEdges = allActiveEdges(db).filter((edge) => edge.relation === "supersedes");
    const activeById = new Map(allActiveNodes(db).map((node) => [node.id, node]));
    const items = allActiveNodes(db)
      .filter((node) =>
        node.status === "refuted" || node.status === "superseded" || node.status === "abandoned"
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((node) => ({
        node: toTraceNode(node, "summary", 200),
        trace: provenanceTrace(db, {
          target: node.id,
          direction: "upstream",
          include_removed: true,
        }),
        replacements: replacementEdges
          .filter((edge) => edge.to_id === node.id)
          .map((edge) => activeById.get(edge.from_id))
          .filter((replacement): replacement is NodeRow => replacement !== undefined)
          .map((replacement) => toTraceNode(replacement, "summary", 200)),
      }));
    return { view: "retrospective", items, hygiene_flags: hygieneFlags, next_cursor: null };
  }

  if (input.view === "triage") {
    const relationEdges = allActiveEdges(db).filter(
      (edge) =>
        edge.relation === "informed_by" || edge.relation === "contradicts" || edge.relation === "supersedes"
    );
    const reasonsByNode = new Map<string, Set<string>>();
    for (const edge of relationEdges) {
      for (const nodeId of [edge.from_id, edge.to_id]) {
        const reasons = reasonsByNode.get(nodeId) ?? new Set<string>();
        reasons.add(edge.relation);
        reasonsByNode.set(nodeId, reasons);
      }
    }

    const items = allActiveNodes(db)
      .filter((node) => node.status === null && reasonsByNode.has(node.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((node) => ({
        node: toTraceNode(node, "summary", 200),
        reasons: [...(reasonsByNode.get(node.id) ?? new Set<string>())].sort(),
      }));
    return { view: "triage", items, hygiene_flags: hygieneFlags, next_cursor: null };
  }

  const activeEdges = allActiveEdges(db);
  const activeById = new Map(allActiveNodes(db).map((node) => [node.id, node]));
  const incomingInformedBy = activeEdges.filter((edge) => edge.relation === "informed_by");
  const inDegreeByNode = new Map<string, number>();
  for (const edge of incomingInformedBy) {
    inDegreeByNode.set(edge.to_id, (inDegreeByNode.get(edge.to_id) ?? 0) + 1);
  }
  const decay = 0.5;

  const items = [...activeById.values()]
    .filter((node) => node.status === "open" || node.status === null)
    .map((node) => {
      const visited = new Set<string>([node.id]);
      let frontier = [{ id: node.id, distance: 0 }];
      let downstreamWeight = 0;

      while (frontier.length > 0) {
        const next: Array<{ id: string; distance: number }> = [];
        const { nodes, edges } = db.getProvenanceEdges(
          frontier.map((entry) => entry.id),
          { direction: "downstream" }
        );
        const nodeMap = new Map(nodes.map((entry) => [entry.id, entry]));

        for (const edge of edges.sort((a, b) => a.id - b.id)) {
          const dependentId = edge.from_id;
          if (visited.has(dependentId)) continue;
          const dependent = nodeMap.get(dependentId);
          if (!dependent) continue;
          const parent = frontier.find((entry) => entry.id === edge.to_id);
          const distance = (parent?.distance ?? 0) + 1;
          visited.add(dependentId);
          downstreamWeight += nodeWeight(dependent) * Math.pow(decay, distance);
          next.push({ id: dependentId, distance });
        }

        frontier = next;
      }

      const inDegree = inDegreeByNode.get(node.id) ?? 0;
      const hubPenalty = Math.log(1 + inDegree);
      return {
        node: toTraceNode(node, "summary", 200),
        score: downstreamWeight / hubPenalty,
        components: {
          downstream_weight: downstreamWeight,
          hub_penalty: hubPenalty,
          in_degree: inDegree,
          decay,
        },
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => (b.score === a.score ? a.node.id.localeCompare(b.node.id) : b.score - a.score))
    .slice(0, limit);

  return { view: "frontier", items, hygiene_flags: hygieneFlags, next_cursor: null };
}

export function computeHygieneFlags(db: KnowledgeDB, scope?: Set<string>): HygieneFlag[] {
  const nodeById = new Map(db.getAllNodesRaw().map((node) => [node.id, node]));
  const activeNodes = allActiveNodes(db);
  const activeEdges = allActiveEdges(db);
  const rawEdges = db.getAllEdgesRaw().sort((a, b) => a.id - b.id);
  const flags: HygieneFlag[] = [];
  const seen = new Set<string>();

  const addFlag = (flag: HygieneFlag): void => {
    if (scope && !scope.has(flag.node) && (!flag.offending_ancestor || !scope.has(flag.offending_ancestor))) {
      return;
    }
    const key = `${flag.type}:${flag.node}:${flag.offending_ancestor ?? ""}:${flag.edge_id ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push(flag);
  };

  for (const node of activeNodes.filter((entry) => entry.status === "validated")) {
    for (const [ancestorId, ancestor] of ancestryIds(db, node.id)) {
      if (ancestor.status !== "validated") {
        addFlag({
          type: "validated_rests_on_unvalidated",
          node: node.id,
          offending_ancestor: ancestorId,
          ancestor_status: ancestor.status,
        });
      }
    }
  }

  for (const edge of activeEdges) {
    const from = nodeById.get(edge.from_id);
    const to = nodeById.get(edge.to_id);
    if (!from || !to) continue;
    if (edge.relation === "contradicts" && from.status === "validated" && to.status === "validated") {
      addFlag({ type: "validated_contradiction", node: from.id, offending_ancestor: to.id, edge_id: edge.id });
      addFlag({
        type: "trusted_contradicted_by_validated",
        node: to.id,
        offending_ancestor: from.id,
        edge_id: edge.id,
      });
    }
    if (edge.relation === "supersedes" && to.status !== "superseded") {
      addFlag({
        type: "supersedes_target_not_superseded",
        node: from.id,
        offending_ancestor: to.id,
        ancestor_status: to.status,
        edge_id: edge.id,
      });
    }
    if (edge.relation === "informed_by" && db.informedByReaches(edge.to_id, edge.from_id)) {
      addFlag({ type: "cycle_detected", node: edge.from_id, offending_ancestor: edge.to_id, edge_id: edge.id });
    }
  }

  for (const edge of rawEdges.filter((entry) => entry.removed_at !== null)) {
    if (edge.relation === "informed_by") {
      addFlag({ type: "broken_chain", node: edge.from_id, offending_ancestor: edge.to_id, edge_id: edge.id });
    } else if (edge.relation === "contradicts") {
      addFlag({ type: "broken_contradiction", node: edge.from_id, offending_ancestor: edge.to_id, edge_id: edge.id });
    } else if (edge.relation === "supersedes") {
      addFlag({ type: "broken_supersedes", node: edge.from_id, offending_ancestor: edge.to_id, edge_id: edge.id });
    }
  }

  return flags;
}

// ---- Tool handlers ----

export async function understand(
  db: KnowledgeDB,
  input: UnderstandInput
): Promise<UnderstandOutput> {
  const topK = input.top_k ?? 10;

  // Embed the query
  const queryEmbedding = await embed(input.query);

  // Get all active nodes with embeddings
  const candidates = db.getAllActiveNodesWithEmbeddings();

  if (candidates.length === 0) {
    return { matches: [] };
  }

  // Find top-K by cosine similarity
  const topMatches = findTopK(queryEmbedding, candidates, topK);

  // Build full context for each match
  const matches: NodeWithContext[] = [];
  for (const match of topMatches) {
    const node = db.getNode(match.id);
    if (!node) continue;
    matches.push(buildNodeWithContext(db, node, match.similarity));
  }

  return { matches };
}

export function getConcept(
  db: KnowledgeDB,
  input: GetConceptInput
): NodeWithContext {
  const node = db.getNode(input.id);
  if (!node) {
    throw new Error(`Concept "${input.id}" not found.`);
  }
  return buildNodeWithContext(db, node);
}

export async function createConcept(
  db: KnowledgeDB,
  input: CreateConceptInput
): Promise<{ id: string; message: string }> {
  const id = makeId(input.name, input.parent_id);

  // Check if node already exists
  if (db.nodeExists(id)) {
    throw new Error(`Concept "${id}" already exists. Use update_concept to modify it.`);
  }

  // Validate parent exists if specified
  if (input.parent_id && !db.nodeExists(input.parent_id)) {
    throw new Error(`Parent concept "${input.parent_id}" does not exist.`);
  }

  for (const edge of input.edges ?? []) {
    if (edge.relation === "informed_by") {
      validateInformedByEdge(db, id, edge.to, edge.description);
    }
  }

  // Generate embedding
  const text = embeddingText(input.name, input.kind, input.summary);
  const embedding = await embed(text);

  db.insertNodeAndEdges(
    {
      id,
      name: input.name,
      kind: input.kind,
      summary: input.summary,
      why: input.why ?? null,
      file_refs: input.file_refs ? JSON.stringify(input.file_refs) : null,
      parent_id: input.parent_id ?? null,
      created_by_task: input.created_by_task ?? null,
      embedding,
      status: input.status ?? (input.kind === "decision" ? "open" : null),
    },
    (input.edges ?? []).map((edge) => ({
      to_id: edge.to,
      relation: edge.relation,
      description: edge.description ?? null,
    }))
  );

  return { id, message: `Created concept "${id}"` };
}

export async function updateConcept(
  db: KnowledgeDB,
  input: UpdateConceptInput
): Promise<{ message: string }> {
  // Verify node exists
  const existing = db.getNode(input.id);
  if (!existing) {
    throw new Error(`Concept "${input.id}" not found.`);
  }

  if (
    input.changes.status !== undefined &&
    input.changes.status !== existing.status &&
    !input.changes.why?.trim()
  ) {
    throw new Error("Status changes require a non-empty why rationale.");
  }

  // If summary or name changed, regenerate embedding
  let embedding: Buffer | undefined;
  if (input.changes.summary !== undefined || input.changes.name !== undefined) {
    const name = input.changes.name ?? existing.name;
    const kind = input.changes.kind ?? existing.kind;
    const summary = input.changes.summary ?? existing.summary;
    const text = embeddingText(name, kind, summary);
    embedding = await embed(text);
  }

  const updated = db.updateNode(input.id, {
    ...input.changes,
    embedding,
  });

  if (!updated) {
    return { message: `No changes applied to "${input.id}"` };
  }

  return { message: `Updated concept "${input.id}"` };
}

export function link(
  db: KnowledgeDB,
  input: LinkInput
): { message: string } {
  // Validate both nodes exist
  if (!db.nodeExists(input.from)) {
    throw new Error(`Source concept "${input.from}" not found.`);
  }
  if (!db.nodeExists(input.to)) {
    throw new Error(`Target concept "${input.to}" not found.`);
  }

  if (input.relation === "informed_by") {
    validateInformedByEdge(db, input.from, input.to, input.description);
  }

  const { id: edgeId, inserted } = db.insertEdge({
    from_id: input.from,
    to_id: input.to,
    relation: input.relation,
    description: input.description,
  });

  if (!inserted) {
    return {
      message: `Relationship "${input.relation}" from "${input.from}" to "${input.to}" already exists.`,
    };
  }

  return {
    message: `Created ${input.relation} link from "${input.from}" to "${input.to}" (edge #${edgeId})`,
  };
}

export function removeConcept(
  db: KnowledgeDB,
  input: RemoveConceptInput
): { message: string } {
  const existing = db.getNodeIncludingRemoved(input.id);
  if (!existing) {
    throw new Error(`Concept "${input.id}" not found.`);
  }
  if (existing.removed_at) {
    throw new Error(`Concept "${input.id}" was already removed.`);
  }

  const protection = db.isEpistemicallyProtected(input.id);
  // §4.4: an explicit status or a `decision` kind makes a concept hard-epistemic —
  // it can NEVER be removed (status-flip only); treat_as_descriptive must not override
  // it. The escape only clears the *soft* provenance-participation guards (incoming
  // informed_by, legacy outgoing informed_by, contradicts/supersedes endpoints) on an
  // otherwise-descriptive (NULL-status, non-decision) concept.
  const HARD_REASONS = new Set(["status_set", "decision_kind"]);
  const hardReasons = protection.reasons.filter((r) => HARD_REASONS.has(r));
  const softReasons = protection.reasons.filter((r) => !HARD_REASONS.has(r));

  if (hardReasons.length > 0) {
    throw new Error(
      `Refusing to remove epistemic concept "${input.id}" (${hardReasons.join(
        ", "
      )}). Use update_concept to set status to abandoned, refuted, or superseded — treat_as_descriptive cannot override an epistemic record.`
    );
  }
  if (softReasons.length > 0 && !input.treat_as_descriptive) {
    throw new Error(
      `Refusing to remove "${input.id}" — other concepts depend on it via provenance (${softReasons.join(
        ", "
      )}). If it is genuinely descriptive and re-derivable, pass treat_as_descriptive=true; otherwise transition its status via update_concept.`
    );
  }

  const removed = db.softDeleteNode(input.id, input.reason);
  if (!removed) {
    throw new Error(`Failed to remove concept "${input.id}".`);
  }

  return {
    message: `Removed concept "${input.id}". Reason: ${input.reason}`,
  };
}

export function listRoots(db: KnowledgeDB): ListRootsOutput & { hint?: string } {
  const rootRows = db.getRootNodes();

  const roots = rootRows.map((root) => {
    const children = db.getChildren(root.id).map((c) => c.name);

    return {
      id: root.id,
      name: root.name,
      kind: root.kind as NodeWithContext["kind"],
      summary: root.summary,
      children,
    };
  });

  const stats = db.getStats();
  const hint =
    stats.nodes === 0
      ? "Graph is empty. Run /user:bootstrap-memory to populate, or create concepts as you work."
      : undefined;

  return { roots, ...(hint ? { hint } : {}) };
}

// ---- Merge conflict tools ----

export function listConflicts(db: KnowledgeDB): ListConflictsOutput {
  const conflictNodes = db.getConflictNodes();

  if (conflictNodes.length === 0) {
    return { conflicts: [] };
  }

  // Group by merge_group
  const groups = new Map<string, NodeRow[]>();
  for (const node of conflictNodes) {
    const mg = node.merge_group!;
    if (!groups.has(mg)) groups.set(mg, []);
    groups.get(mg)!.push(node);
  }

  const conflicts: ConflictGroup[] = [];

  for (const [mergeGroup, nodes] of groups) {
    const versions = nodes.map((n) => {
      const outgoingEdges = db.getOutgoingEdges(n.id);
      const fileRefs = n.file_refs ? JSON.parse(n.file_refs) : null;

      return {
        id: n.id,
        original_id: stripMergeSuffix(n.id),
        source_branch: n.source_branch ?? "unknown",
        name: n.name,
        kind: n.kind as NodeWithContext["kind"],
        summary: n.summary,
        why: n.why,
        file_refs: fileRefs,
        edges: outgoingEdges.map((e) => ({
          to: e.to_id,
          relation: e.relation as RelationType,
          description: e.description,
        })),
        removed_at: n.removed_at,
        removed_reason: n.removed_reason,
      };
    });

    conflicts.push({
      merge_group: mergeGroup,
      merge_timestamp: nodes[0].merge_timestamp,
      versions,
    });
  }

  return { conflicts };
}

export async function resolveConflict(
  db: KnowledgeDB,
  input: ResolveConflictInput
): Promise<{ message: string }> {
  const nodes = db.getNodesByMergeGroup(input.merge_group);

  if (nodes.length === 0) {
    throw new Error(`No nodes found with merge_group: ${input.merge_group}`);
  }

  // Prefer an active (non-removed) node as the base so the resolved concept
  // stays active for removal conflicts. Fall back to first node.
  const base = nodes.find((n) => n.removed_at === null) ?? nodes[0];
  const originalId = stripMergeSuffix(base.id);

  const text = embeddingText(base.name, base.kind, input.resolved.summary);
  const newEmbedding = await embed(text);

  const changes: { summary?: string; why?: string; file_refs?: string[] } = {
    summary: input.resolved.summary,
  };
  if (input.resolved.why !== undefined) changes.why = input.resolved.why;
  if (input.resolved.file_refs !== undefined) changes.file_refs = input.resolved.file_refs;

  db.runInTransaction(() => {
    // Delete all conflict copies except the base
    for (const node of nodes) {
      if (node.id !== base.id) {
        db.hardDeleteNode(node.id);
      }
    }

    // Rename the base back to the original clean ID
    if (base.id !== originalId) {
      const renamed = db.renameNodeId(base.id, originalId);
      if (!renamed) {
        throw new Error(`Failed to rename resolved node from ${base.id} to ${originalId}`);
      }
    }

    // Apply the resolved content
    const updated = db.updateNode(originalId, changes);
    if (!updated) {
      throw new Error(`Failed to apply resolved content to ${originalId}`);
    }

    db.updateNode(originalId, { embedding: newEmbedding });

    // Clear merge flags on the resolved node and any associated edges
    db.clearNodeMergeFlags(originalId);
    db.clearEdgeMergeFlagsByGroup(input.merge_group);
  });

  return {
    message: `Resolved "${originalId}". Reason: ${input.reason}`,
  };
}
