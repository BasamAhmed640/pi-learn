/**
 * system-diagrams — make "systems get a Mermaid diagram" a default part of the
 * teaching workflow instead of something the tutor has to remember.
 *
 * Three layers, cheapest first:
 *
 *   1. Policy. Every run gets the compact system-diagram rule as a structured
 *      system-prompt section (the full teaching version lives in the teach skill),
 *      so it holds even when the model doesn't re-read SKILL.md.
 *
 *   2. Syntax. Every ```mermaid block the tutor writes is parsed with the same
 *      Mermaid version Obsidian bundles (lib/mermaid.ts). A diagram that would
 *      render as an error box gets a bounded repair request.
 *
 *   3. Semantic backstop. When a substantial explanation without a diagram is
 *      about to be quiz-checked (or ends the run), a nested model call classifies
 *      it against the system definition — structure, not keywords. For
 *      possibly/clearly/complex systems the quiz is held back once with
 *      instructions to add the diagram first, so the note reads
 *      explanation → diagram → quiz. At settle, one continuation is requested.
 *
 * Everything is bounded (one nudge per message, 3 per run, 2 repairs per run)
 * and fails open: a classifier or validator problem never blocks teaching.
 * Set PI_LEARN_SYSTEM_DIAGRAMS=off to disable the whole extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeMermaid, extractMermaidBlocks, validateMermaid } from "./lib/mermaid.ts";
import {
	buildClassifierInput,
	CLASSIFIER_SYSTEM_PROMPT,
	hasMermaidFence,
	type InvalidDiagram,
	MIN_PROSE_FOR_AUDIT,
	missingDiagramBlockReason,
	missingDiagramFollowUp,
	needsDiagram,
	parseClassification,
	proseLength,
	repairInstructions,
	SYSTEM_DIAGRAM_POLICY,
	type SystemClassification,
} from "./lib/system-policy.ts";

const GATED_TOOLS = new Set(["quiz", "ask_user_question"]);
const MAX_NUDGES_PER_RUN = 3;
const MAX_REPAIRS_PER_RUN = 2;
const CLASSIFIER_TIMEOUT_MS = 30_000;
const PROMPT_SECTION = "system_diagrams";

interface MessageRecord {
	text: string;
	toolCallIds: string[];
	validation: Promise<InvalidDiagram[]>;
	classification?: Promise<SystemClassification | null>;
	/** Set once this message has been held back; every gated call from it gets the same reason. */
	blockReason?: string;
	nudged: boolean;
	repaired: boolean;
}

export interface SystemDiagramAuditEvent {
	at: string;
	action: "blocked-missing" | "blocked-invalid" | "followup-missing" | "followup-invalid" | "pass" | "classifier-unavailable";
	tool?: string;
	classification?: SystemClassification | null;
	invalid?: InvalidDiagram[];
	error?: string;
}

function assistantText(message: any): string {
	return (message?.content || [])
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => (c.text as string).trim())
		.filter((t: string) => t.length > 0)
		.join("\n\n");
}

function toolCallIds(message: any): string[] {
	return (message?.content || []).filter((c: any) => c?.type === "toolCall" && c.id).map((c: any) => String(c.id));
}

/** Labels of system diagrams in a piece of assistant text (`%% system: …` tags). */
function systemDiagramLabels(text: string): string[] {
	const labels: string[] = [];
	for (const block of extractMermaidBlocks(text)) {
		const tag: any = describeMermaid(block.source).tag;
		if (tag?.kind !== "system") continue;
		const level = tag.level === "zoom" ? ` (zoom${tag.subsystem ? `: ${tag.subsystem}` : ""})` : tag.level ? ` (${tag.level})` : "";
		labels.push(`${tag.label || "(untitled system)"}${level}`);
	}
	return labels;
}

async function invalidDiagrams(text: string): Promise<InvalidDiagram[]> {
	const blocks = extractMermaidBlocks(text);
	if (blocks.length === 0) return [];
	const results = await Promise.all(blocks.map((b) => validateMermaid(b.source)));
	const invalid: InvalidDiagram[] = [];
	results.forEach((r, i) => {
		if (r.status === "invalid") invalid.push({ error: r.error, source: blocks[i].source });
	});
	return invalid;
}

