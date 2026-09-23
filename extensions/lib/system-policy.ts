/**
 * system-policy — the "systems get a Mermaid diagram" rule, shared by the
 * system-diagrams extension (prompt injection + semantic backstop) and tests.
 *
 * Pure module: no pi imports, erasable TypeScript only, so `node --test` can
 * exercise it directly. The long-form teaching version of this rule lives in
 * skills/teach/SKILL.md; this is the compact version injected into every run.
 */

/** The structural features that make something a system (numbered for the classifier). */
export const SYSTEM_FEATURES: readonly string[] = [
	"components, modules, stages, actors, or subsystems",
	"inputs and outputs",
	"flows of information, energy, signals, materials, control, or causality",
	"dependencies or relationships between components",
	"sequencing or ordered stages",
	"feedback loops",
	"hierarchy or containment",
	"interfaces or boundaries between parts",
	"state transitions or changes over time",
];

const featureList = SYSTEM_FEATURES.map((f, i) => `${i + 1}. ${f}`).join("\n");

/** Injected as a system-prompt section on every run (see system-diagrams.ts). */
export const SYSTEM_DIAGRAM_POLICY = `When you teach or explain anything, apply the teach skill AND this rule. It is part of the teaching method, not decoration.

SYSTEMS GET A MERMAID DIAGRAM BY DEFAULT.
A system is any concept made of multiple interacting parts whose relationships matter for understanding how the whole works. It has two or more of:
${featureList}
Judge the STRUCTURE of the concept, not its vocabulary: the word "system" is neither needed nor enough. Blood-glucose regulation is a system; "the metric system" (a set of unit definitions) is not.

Decision rule — classify every node you establish, and the lesson goal:
- clearly NOT a system (atomic, purely definitional, one relation with nothing to trace) → no diagram; never manufacture one.
- POSSIBLY a system (2 features, or the relationships are thin) → diagram strongly preferred: draw it.
- CLEARLY a system (2+ features and the relationships carry the understanding) → diagram expected: always draw it.
- COMPLEX or central system (many parts, or it is the lesson goal) → diagram required: a high-level overview first, then a zoom-in diagram for each subsystem whose inner parts matter.
When unsure, bias toward drawing. Never wait for the learner to ask, never ask whether he wants one, never drop a due diagram to keep the reply short.

Placement: in the Establish step of the node that introduces the system (or the part being added), before the details, then explain against it ("follow the arrow from X to Y"). Prose says WHY each edge exists; the diagram shows WHERE everything sits. When a later node adds parts to a system already drawn, redraw it with the addition. The Phase-2 dependency map is the lesson plan, not a concept diagram — it never replaces a system diagram.

Pick the Mermaid type that shows the structure: flowchart LR/TD for components, flows, pipelines, causal chains, dependencies and feedback loops (loops as labelled back-edges; hierarchy, containment and boundaries as subgraphs); sequenceDiagram for actors exchanging messages over time; stateDiagram-v2 for modes and the events that switch them; classDiagram or erDiagram for static structure and containment; timeline for stages in time. Show major components, direction of flow, inputs and outputs at the diagram's edges, dependencies, ordered steps (number them when order matters), interfaces, and feedback paths. Label edges with what flows (data, signal, energy, material, control) when it is not obvious. Never draw a list of terms hanging off one node, a restated sentence, or decorative boxes.

Syntax — Obsidian renders Mermaid 11.13, so the diagram must parse:
- A \`\`\`mermaid fenced block in your normal reply text (not inside a quiz or question).
- Line 1: the diagram type. Line 2: a tag comment — \`%% system: <system name> — overview\` or \`%% system: <system name> — zoom: <part>\`; the Phase-2 plan uses \`%% dependency-map\`.
- Short alphanumeric node ids (cpu, alu, ctrl2) with the words in quoted labels: alu["ALU (arithmetic)"]. Quote every label that has spaces or punctuation — unquoted ( ) [ ] { } " inside a label is the #1 parse error; so are empty labels, labels starting with / and labels containing @. Never use end, graph, subgraph, class, style or click as a node id.
- Flowchart arrows are --> , --- , -.-> , ==> with labels as -- text --> or -->|text| (never ->, →, or "A --> B: text"). sequenceDiagram messages need a colon (A->>B: text) and no ";". State ids have no hyphens. erDiagram relationships always carry a label. Comments go on their own line, never after code.
- Labels of at most ~5 words; <br/> for a line break; no LaTeX, no %%{init}%% theming, no click/links inside Mermaid.
- At most ~12 nodes per diagram; split into overview + zoom-ins instead of cramming.
- Correctness first: trace every arrow against your prose before sending. Every diagram is validated; if one fails you will be told — redraw it correctly.

QUESTIONS: every question you put to the learner (probe, Socratic step, quiz-check, goal or preference) goes through the quiz tool (it has a right answer) or ask_user_question (it does not). Never pose a question only in prose — the tools are what render questions as callouts in the learner's Obsidian note.

Before a quiz-check, a reviewer checks whether the explanation you just gave teaches a system without a diagram; if so the quiz is held back until you add it.`;

