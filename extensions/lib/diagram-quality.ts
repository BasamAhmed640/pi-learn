// Cheap topology checks plus a tightly scoped model-review protocol for concept diagrams.
// Syntax is checked separately by mermaid.ts. These checks look at what a valid picture says.

import { createHash } from "node:crypto";

export interface QualityIssue {
	index: number; // 1-based index among the concept diagrams in one assistant message
	source: string;
	line: string;
	kind: "disconnected-mapping" | "causal" | "missing-flow" | "misleading-loop";
	problem: string;
	fix: string;
}

export interface QualityResult {
	status: "pass" | "repair" | "unavailable";
	issues: QualityIssue[];
	reason?: string;
}

export interface ConceptBlock {
	source: string;
	label: string;
}

export function diagramHash(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

/**
 * A flowchart made entirely of disconnected one-edge pairs is a lookup table in boxes.
 * Be deliberately conservative: if any edge syntax is not understood, leave it to the model.
 */
export function disconnectedMapping(source: string): boolean {
	if (!/^\s*(?:flowchart|graph)\s+(?:LR|RL|TD|TB|BT)\b/i.test(source)) return false;
	const edges: Array<[string, string]> = [];
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("%%")) continue;
		const arrows = [...line.matchAll(/-\.->|==>|-->|---/g)];
		if (arrows.length === 0) continue;
		if (arrows.length !== 1 || /\s&\s/.test(line)) return false;
		const arrow = arrows[0];
		const left = line.slice(0, arrow.index);
		const right = line.slice((arrow.index ?? 0) + arrow[0].length).replace(/^\s*\|[^|]*\|/, "");
		const from = /^([A-Za-z_][\w]*)\b/.exec(left)?.[1];
		const to = /^\s*([A-Za-z_][\w]*)\b/.exec(right)?.[1];
		if (!from || !to) return false;
		edges.push([from, to]);
	}
	if (edges.length < 2) return false;
	const parent = new Map<string, string>();
	const root = (id: string): string => {
		const p = parent.get(id);
		if (!p) { parent.set(id, id); return id; }
		if (p === id) return id;
		const r = root(p);
		parent.set(id, r);
		return r;
	};
	for (const [a, b] of edges) parent.set(root(a), root(b));
	const groups = new Map<string, { nodes: Set<string>; edges: number }>();
	for (const [a, b] of edges) {
		const key = root(a);
		const group = groups.get(key) ?? { nodes: new Set<string>(), edges: 0 };
		group.nodes.add(a); group.nodes.add(b); group.edges++;
		groups.set(key, group);
	}
	return groups.size >= 2 && [...groups.values()].every((g) => g.nodes.size <= 2 && g.edges === 1);
}

export function mappingIssue(block: ConceptBlock, index: number): QualityIssue {
	const line = block.source.split(/\r?\n/).find((l) => /-\.->|==>|-->|---/.test(l))?.trim() ?? "";
	return {
		index,
		source: block.source,
		line,
		kind: "disconnected-mapping",
		problem: "The diagram consists of independent one-step mappings; it does not show how parts interact or a process flows.",
		fix: "Use a table for independent cases, or redraw the actual connected mechanism with its inputs and outputs.",
	};
}

export const QUALITY_REVIEW_SYSTEM_PROMPT = `You audit Mermaid concept diagrams before a learner sees a quiz. Check the causal mechanism independently, not just whether the prose agrees: the prose can also be wrong. Trace arrow directions, omitted interactions, and feedback. A diagram must show an actual connected mechanism, not decorative boxes or separate term-to-definition pairs.

Flag only material, high-confidence mistakes. A harmless simplification, a debatable detail, or a diagram style preference is not an error. For each mistake, cite one EXACT line from the Mermaid source, explain the concrete causal problem, and say how to fix it. If you cannot identify an exact line and a definite problem, return no issue.

Reply with only JSON: {"issues":[{"index":1,"line":"exact Mermaid source line","kind":"causal|missing-flow|misleading-loop","problem":"concrete mechanism error","fix":"specific correction","confidence":"high"}]}. Use {"issues":[]} when the diagrams are sound.`;

export function buildQualityReviewInput(text: string, blocks: readonly ConceptBlock[], prior: string): string {
	return `Previous lesson context:\n<<<\n${prior.slice(-3500)}\n>>>\n\nCurrent explanation:\n<<<\n${text.slice(0, 9000)}\n>>>\n\nConcept diagrams to review:\n${blocks.map((b, i) => `Diagram ${i + 1} (${b.label}):\n\x60\x60\x60mermaid\n${b.source}\n\x60\x60\x60`).join("\n\n")}`;
}

/** Accept only concrete, exact-line, high-confidence findings. Malformed replies fail open. */
export function parseQualityReview(raw: string, blocks: readonly ConceptBlock[]): QualityResult {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return { status: "unavailable", issues: [], reason: "reviewer returned no JSON" };
	let data: any;
	try { data = JSON.parse(raw.slice(start, end + 1)); }
	catch { return { status: "unavailable", issues: [], reason: "reviewer returned invalid JSON" }; }
	if (!data || !Array.isArray(data.issues)) return { status: "unavailable", issues: [], reason: "reviewer returned no issues array" };
	const kinds = new Set(["causal", "missing-flow", "misleading-loop"]);
	const issues: QualityIssue[] = [];
	for (const item of data.issues) {
		const index = Number(item?.index);
		const block = blocks[index - 1];
		const line = String(item?.line ?? "").trim();
		const problem = String(item?.problem ?? "").trim();
		const fix = String(item?.fix ?? "").trim();
		if (!block || item?.confidence !== "high" || !kinds.has(item?.kind) || problem.length < 18 || fix.length < 8) continue;
		if (!line || !block.source.split(/\r?\n/).some((l) => l.trim() === line)) continue;
		issues.push({ index, source: block.source, line, kind: item.kind, problem: problem.slice(0, 300), fix: fix.slice(0, 300) });
	}
	return { status: issues.length ? "repair" : "pass", issues };
}
