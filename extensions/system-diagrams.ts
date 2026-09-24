/**
 * system-diagrams — make "systems get a Mermaid diagram" a default part of the
 * teaching workflow instead of something the tutor has to remember.
 *
 * Four layers, cheapest first:
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
 *   4. Diagram quality. Disconnected one-edge mapping pictures are rejected
 *      structurally. Other new concept diagrams receive one batched, cached
 *      model review for definite causal errors before the next question.
 *
 * Everything is bounded (one nudge per message, 3 missing-diagram nudges,
 * 2 syntax repairs, 8 quality reviews and 2 quality repairs per run)
 * and fails open: a classifier or validator problem never blocks teaching.
 * Set PI_LEARN_SYSTEM_DIAGRAMS=off to disable the whole extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { describeMermaid, extractMermaidBlocks, validateMermaid } from "./lib/mermaid.ts";
import { findMermaidFences } from "./lib/learn-notes.ts";
import { linkedNoteFromEntries } from "./lib/learn-link-state.ts";
import {
	buildQualityReviewInput,
	diagramHash,
	disconnectedMapping,
	mappingIssue,
	parseQualityReview,
	QUALITY_REVIEW_SYSTEM_PROMPT,
	type ConceptBlock,
	type QualityResult,
} from "./lib/diagram-quality.ts";
import {
	buildClassifierInput,
	CLASSIFIER_SYSTEM_PROMPT,
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
const MAX_QUALITY_REVIEWS_PER_RUN = 8;
const MAX_QUALITY_REPAIRS_PER_RUN = 2;
const CLASSIFIER_TIMEOUT_MS = 30_000;
const PROMPT_SECTION = "system_diagrams";

interface MessageRecord {
	text: string;
	toolCallIds: string[];
	validation: Promise<InvalidDiagram[]>;
	quality: Promise<QualityResult>;
	classification?: Promise<SystemClassification | null>;
	gateDecision?: Promise<{ reason: string } | null>;
	/** Set once this message has been held back; every gated call from it gets the same reason. */
	blockReason?: string;
	nudged: boolean;
	repaired: boolean;
	qualityNudged: boolean;
}

export interface SystemDiagramAuditEvent {
	at: string;
	action: "blocked-missing" | "blocked-invalid" | "blocked-quality" | "followup-missing" | "followup-invalid" | "followup-quality" | "pass" | "classifier-unavailable" | "quality-pass" | "quality-unavailable";
	tool?: string;
	classification?: SystemClassification | null;
	invalid?: InvalidDiagram[];
	error?: string;
	quality?: QualityResult;
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
	const pendingDiagrams = new Set<MessageRecord>();
	let drawn: string[] = [];
	let nudgesThisRun = 0;
	let repairsThisRun = 0;
	let qualityReviewsThisRun = 0;
	let qualityRepairsThisRun = 0;
	let audit: SystemDiagramAuditEvent[] = [];
	const sourceReview = new Map<string, QualityResult>();
	const persistQuality = new Map<string, "pass" | "repair">();
	const persistedStatus = new Map<string, "pass" | "repair">();

	const g = globalThis as any;
	g.__piLearnSystemAudit = g.__piLearnSystemAudit || [];
	// The Obsidian link reads these promises before writing assistant text to the note.
	// The registry is reset for each session and keyed by exact assistant text/source.
	let shared: {
		sessionId: string;
		byText: Map<string, Promise<QualityResult>>;
		bySource: Map<string, "pass" | "repair" | "unavailable">;
	} = { sessionId: "", byText: new Map(), bySource: new Map() };
	g.__piLearnDiagramQuality = shared;

	function record(event: Omit<SystemDiagramAuditEvent, "at">): void {
		const entry = { at: new Date().toISOString(), ...event };
		audit.push(entry);
		g.__piLearnSystemAudit.push(entry);
	}

	function sessionIdOf(ctx: any): string {
		return String(ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getHeader?.()?.id ?? "unknown-session");
	}

	function linkedNote(ctx: any): string | null {
		return linkedNoteFromEntries(ctx.sessionManager?.getEntries?.() ?? []);
	}