// ─── Semantic backstop (classifier) ─────────────────────────────────────────

export type SystemVerdict = "not" | "possibly" | "clearly" | "complex";

export interface SystemClassification {
	teaches: boolean;
	concept: string;
	features: number[];
	verdict: SystemVerdict;
	covered: boolean;
	reason: string;
}

export const CLASSIFIER_SYSTEM_PROMPT = `You audit a tutor's lesson text for one rule: concepts that are systems must be shown with a diagram.

A system is any concept made of multiple interacting parts whose relationships matter for understanding how the whole works. Structural features:
${featureList}

Verdicts:
- "not": atomic, purely definitional, a single fact/property/formula, or one relation with nothing to trace.
- "possibly": two features are present but the relationships are thin.
- "clearly": two or more features and the relationships between parts carry the understanding.
- "complex": many parts, several subsystems, or layered levels.
Judge the structure of what is being explained, not whether the word "system" appears.

"teaches" is true only if the text explains or establishes a concept. It is false when the text only asks questions, greets, plans the lesson, gives feedback on an answer without new content, or recaps in a sentence or two.
"covered" is true only if the text merely revisits a system listed as already diagrammed, without adding new parts or a new level of detail.

Reply with ONLY a JSON object, no prose, no code fence:
{"teaches": boolean, "concept": "short name", "features": [feature numbers present], "verdict": "not"|"possibly"|"clearly"|"complex", "covered": boolean, "reason": "at most 20 words"}`;

export function buildClassifierInput(text: string, alreadyDiagrammed: readonly string[]): string {
	const drawn = alreadyDiagrammed.length > 0 ? alreadyDiagrammed.map((d) => `- ${d}`).join("\n") : "(none)";
	return `Systems already diagrammed earlier in this lesson:\n${drawn}\n\nLesson text to audit:\n<<<\n${text}\n>>>`;
}

const VERDICTS = new Set<SystemVerdict>(["not", "possibly", "clearly", "complex"]);