export default function systemDiagrams(pi: ExtensionAPI) {
	if ((process.env.PI_LEARN_SYSTEM_DIAGRAMS || "").toLowerCase() === "off") return;

	const records = new Map<string, MessageRecord>(); // toolCallId → record
	let lastRecord: MessageRecord | null = null;
	let drawn: string[] = [];
	let nudgesThisRun = 0;
	let repairsThisRun = 0;
	let audit: SystemDiagramAuditEvent[] = [];

	const g = globalThis as any;
	g.__piLearnSystemAudit = g.__piLearnSystemAudit || [];

	function record(event: Omit<SystemDiagramAuditEvent, "at">): void {
		const entry = { at: new Date().toISOString(), ...event };
		audit.push(entry);
		g.__piLearnSystemAudit.push(entry);
	}

	function rebuildDrawn(ctx: any): void {
		drawn = [];
		try {
			for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
				if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
				for (const label of systemDiagramLabels(assistantText(entry.message))) {
					if (!drawn.includes(label)) drawn.push(label);
				}
			}
		} catch {
			// A missing or unusual session manager just means no history to seed from.
		}
	}

	let lastClassifierError = "";

	async function classify(ctx: any, text: string): Promise<SystemClassification | null> {
		try {
			if (!ctx?.model || typeof ctx?.modelRegistry?.streamSimple !== "function") {
				lastClassifierError = "no active model";
				return null;
			}
			const signal = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
			// Some providers (e.g. opencode-go) reject requests that carry no session id,
			// so nested calls must reuse the session's id just like the main agent loop.
			const sessionId = ctx.sessionManager?.getSessionId?.();
			const stream = ctx.modelRegistry.streamSimple(
				ctx.model,
				{
					systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
					messages: [{ role: "user", content: buildClassifierInput(text.slice(0, 12_000), drawn), timestamp: Date.now() }],
				},
				{ reasoning: "minimal", signal, ...(sessionId ? { sessionId } : {}) },
			);
			const message = await stream.result();
			if (!message || message.stopReason === "error" || message.stopReason === "aborted") {
				lastClassifierError = String(message?.errorMessage || message?.stopReason || "no response").slice(0, 300);
				return null;
			}
			const parsed = parseClassification(assistantText(message));
			if (!parsed) lastClassifierError = "unparseable reply";
			return parsed;
		} catch (error) {
			lastClassifierError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
			return null;
		}
	}

	/** Decide whether the message a gated call belongs to must be held back. */
	async function review(ctx: any, rec: MessageRecord, forQuiz: boolean): Promise<{ reason: string; kind: "invalid" | "missing"; c?: SystemClassification } | null> {
		const invalid = await rec.validation;
		if (invalid.length > 0 && !rec.repaired && repairsThisRun < MAX_REPAIRS_PER_RUN) {
			rec.repaired = true;
			repairsThisRun++;
			record({ action: forQuiz ? "blocked-invalid" : "followup-invalid", invalid });
			return { reason: repairInstructions(invalid, forQuiz), kind: "invalid" };
		}
		if (rec.nudged || nudgesThisRun >= MAX_NUDGES_PER_RUN) return null;
		if (hasMermaidFence(rec.text) || proseLength(rec.text) < MIN_PROSE_FOR_AUDIT) return null;

		rec.classification ??= classify(ctx, rec.text);
		const c = await rec.classification;
		if (c === null) {
			record({ action: "classifier-unavailable", error: lastClassifierError });
			return null;
		}
		if (!needsDiagram(c)) {
			record({ action: "pass", classification: c });
			return null;
		}
		rec.nudged = true;
		nudgesThisRun++;
		record({ action: forQuiz ? "blocked-missing" : "followup-missing", classification: c });
		return { reason: forQuiz ? missingDiagramBlockReason(c) : missingDiagramFollowUp(c), kind: "missing", c };
	}

	function findRecord(ctx: any, toolCallId: string): MessageRecord | null {
		const known = records.get(toolCallId);
		if (known) return known;
		// Fallback: rebuild from the persisted assistant message that owns this call.
		try {
			const branch: any[] = ctx.sessionManager?.getBranch?.() ?? [];
			for (let i = branch.length - 1; i >= 0; i--) {
				const msg = branch[i]?.type === "message" ? branch[i].message : null;
				if (msg?.role !== "assistant" || !toolCallIds(msg).includes(toolCallId)) continue;
				return track(msg);
			}
		} catch {
			// fall through
		}
		return lastRecord;
	}

	function track(message: any): MessageRecord {
		const text = assistantText(message);
		const rec: MessageRecord = {
			text,
			toolCallIds: toolCallIds(message),
			validation: invalidDiagrams(text).catch(() => []),
			nudged: false,
			repaired: false,
		};
		for (const id of rec.toolCallIds) records.set(id, rec);
		for (const label of systemDiagramLabels(text)) if (!drawn.includes(label)) drawn.push(label);
		lastRecord = rec;
		return rec;
	}

	pi.on("session_start", async (_event, ctx) => {
		records.clear();
		lastRecord = null;
		rebuildDrawn(ctx);
		// Warm the Mermaid worker so the first real diagram doesn't pay the cold start.
		void validateMermaid("flowchart LR\n  a --> b").catch(() => undefined);
	});

	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.sections[PROMPT_SECTION] = SYSTEM_DIAGRAM_POLICY;
	});

	pi.on("agent_start", async () => {
		nudgesThisRun = 0;
		repairsThisRun = 0;
		audit = [];
	});

	pi.on("message_end", async (event) => {
		const message: any = event.message;
		if (message?.role !== "assistant") return;
		// Validation starts now; the gate awaits it, so a quiz never outruns it.
		track(message);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!GATED_TOOLS.has(event.toolName)) return;
		const rec = findRecord(ctx, event.toolCallId);
		if (!rec) return;
		if (rec.blockReason) return { block: true, reason: rec.blockReason };
		const verdict = await review(ctx, rec, true);
		if (!verdict) return;
		rec.blockReason = verdict.reason;
		return { block: true, reason: verdict.reason };
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed" || !lastRecord) return;
		// Only the run's closing message: gated calls were reviewed when they were made.
		if (lastRecord.toolCallIds.length > 0) return;
		const verdict = await review(ctx, lastRecord, false);
		if (!verdict) return;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: "system-diagram-check",
					content: verdict.reason,
					display: false,
					details: { kind: verdict.kind, classification: verdict.c ?? null },
				},
			],
			continue: true,
		};
	});

	pi.on("agent_settled", async () => {
		if (audit.length === 0) return;
		try {
			pi.appendEntry("system-diagram-check", { events: audit });
		} catch {
			// Audit is best-effort.
		}
		audit = [];
	});
}