	function rebuildDrawn(ctx: any): void {
		drawn = [];
		try {
			const note = linkedNote(ctx);
			if (note && existsSync(note)) {
				for (const fence of findMermaidFences(readFileSync(note, "utf8"))) {
					if (fence.hidden) continue;
					const tag: any = describeMermaid(fence.source).tag;
					if (tag?.kind !== "system") continue;
					const level = tag.level === "zoom" ? ` (zoom${tag.subsystem ? `: ${tag.subsystem}` : ""})` : tag.level ? ` (${tag.level})` : "";
					const label = `${tag.label || "(untitled system)"}${level}`;
					if (!drawn.includes(label)) drawn.push(label);
				}
				return;
			}
			const latest = new Map<string, "pass" | "repair">();
			for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
				if (entry?.type !== "custom" || entry.customType !== "diagram-quality") continue;
				if (typeof entry.data?.hash === "string" && (entry.data.status === "pass" || entry.data.status === "repair")) {
					latest.set(entry.data.hash, entry.data.status);
				}
			}
			for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
				if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
				for (const block of extractMermaidBlocks(assistantText(entry.message))) {
					const hash = diagramHash(block.source);
					if (latest.get(hash) === "repair" || (latest.size > 0 && latest.get(hash) !== "pass")) continue;
					for (const label of systemDiagramLabels(`\x60\x60\x60mermaid\n${block.source}\n\x60\x60\x60`)) {
						if (!drawn.includes(label)) drawn.push(label);
					}
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

	function conceptBlocks(text: string): ConceptBlock[] {
		return extractMermaidBlocks(text).flatMap((block) => {
			const tag: any = describeMermaid(block.source).tag;
			// The dependency map is a lesson plan. Every other Mermaid block is a
			// concept diagram, including an untagged one the tutor forgot to label.
			return tag?.kind === "dependency-map" ? [] : [{ source: block.source, label: String(tag?.label || "untagged concept diagram") }];
		});
	}

	function priorLessonText(ctx: any): string {
		try {
			return (ctx.sessionManager?.getBranch?.() ?? [])
				.filter((entry: any) => entry?.type === "message" && entry.message?.role === "assistant")
				.slice(-2)
				.map((entry: any) => assistantText(entry.message))
				.join("\n\n")
				.slice(-3500);
		} catch { return ""; }
	}

	async function modelQualityReview(ctx: any, text: string, blocks: ConceptBlock[]): Promise<QualityResult> {
		if (qualityReviewsThisRun >= MAX_QUALITY_REVIEWS_PER_RUN) return { status: "unavailable", issues: [], reason: "quality review budget exhausted" };
		if (!ctx?.model || typeof ctx?.modelRegistry?.streamSimple !== "function") return { status: "unavailable", issues: [], reason: "model reviewer unavailable" };
		qualityReviewsThisRun++;
		try {
			const sessionId = ctx.sessionManager?.getSessionId?.();
			const stream = ctx.modelRegistry.streamSimple(
				ctx.model,
				{
					systemPrompt: QUALITY_REVIEW_SYSTEM_PROMPT,
					messages: [{ role: "user", content: buildQualityReviewInput(text, blocks, priorLessonText(ctx)), timestamp: Date.now() }],
				},
				{ reasoning: "minimal", signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS), ...(sessionId ? { sessionId } : {}) },
			);
			const message = await stream.result();
			if (!message || message.stopReason === "error" || message.stopReason === "aborted") return { status: "unavailable", issues: [], reason: "model reviewer failed" };
			return parseQualityReview(assistantText(message), blocks);
		} catch {
			return { status: "unavailable", issues: [], reason: "model reviewer failed" };
		}
	}

	async function evaluateQuality(ctx: any, text: string, blocks: ConceptBlock[]): Promise<QualityResult> {
		if (blocks.length === 0) return { status: "pass", issues: [] };
		const newBlocks: ConceptBlock[] = [];
		for (const [i, block] of blocks.entries()) {
			if (sourceReview.has(block.source)) continue;
			if (disconnectedMapping(block.source)) sourceReview.set(block.source, { status: "repair", issues: [mappingIssue(block, i + 1)] });
			else newBlocks.push(block);
		}
		if (newBlocks.length > 0) {
			const review = await modelQualityReview(ctx, text, newBlocks);
			for (const block of newBlocks) {
				const issues = review.issues.filter((issue) => issue.source === block.source);
				sourceReview.set(block.source, { status: review.status === "unavailable" ? "unavailable" : issues.length ? "repair" : "pass", issues, reason: review.reason });
			}
		}
		const issues = blocks.flatMap((block, i) => (sourceReview.get(block.source)?.issues ?? []).map((issue) => ({ ...issue, index: i + 1 })));
		const unavailable = blocks.some((block) => sourceReview.get(block.source)?.status === "unavailable");
		for (const block of blocks) {
			const status = sourceReview.get(block.source)?.status;
			if (!status) continue;
			shared.bySource.set(diagramHash(block.source), status);
			if (status === "pass" || status === "repair") persistQuality.set(diagramHash(block.source), status);
		}
		const result: QualityResult = { status: issues.length ? "repair" : unavailable ? "unavailable" : "pass", issues, reason: unavailable ? "one or more diagrams could not be reviewed" : undefined };
		if (result.status === "pass") record({ action: "quality-pass", quality: result });
		else if (result.status === "unavailable") record({ action: "quality-unavailable", quality: result });
		return result;
	}

	function qualityRepairReason(result: QualityResult, forQuiz: boolean): string {
		const details = result.issues.map((issue) => `Diagram ${issue.index}: ${issue.problem} Line: ${issue.line} Fix: ${issue.fix}`).join("\n");
		return `[system-diagram quality check] A concept diagram needs a correction before the learner is quizzed.\n${details}\nSend a corrected diagram with the proper %% system: tag and a short explanation of the corrected flow. Do not repeat the full lesson.${forQuiz ? " Then ask the same question again, unchanged." : ""}`;
	}

	/** Decide whether any diagram since the last quiz must be redrawn first. */
	async function reviewPendingDiagrams(forQuiz: boolean): Promise<{ reason: string; kind: "invalid" | "quality" } | null> {
		for (const candidate of [...pendingDiagrams]) {
			const invalid = await candidate.validation;
			if (invalid.length > 0 && !candidate.repaired && repairsThisRun < MAX_REPAIRS_PER_RUN) {
				candidate.repaired = true;
				repairsThisRun++;
				pendingDiagrams.delete(candidate);
				record({ action: forQuiz ? "blocked-invalid" : "followup-invalid", invalid });
				return { reason: repairInstructions(invalid, forQuiz), kind: "invalid" };
			}
			const quality = await candidate.quality;
			if (quality.status === "repair" && !candidate.qualityNudged && qualityRepairsThisRun < MAX_QUALITY_REPAIRS_PER_RUN) {
				candidate.qualityNudged = true;
				qualityRepairsThisRun++;
				pendingDiagrams.delete(candidate);
				record({ action: forQuiz ? "blocked-quality" : "followup-quality", quality });
				return { reason: qualityRepairReason(quality, forQuiz), kind: "quality" };
			}
			pendingDiagrams.delete(candidate);
		}
		return null;
	}

	/** Decide whether the message a gated call belongs to must be held back. */
	async function review(ctx: any, rec: MessageRecord, forQuiz: boolean): Promise<{ reason: string; kind: "invalid" | "missing" | "quality"; c?: SystemClassification } | null> {
		const diagramVerdict = await reviewPendingDiagrams(forQuiz);
		if (diagramVerdict) return diagramVerdict;
		if (rec.nudged || nudgesThisRun >= MAX_NUDGES_PER_RUN) return null;
		if (conceptBlocks(rec.text).length > 0 || proseLength(rec.text) < MIN_PROSE_FOR_AUDIT) return null;

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
				return track(msg, ctx);
			}
		} catch {
			// fall through
		}
		return lastRecord;
	}

	function track(message: any, ctx: any): MessageRecord {
		const text = assistantText(message);
		const blocks = conceptBlocks(text);
		const newLabels = new Set(systemDiagramLabels(text));
		if (newLabels.size > 0) {
			// A redraw with the same tag supersedes a still-pending bad draft even
			// when the tutor corrected it before attempting the quiz.
			for (const older of pendingDiagrams) {
				if (systemDiagramLabels(older.text).some((label) => newLabels.has(label))) pendingDiagrams.delete(older);
			}
		}
		const validation = invalidDiagrams(text).catch(() => []);
		const quality = validation.then((invalid) => evaluateQuality(ctx, text, blocks.filter((block) => !invalid.some((bad) => bad.source === block.source))));
		const rec: MessageRecord = {
			text,
			toolCallIds: toolCallIds(message),
			validation,
			quality,
			nudged: false,
			repaired: false,
			qualityNudged: false,
		};
		for (const id of rec.toolCallIds) records.set(id, rec);
		if (extractMermaidBlocks(text).length > 0) pendingDiagrams.add(rec);
		shared.byText.set(text, quality);
		void Promise.all([validation, quality]).then(([invalid]) => {
			for (const block of blocks) {
				if (invalid.some((bad) => bad.source === block.source) || sourceReview.get(block.source)?.status === "repair") continue;
				for (const label of systemDiagramLabels(`\x60\x60\x60mermaid\n${block.source}\n\x60\x60\x60`)) if (!drawn.includes(label)) drawn.push(label);
			}
		}).catch(() => undefined);
		lastRecord = rec;
		return rec;
	}

	pi.on("session_start", async (_event, ctx) => {
		records.clear();
		lastRecord = null;
		pendingDiagrams.clear();
		sourceReview.clear();
		persistQuality.clear();
		persistedStatus.clear();
		for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
			if (entry?.type === "custom" && entry.customType === "diagram-quality" && typeof entry.data?.hash === "string" && (entry.data.status === "pass" || entry.data.status === "repair")) {
				persistedStatus.set(entry.data.hash, entry.data.status);
			}
		}
		shared = { sessionId: sessionIdOf(ctx), byText: new Map(), bySource: new Map() };
		g.__piLearnDiagramQuality = shared;
		rebuildDrawn(ctx);
		// Warm the Mermaid worker so the first real diagram doesn't pay the cold start.
		void validateMermaid("flowchart LR\n  a --> b").catch(() => undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// /learn and /learn-resume can link a note after session_start. The note is
		// the resume source of truth: rejected diagrams are hidden there.
		if (linkedNote(ctx)) rebuildDrawn(ctx);
		event.systemPromptOptions.sections[PROMPT_SECTION] = SYSTEM_DIAGRAM_POLICY;
	});

	pi.on("agent_start", async () => {
		nudgesThisRun = 0;
		repairsThisRun = 0;
		qualityReviewsThisRun = 0;
		qualityRepairsThisRun = 0;
		for (const [source, result] of sourceReview) {
			if (result.status === "unavailable") {
				sourceReview.delete(source);
				shared.bySource.delete(diagramHash(source));
			}
		}
		audit = [];
	});

	pi.on("message_end", async (event, ctx) => {
		const message: any = event.message;
		if (message?.role !== "assistant") return;
		// Validation starts now; the gate awaits it, so a quiz never outruns it.
		track(message, ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!GATED_TOOLS.has(event.toolName)) return;
		const rec = findRecord(ctx, event.toolCallId);
		if (!rec) return;
		if (rec.blockReason) return { block: true, reason: rec.blockReason };
		// Pi may dispatch sibling tool calls together. Share the pending decision so
		// none can slip past while the first call awaits validation or model review.
		const verdict = await (rec.gateDecision ??= review(ctx, rec, true));
		if (!verdict) return;
		rec.blockReason = verdict.reason;
		return { block: true, reason: verdict.reason };
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed" || !lastRecord) return;
		const diagramVerdict = await reviewPendingDiagrams(false);
		if (diagramVerdict) {
			return {
				entries: [...event.entries, { type: "custom_message", customType: "system-diagram-check", content: diagramVerdict.reason, display: false, details: { kind: diagramVerdict.kind } }],
				continue: true,
			};
		}
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
		await Promise.all([...pendingDiagrams].map((rec) => rec.quality.catch(() => ({ status: "unavailable", issues: [] }))));
		for (const [hash, status] of persistQuality) {
			if (persistedStatus.get(hash) === status) continue;
			try {
				pi.appendEntry("diagram-quality", { hash, status });
				persistedStatus.set(hash, status);
			} catch { /* audit is best effort */ }
		}
		if (audit.length === 0) return;
		try {
			pi.appendEntry("system-diagram-check", { events: audit });
		} catch {
			// Audit is best-effort.
		}
		audit = [];
	});
}