/** Parse the classifier's reply. Returns null when it is not usable (callers then fail open). */
export function parseClassification(raw: string): SystemClassification | null {
	if (!raw) return null;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	let data: any;
	try {
		data = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	const verdict = String(data.verdict ?? "").trim().toLowerCase() as SystemVerdict;
	if (!VERDICTS.has(verdict)) return null;
	const features = Array.isArray(data.features)
		? Array.from(
				new Set(
					data.features
						.map((f: unknown) => Number.parseInt(String(f), 10))
						.filter((n: number) => Number.isInteger(n) && n >= 1 && n <= SYSTEM_FEATURES.length),
				),
			).sort((a, b) => (a as number) - (b as number)) as number[]
		: [];
	return {
		teaches: data.teaches === true || data.teaches === "true",
		concept: typeof data.concept === "string" && data.concept.trim() ? data.concept.trim().slice(0, 80) : "this concept",
		features,
		verdict,
		covered: data.covered === true || data.covered === "true",
		reason: typeof data.reason === "string" ? data.reason.trim().slice(0, 200) : "",
	};
}

/** The decision rule: possibly / clearly / complex all call for a diagram (bias toward drawing). */
export function needsDiagram(c: SystemClassification | null): boolean {
	if (!c || !c.teaches || c.covered) return false;
	return c.verdict === "possibly" || c.verdict === "clearly" || c.verdict === "complex";
}

// ─── Text helpers ────────────────────────────────────────────────────────────

const FENCE_RE = /(^|\n)[ \t]*(?:>[ \t]?)*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*(?:>[ \t]?)*\2[ \t]*(?=\n|$)/g;

/** Prose length with fenced code removed — short messages (probes, hand-offs) are not audited. */
export function proseLength(text: string): number {
	return text.replace(FENCE_RE, "\n").replace(/\s+/g, " ").trim().length;
}

export const MIN_PROSE_FOR_AUDIT = 350;

export function hasMermaidFence(text: string): boolean {
	return /(^|\n)[ \t]*(?:>[ \t]?)*(`{3,}|~{3,})[ \t]*mermaid\b/i.test(text);
}

function featureNames(c: SystemClassification): string {
	const names = c.features.map((n) => SYSTEM_FEATURES[n - 1]?.split(",")[0]).filter(Boolean);
	return names.length > 0 ? names.join("; ") : "interacting parts";
}

function levelHint(c: SystemClassification): string {
	return c.verdict === "complex"
		? `It is complex: start with a high-level overview (\`%% system: ${c.concept} — overview\`) and add a zoom-in diagram for the subsystem you are teaching now if its inner parts matter.`
		: `Tag it \`%% system: ${c.concept} — overview\` (or \`— zoom: <part>\` if it details one part of a system already drawn).`;
}

/** Tool-call block reason: the quiz waits until the diagram is in the lesson. */
export function missingDiagramBlockReason(c: SystemClassification): string {
	return [
		`Held back by the system-diagram rule — nothing is wrong with the question itself.`,
		`The explanation you just gave teaches "${c.concept}", which is ${c.verdict === "possibly" ? "possibly" : c.verdict === "complex" ? "a complex" : "clearly a"} system (${featureNames(c)}).`,
		`First add its Mermaid diagram to the lesson in a short message: one sentence telling the learner what to look at, then the \`\`\`mermaid block. ${levelHint(c)}`,
		`Then ask this same question again, unchanged.`,
	].join(" ");
}

/** Custom message at settle time when the run ends on an undiagrammed system explanation. */
export function missingDiagramFollowUp(c: SystemClassification): string {
	return [
		`[system-diagram rule] Your last explanation teaches "${c.concept}", which is ${c.verdict === "possibly" ? "possibly" : c.verdict === "complex" ? "a complex" : "clearly a"} system (${featureNames(c)}), but it has no diagram.`,
		`Add the Mermaid diagram now as a short follow-up: one sentence on what to notice, then the \`\`\`mermaid block. ${levelHint(c)}`,
		`Do not repeat the explanation and do not mention this reminder.`,
	].join(" ");
}

export interface InvalidDiagram {
	error: string;
	source: string;
}

/** Repair instructions when a diagram failed to parse under Mermaid 11.13. */
export function repairInstructions(invalid: readonly InvalidDiagram[], forQuiz: boolean): string {
	const details = invalid
		.map((d, i) => `Diagram ${i + 1} error: ${d.error.split("\n").slice(0, 4).join(" ").slice(0, 400)}`)
		.join("\n");
	return [
		`[system-diagram rule] ${invalid.length === 1 ? "A Mermaid diagram" : `${invalid.length} Mermaid diagrams`} in your last message failed to parse in Obsidian's Mermaid 11.13, so the learner cannot see ${invalid.length === 1 ? "it" : "them"}.`,
		details,
		`Re-send the corrected diagram${invalid.length === 1 ? "" : "s"} (same tag line) with one short lead-in sentence; keep node ids alphanumeric, quote every label with spaces or punctuation, and don't repeat the explanation or mention this message.`,
		forQuiz ? `Then ask this same question again, unchanged.` : ``,
	]
		.filter(Boolean)
		.join("\n");
}
