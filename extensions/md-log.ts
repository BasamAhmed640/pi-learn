/**
 * md-log — mirror the session to a markdown file for comfortable reading.
 *
 * Designed for long teaching/learning sessions where the terminal is hard on
 * the eyes and markdown/math/code don't render. The linked .md file is meant
 * to be viewed rendered (e.g. in Obsidian), so assistant text with $...$ math,
 * code blocks, and markdown all render natively — no rendering work here.
 *
 * Captures only reading-relevant content:
 *   - user prompts
 *   - assistant text (lesson prose)
 *   - quiz / ask_user_question Q&A blocks
 * Other tools (bash, read, write, edit, ...) are omitted.
 *
 * Quiz/ask questions are written BEFORE the user answers (on tool_call), so the
 * reader sees the question appear live; the answer + feedback are appended on
 * tool_result. The question block NEVER contains the correct answer or
 * explanation (the user reads this file live).
 *
 * pi-learn additions (docs/CONTRACTS.md §2):
 *   - Each pi session writes into its own `## Session N (date)` section, marked
 *     with `%% learn-session: <id> %%`. Linking never destroys content: a re-link
 *     regenerates only this session's section; otherwise a new section is appended.
 *   - pi-learn frontmatter (learn-topic/status/created/updated/sessions).
 *   - Mermaid blocks that fail syntax or quality checks are hidden in the note
 *     (source kept in a %% comment).
 *   - `Learn Index.md` in the notes dir lists every learning note.
 *
 * Commands:
 *   /md-log <filepath>    — Link an existing markdown file and backfill the session.
 *   /md-unlog             — Stop logging.
 *   /learn <topic>        — Create a learning note, link it and start teaching.
 *   /learn-resume [note]  — Continue a learning note (latest one by default).
 *
 * Notes directory: $PI_LEARN_NOTES_DIR, else the working directory.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	INDEX_BASENAME,
	INDEX_FILENAME,
	buildIndexNote,
	buildResumeBrief,
	findMermaidFences,
	formatDate,
	formatDateTime,
	hideMermaidBlocks,
	pickMostRecent,
	readFrontmatter,
	sanitizeNoteName,
	sessionListEntry,
	summarizeNote,
	updateFrontmatter,
	upsertSessionSection,
	type MermaidFence,
	type NoteSummary,
} from "./lib/learn-notes.ts";

const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

/** Latest md-log instance in this process (session replacement re-runs the factory). */
const INSTANCE_KEY = "__piLearnMdLog";
const VALIDATE_TIMEOUT_MS = 20_000;

type MermaidCheck = { status: string; error?: string };
type Validator = (source: string) => Promise<MermaidCheck>;

interface MdLogInstance {
	/** Link + brief inside `ctx`'s session. `persist: false` when the md-log entry was already written. */
	resumeHere(ctx: any, file: string, opts: { persist: boolean }): Promise<void>;
}

function notesDirFor(ctx: any): string {
	return process.env.PI_LEARN_NOTES_DIR || ctx.cwd;
}

function samePath(a: string, b: string): boolean {
	const na = path.resolve(a);
	const nb = path.resolve(b);
	return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function sharedState(): { linkedNote: string | null } {
	const g = globalThis as any;
	if (!g.__piLearn || typeof g.__piLearn !== "object") g.__piLearn = { linkedNote: null };
	if (!("linkedNote" in g.__piLearn)) g.__piLearn.linkedNote = null;
	return g.__piLearn;
}

function sessionIdOf(ctx: any): string {
	const sm = ctx?.sessionManager;
	try {
		const id = sm?.getSessionId?.();
		if (id) return String(id);
	} catch {
		/* fall through */
	}
	try {
		const header = sm?.getHeader?.();
		if (header?.id) return String(header.id);
	} catch {
		/* fall through */
	}
	return "unknown-session";
}

function hasConversation(ctx: any): boolean {
	const entries: any[] = ctx.sessionManager.getEntries?.() ?? [];
	return entries.some(
		(e) => e?.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
	);
}

export default function mdLog(pi: ExtensionAPI) {
	let logFile: string | null = null;
	sharedState();

	function setLinked(file: string | null, ctx: any): void {
		logFile = file;
		sharedState().linkedNote = file;
		if (file) {
			const theme = ctx.ui.theme;
			ctx.ui.setStatus(
				"md-log",
				theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(file)),
			);
			ensureStyle(file, ctx);
		} else {
			ctx.ui.setStatus("md-log", undefined);
		}
	}

	// Obsidian CSS snippet for learning notes (./lib/obsidian-style.ts, optional).
	// Fire-and-forget: never blocks or fails a write; warns at most once per session.
	let styleWarned = false;
	function ensureStyle(file: string, ctx: any): Promise<void> {
		return (async () => {
			try {
				const mod: any = await import("./lib/obsidian-style.ts");
				if (typeof mod?.ensureLearnStyle !== "function") return;
				const r = await mod.ensureLearnStyle(file);
				if ((r?.status === "customized" || r?.status === "error") && !styleWarned) {
					styleWarned = true;
					ctx.ui.notify(r.message || `pi-learn Obsidian style: ${r.status}`, "warning");
				}
			} catch {
				// module missing, installer failed, or ctx went stale: stay silent
			}
		})();
	}

	// --- State restoration on session restart ---

	pi.on("session_start", async (_event, ctx) => {
		let lastLinkData: { file: string | null } | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "md-log") {
				lastLinkData = entry.data as { file: string | null } | undefined;
			}
		}
		if (lastLinkData?.file) {
			setLinked(lastLinkData.file, ctx);
		} else {
			sharedState().linkedNote = null;
		}
	});

	// --- Serialization: events can fire close together; keep appends ordered ---

	let writeLock: Promise<void> = Promise.resolve();
	function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		const prev = writeLock;
		let release: () => void;
		writeLock = new Promise<void>((r) => {
			release = r;
		});
		return prev.then(fn).finally(() => release!());
	}

	// learn-updated is refreshed at most once per minute (the stamp has minute precision).
	let lastUpdatedStamp: { file: string; stamp: string } | null = null;
	function touchUpdated(file: string, current: string): string {
		const stamp = formatDateTime(new Date());
		if (lastUpdatedStamp && lastUpdatedStamp.file === file && lastUpdatedStamp.stamp === stamp) return current;
		lastUpdatedStamp = { file, stamp };
		const fm = readFrontmatter(current);
		if (!fm || !("learn-updated" in fm) || fm["learn-updated"] === stamp) return current;
		return updateFrontmatter(current, { updated: stamp });
	}

	function appendToFile(text: string): void {
		if (!logFile) return;
		try {
			let current = "";
			if (fs.existsSync(logFile)) {
				current = fs.readFileSync(logFile, "utf-8");
			}
			current = touchUpdated(logFile, current);
			const prefix = current.trim().length > 0 ? "\n\n" : "";
			fs.writeFileSync(logFile, current + prefix + text + "\n", "utf-8");
		} catch {
			// File may have been deleted externally; ignore.
		}
	}

	// --- Mermaid safety (validator from ./lib/mermaid.ts, optional) ---

	let validatorPromise: Promise<Validator | null> | null = null;
	function loadValidator(): Promise<Validator | null> {
		if (!validatorPromise) {
			validatorPromise = (async () => {
				try {
					const mod: any = await import("./lib/mermaid.ts");
					return typeof mod?.validateMermaid === "function" ? (mod.validateMermaid as Validator) : null;
				} catch {
					return null; // module missing or broken: md-log keeps working, diagrams pass through
				}
			})();
		}
		return validatorPromise;
	}

	const verdictCache = new Map<string, Promise<MermaidCheck>>();
	function validate(validator: Validator, source: string): Promise<MermaidCheck> {
		let cached = verdictCache.get(source);
		if (!cached) {
			cached = new Promise<MermaidCheck>((resolve) => {
				const timer = setTimeout(() => resolve({ status: "unavailable", error: "timeout" }), VALIDATE_TIMEOUT_MS);
				(timer as any).unref?.();
				Promise.resolve()
					.then(() => validator(source))
					.then(
						(v) => resolve(v && typeof v.status === "string" ? v : { status: "unavailable" }),
						(e) => resolve({ status: "unavailable", error: String(e) }),
					)
					.finally(() => clearTimeout(timer));
			});
			verdictCache.set(source, cached);
		}
		return cached;
	}

	/** Assistant text as it should appear in the note: rejected Mermaid blocks hidden. */
	async function noteSafe(text: string, ctx: any): Promise<string> {
		const fences = findMermaidFences(text).filter((f) => !f.hidden);
		if (fences.length === 0) return text;
		const hash = (source: string) => createHash("sha256").update(source).digest("hex");
		const qualityStatus = new Map<string, "pass" | "repair">();
		for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
			if (entry?.type === "custom" && entry.customType === "diagram-quality" && typeof entry.data?.hash === "string" && (entry.data.status === "pass" || entry.data.status === "repair")) {
				qualityStatus.set(entry.data.hash, entry.data.status);
			}
		}
		const shared = (globalThis as any).__piLearnDiagramQuality;
		if (shared?.sessionId === sessionIdOf(ctx)) {
			try {
				const quality = await shared.byText?.get(text);
				for (const issue of quality?.issues ?? []) qualityStatus.set(hash(issue.source), "repair");
			} catch { /* a reviewer failure must not stop note writing */ }
			for (const [sourceHash, status] of shared.bySource ?? []) {
				if (status === "pass" || status === "repair") qualityStatus.set(sourceHash, status);
			}
		}
		const validator = await loadValidator();
		const invalid: MermaidFence[] = [];
		for (const f of fences) {
			if (qualityStatus.get(hash(f.source)) === "repair") { invalid.push(f); continue; }
			if (validator) {
				const v = await validate(validator, f.source);
				if (v.status === "invalid") invalid.push(f);
			}
		}
		return invalid.length > 0 ? hideMermaidBlocks(text, invalid) : text;
	}

	// --- Formatting ---

	function callout(type: string, title: string, bodyLines: string[]): string {
		const lines = [`> [!${type}] ${title}`];
		for (const line of bodyLines) {
			lines.push(line.length === 0 ? ">" : `> ${line}`);
		}
		return lines.join("\n");
	}

	function userBlock(text: string): string {
		return `> [!quote] YOU\n\n${text}`;
	}

	// Skill declarations (`<skill name="..." ...> ...whole SKILL.md... </skill>`)
	// are system-injected context, not user prose. Replace each with a compact
	// callout noting the skill was loaded, so the log keeps the signal without
	// the noise. Runs on already-trimmed text.
	function stripSkillBlocks(text: string): string {
		return text.replace(
			/<skill\b([^>]*)>[\s\S]*?<\/skill>/g,
			(_match, attrs: string) => {
				const name = /name="([^"]+)"/.exec(attrs)?.[1];
				return `> [!note] SKILL loaded: ${name ?? "(unknown)"}`;
			},
		);
	}

	function assistantBlock(text: string): string {
		return `> [!abstract] PI\n\n${text}`;
	}

	function optionsList(options: Array<{ label: string }>): string[] {
		return options.map((o, i) => `${i + 1}. ${o.label}`);
	}

	function questionCallout(label: string, question: string, context: string | undefined, options: Array<{ label: string }>): string {
		const body: string[] = [];
		for (const line of question.split("\n")) body.push(line);
		if (context) {
			body.push("");
			for (const line of context.split("\n")) body.push(line);
		}
		if (options.length > 0) {
			body.push("");
			body.push(...optionsList(options));
		}
		return callout("question", label, body);
	}

	function answerCalloutQuiz(details: any): string {
		const status = details?.status;
		if (status === "cancelled") {
			return callout("warning", "Quiz — cancelled", ["(user skipped)"]);
		}
		if (status === "unavailable") {
			return callout("warning", "Quiz — unavailable", [details?.message || ""]);
		}
		// "I don't know" is neither correct nor incorrect — it's a distinct signal,
		// so it never renders as a red ✗.
		const dontKnow = details?.dontKnow === true;
		const correct = details?.correct === true;
		const type = dontKnow ? "question" : correct ? "success" : "failure";
		const title = dontKnow
			? "Quiz — I don't know"
			: correct
				? "Quiz — correct ✓"
				: "Quiz — incorrect ✗";
		const body: string[] = [];

		if (dontKnow) {
			body.push("Your answer: I don't know");
		} else {
			const answers: any[] = details?.answers || [];
			const sel = answers.map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)";
			body.push(`Your answer: ${sel}`);
		}

		const correctIndices: number[] = details?.correctIndices || [];
		const correctStr = correctIndices.map((i) => `${i}`).join(", ");
		body.push(`Correct answer: ${correctStr}`);

		// Optional free-text note the user typed in the always-present note field.
		// Only present (in details) when non-empty, so no guard for empty strings.
		if (details?.note) {
			body.push("");
			const noteLines = String(details.note).split("\n");
			body.push(`Note: ${noteLines[0]}`);
			for (let i = 1; i < noteLines.length; i++) body.push(noteLines[i]);
		}

		if (details?.explanation) {
			body.push("");
			for (const line of String(details.explanation).split("\n")) body.push(line);
		}
		return callout(type, title, body);
	}

	function answerCalloutAsk(details: any): string {
		const status = details?.status;
		if (status === "cancelled") {
			return callout("warning", "Question — cancelled", ["(user skipped)"]);
		}
		if (status === "unavailable") {
			return callout("warning", "Question — unavailable", [details?.message || ""]);
		}
		const answers: any[] = details?.answers || [];
		const body: string[] = answers.map((a) => {
			if (a.type === "other") return `Other: ${a.label}`;
			if (a.type === "text") return a.label;
			return `${a.index}. ${a.label}`;
		});
		if (body.length === 0) body.push("(no answer)");
		return callout("example", "Answer", body);
	}

	// A QA result that never reached the learner: blocked by another extension
	// (isError) or not produced by the QA tool itself (no details.status).
	function isBlockedResult(isError: unknown, details: any): boolean {
		return isError === true || !details || typeof details.status !== "string" || details.status.length === 0;
	}

	function userText(msg: any): string {
		return typeof msg.content === "string"
			? msg.content
			: Array.isArray(msg.content)
				? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
				: "";
	}

	function assistantText(msg: any): string {
		const textParts = (msg.content || [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => (c.text as string).trim())
			.filter((t: string) => t.length > 0);
		return textParts.join("\n\n");
	}

	// --- Event handlers ---

	pi.on("message_end", async (event, ctx) => {
		if (!logFile) return;
		const msg = event.message;
		if (!msg || !("role" in msg)) return;

		if (msg.role === "user") {
			const trimmed = stripSkillBlocks(userText(msg).trim());
			if (!trimmed) return;
			await withLock(() => appendToFile(userBlock(trimmed)));
			return;
		}

		if (msg.role === "assistant") {
			const text = assistantText(msg);
			if (!text) return;
			// Validate inside the lock so a slow validator can't reorder blocks.
			await withLock(async () => appendToFile(assistantBlock(await noteSafe(text, ctx))));
			return;
		}
		// toolResult messages are handled by the tool_result event (for QA tools).
		// Custom messages (e.g. the hidden learn-resume brief) are never logged.
	});

	// ask_user_question never shuffles its options, so its args are already the
	// true display order. The question is written live when the tool actually
	// starts executing (its first onUpdate), not at tool_call: another extension
	// (system-diagrams) may still block the call at tool_call, and a blocked
	// question must never appear in the note. If an implementation emits no
	// update, the question is written together with its answer on tool_result.
	const loggedAskQuestion = new Set<string>();
	async function logAskQuestion(toolCallId: string, input: any): Promise<void> {
		if (loggedAskQuestion.has(toolCallId)) return;
		loggedAskQuestion.add(toolCallId);
		const question: string = input?.question || "";
		const context: string | undefined = input?.details?.trim() || undefined;
		const options: Array<{ label: string }> = Array.isArray(input?.options) ? input.options : [];
		const block = questionCallout("Question", question, context, options);
		await withLock(() => appendToFile(block));
	}

	// quiz DOES shuffle its options inside execute(), so the tool_call args are
	// the pre-shuffle author order — NOT what the user is shown. quiz emits an
	// onUpdate() with the true (post-shuffle) order before it blocks on the
	// user's answer; wait for that instead so the logged order always matches
	// what's on screen. Guard against duplicate writes if multiple updates fire
	// for the same call. (A quiz blocked at tool_call never executes, so it
	// never gets a question block.)
	const loggedQuizQuestion = new Set<string>();
	pi.on("tool_execution_update", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as any).toolName;
		if (toolName === "ask_user_question") {
			await logAskQuestion((event as any).toolCallId, (event as any).args || {});
			return;
		}
		if (toolName !== "quiz") return;
		const toolCallId = (event as any).toolCallId;
		if (loggedQuizQuestion.has(toolCallId)) return;
		const shuffled = (event as any).partialResult?.details?.options as Array<{ index: number; label: string }> | undefined;
		if (!shuffled || shuffled.length === 0) return;
		loggedQuizQuestion.add(toolCallId);
		const input = (event as any).args || {};
		const question: string = input.question || "";
		const context: string | undefined = input.details?.trim() || undefined;
		const options = shuffled.map((o) => ({ label: o.label }));
		const block = questionCallout("Quiz", question, context, options);
		await withLock(() => appendToFile(block));
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as any).toolName;
		if (!QA_TOOLS.has(toolName)) return;
		const details = (event as any).details;
		if (isBlockedResult((event as any).isError, details)) return;
		if (toolName === "ask_user_question") {
			await logAskQuestion((event as any).toolCallId, (event as any).input || {});
		}
		const block = toolName === "quiz"
			? answerCalloutQuiz(details)
			: answerCalloutAsk(details);
		await withLock(() => appendToFile(block));
	});

	// --- Backfill ---

	async function backfillBlocks(ctx: any): Promise<{ blocks: string[]; count: number }> {
		const entries: any[] = ctx.sessionManager.getEntries();
		if (entries.length === 0) return { blocks: [], count: 0 };

		const byId = new Map<string, any>();
		for (const e of entries) if (e.id) byId.set(e.id, e);

		// Active leaf = last entry that has an id (skip the session header).
		let leaf: any = null;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].id) {
				leaf = entries[i];
				break;
			}
		}
		if (!leaf) return { blocks: [], count: 0 };

		// Walk parent chain to root.
		const chain: any[] = [];
		let cur: any = leaf;
		const seen = new Set<string>();
		while (cur && cur.id && !seen.has(cur.id)) {
			seen.add(cur.id);
			chain.push(cur);
			cur = cur.parentId ? byId.get(cur.parentId) : null;
		}
		chain.reverse();

		// Track tool-call args from assistant messages so we can pair with results.
		const toolCallArgs = new Map<string, { name: string; args: any }>();

		const blocks: string[] = [];
		let count = 0;
		for (const entry of chain) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg || !("role" in msg)) continue;
			count++;

			if (msg.role === "user") {
				const trimmed = stripSkillBlocks(userText(msg).trim());
				if (trimmed) blocks.push(userBlock(trimmed));
				continue;
			}

			if (msg.role === "assistant") {
				// Index tool calls for later pairing.
				for (const c of msg.content || []) {
					if (c.type === "toolCall" && QA_TOOLS.has(c.name)) {
						toolCallArgs.set(c.id, { name: c.name, args: c.arguments });
					}
				}
				const text = assistantText(msg);
				if (text) blocks.push(assistantBlock(await noteSafe(text, ctx)));
				continue;
			}

			if (msg.role === "toolResult") {
				if (!QA_TOOLS.has(msg.toolName)) continue;
				// Blocked call: the learner never saw it — no question, no answer.
				if (isBlockedResult(msg.isError, msg.details)) continue;
				const tc = toolCallArgs.get(msg.toolCallId);
				// Question block. For quiz, use the persisted result's `details.options`
				// — the TRUE post-shuffle display order the user actually saw — rather
				// than the original tool-call args, which are the pre-shuffle author
				// order and can mismatch what's on screen. ask_user_question never
				// shuffles, so its tool-call args are already the true order.
				if (tc) {
					const a = tc.args || {};
					const label = tc.name === "quiz" ? "Quiz" : "Question";
					const shuffled = msg.toolName === "quiz"
						? (msg.details?.options as Array<{ index: number; label: string }> | undefined)
						: undefined;
					const options = shuffled && shuffled.length > 0
						? shuffled.map((o) => ({ label: o.label }))
						: (Array.isArray(a.options) ? a.options : []);
					blocks.push(questionCallout(label, a.question || "", a.details?.trim() || undefined, options));
				}
				if (msg.toolName === "quiz") {
					blocks.push(answerCalloutQuiz(msg.details));
				} else {
					blocks.push(answerCalloutAsk(msg.details));
				}
				continue;
			}
		}
		return { blocks, count };
	}

	// --- Linking ---

	interface LinkOptions {
		/** learn-topic when the note has none (default: the note's basename). */
		topic?: string;
		/** Add `tags: [learn]` when the note has no tags (notes created by /learn). */
		tags?: boolean;
		/** New section gets `Continues [[#<previous session>]].` */
		resume?: boolean;
		/** Write the md-log custom entry (false when it was written by newSession's setup). */
		persist?: boolean;
	}

	interface LinkResult {
		written: number;
		heading: string;
		created: boolean;
		/** Note text before this link (for the resume brief). */
		before: string;
	}

	/**
	 * Link `file` to the current pi session: backfill into this session's own
	 * section (regenerated if it exists, else appended), update frontmatter.
	 * Never destroys existing content.
	 */
	async function linkNote(ctx: any, file: string, opts: LinkOptions): Promise<LinkResult> {
		const result = await withLock(async () => {
			const { blocks, count } = await backfillBlocks(ctx);
			const before = fs.readFileSync(file, "utf-8");
			const now = new Date();
			const sessionId = sessionIdOf(ctx);
			const up = upsertSessionSection(before, {
				sessionId,
				date: formatDate(now),
				content: blocks.join("\n\n"),
				continuesPrevious: opts.resume === true,
			});
			const text = updateFrontmatter(up.text, {
				topic: opts.topic ?? path.basename(file, path.extname(file)),
				status: "active",
				created: formatDate(now),
				updated: formatDateTime(now),
				session: up.created ? sessionListEntry(now, sessionId) : undefined,
				tags: opts.tags ? ["learn"] : undefined,
				cssclasses: ["pi-learn"],
			});
			fs.writeFileSync(file, text, "utf-8");
			lastUpdatedStamp = { file, stamp: formatDateTime(now) };
			return { written: count, heading: up.heading, created: up.created, before };
		});
		if (opts.persist !== false) pi.appendEntry("md-log", { file });
		setLinked(file, ctx);
		return result;
	}

	// --- Index ---

	function readHead(file: string, bytes = 16 * 1024): string {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(bytes);
			const n = fs.readSync(fd, buf, 0, bytes, 0);
			return buf.subarray(0, n).toString("utf-8");
		} finally {
			fs.closeSync(fd);
		}
	}

	function learningNotes(notesDir: string): Array<NoteSummary & { file: string }> {
		const out: Array<NoteSummary & { file: string }> = [];
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(notesDir, { withFileTypes: true });
		} catch {
			return out;
		}
		for (const e of entries) {
			if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
			const basename = e.name.slice(0, -3);
			if (basename === INDEX_BASENAME) continue;
			const file = path.join(notesDir, e.name);
			try {
				if (!/^learn-topic\s*:/m.test(readHead(file))) continue;
				const text = fs.readFileSync(file, "utf-8");
				const summary = summarizeNote(text, basename, fs.statSync(file).mtimeMs);
				if (summary) out.push({ ...summary, file });
			} catch {
				// unreadable note: skip
			}
		}
		return out;
	}

	function regenerateIndex(notesDir: string): void {
		try {
			if (!fs.statSync(notesDir).isDirectory()) return;
			fs.writeFileSync(path.join(notesDir, INDEX_FILENAME), buildIndexNote(learningNotes(notesDir)), "utf-8");
		} catch {
			// index is a convenience; never fail a link over it
		}
	}

	// --- Resume ---

	function resolveNote(arg: string, ctx: any): string | null {
		let a = arg.trim();
		if ((a.startsWith('"') && a.endsWith('"')) || (a.startsWith("'") && a.endsWith("'"))) a = a.slice(1, -1).trim();
		if (a.startsWith("[[") && a.endsWith("]]")) a = a.slice(2, -2).split("|")[0].trim();
		if (!a) return null;
		const withMd = (p: string) => (p.toLowerCase().endsWith(".md") ? [p] : [p, `${p}.md`]);
		const candidates: string[] = path.isAbsolute(a)
			? withMd(a)
			: [...withMd(path.resolve(notesDirFor(ctx), a)), ...withMd(path.resolve(ctx.cwd, a))];
		return candidates.find(isFile) ?? null;
	}

	async function sendBrief(ctx: any, brief: string): Promise<void> {
		const message = { customType: "learn-resume", content: brief, display: false };
		if (typeof ctx.sendMessage === "function") {
			await ctx.sendMessage(message, { triggerTurn: true });
		} else {
			pi.sendMessage(message, { triggerTurn: true });
		}
	}

	const self: MdLogInstance = {
		async resumeHere(ctx, file, opts) {
			const link = await linkNote(ctx, file, { resume: true, persist: opts.persist });
			regenerateIndex(notesDirFor(ctx));
			const brief = buildResumeBrief(link.before, {
				noteName: path.basename(file, path.extname(file)),
				newHeading: link.heading,
			});
			ctx.ui.notify(`Resuming: ${path.basename(file)} → ${link.heading}`, "info");
			await sendBrief(ctx, brief);
		},
	};
	(globalThis as any)[INSTANCE_KEY] = self;

	/** /learn-resume body once the note is resolved and readable. */
	async function resumeNote(ctx: any, file: string): Promise<void> {
		if (!hasConversation(ctx)) {
			await self.resumeHere(ctx, file, { persist: true });
			return;
		}
		// The current session already has a conversation: continue in a fresh one.
		// Session replacement invalidates this `pi`/ctx and re-runs the factory, so
		// the md-log entry is written by `setup` and the rest runs in the NEW
		// instance with the fresh ctx.
		const result = await ctx.newSession({
			setup: async (sessionManager: any) => {
				sessionManager.appendCustomEntry?.("md-log", { file });
			},
			withSession: async (fresh: any) => {
				const latest = (globalThis as any)[INSTANCE_KEY] as MdLogInstance | undefined;
				try {
					await (latest ?? self).resumeHere(fresh, file, { persist: false });
				} catch (e) {
					fresh.ui.notify(`Could not resume ${path.basename(file)}: ${(e as Error).message}`, "error");
				}
			},
		});
		if (result?.cancelled) ctx.ui.notify("Resume cancelled.", "warning");
	}

	// --- Commands ---

	pi.registerCommand("md-log", {
		description: "Mirror the session to a markdown file (backfills history)",
		handler: async (args, ctx: any) => {
			const filepath = args.trim();
			if (!filepath) {
				ctx.ui.notify("Usage: /md-log <filepath>", "warning");
				return;
			}
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish before linking.", "warning");
				return;
			}

			const resolved = path.isAbsolute(filepath) ? filepath : path.resolve(ctx.cwd, filepath);

			// The file must already exist — /md-log links into an existing note,
			// it never creates one. This avoids silently scattering new files
			// (and parent directories) around the vault from a typo'd path.
			if (!fs.existsSync(resolved)) {
				ctx.ui.notify(`File does not exist: ${resolved}`, "error");
				return;
			}
			if (!fs.statSync(resolved).isFile()) {
				ctx.ui.notify(`Not a file: ${resolved}`, "error");
				return;
			}

			let link: LinkResult;
			try {
				link = await linkNote(ctx, resolved, {});
			} catch (e) {
				ctx.ui.notify(`Could not link ${resolved}: ${(e as Error).message}`, "error");
				return;
			}
			// The index lives in the notes dir and lists only that folder.
			const notesDir = notesDirFor(ctx);
			if (samePath(path.dirname(resolved), notesDir)) regenerateIndex(notesDir);

			ctx.ui.notify(`Linked: ${resolved} → ${link.heading} (${link.written} entries backfilled)`, "info");
		},
	});

	pi.registerCommand("md-unlog", {
		description: "Stop mirroring the session to a markdown file",
		handler: async (_args, ctx) => {
			if (!logFile) {
				ctx.ui.notify("No file linked", "warning");
				return;
			}
			const name = path.basename(logFile);
			pi.appendEntry("md-log", { file: null });
			setLinked(null, ctx);
			ctx.ui.notify(`Unlinked: ${name}`, "info");
		},
	});

	pi.registerCommand("learn", {
		description: "Start learning a topic: create an Obsidian note, link it and begin teaching",
		handler: async (args, ctx: any) => {
			const topic = args.trim().replace(/\s+/g, " ");
			if (!topic) {
				ctx.ui.notify("Usage: /learn <topic>", "warning");
				return;
			}
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish before starting a lesson.", "warning");
				return;
			}
			const name = sanitizeNoteName(topic);
			if (!name || name === INDEX_BASENAME) {
				ctx.ui.notify(`Cannot make a note name from "${topic}". Try a different wording.`, "warning");
				return;
			}
			const notesDir = notesDirFor(ctx);
			if (!fs.existsSync(notesDir) || !fs.statSync(notesDir).isDirectory()) {
				ctx.ui.notify(`Notes folder does not exist: ${notesDir} (set PI_LEARN_NOTES_DIR)`, "error");
				return;
			}
			const file = path.join(notesDir, `${name}.md`);
			if (fs.existsSync(file)) {
				// Never overwrite: an existing note means "continue it".
				try {
					await resumeNote(ctx, file);
				} catch (e) {
					ctx.ui.notify(`Could not resume ${path.basename(file)}: ${(e as Error).message}`, "error");
				}
				return;
			}
			let link: LinkResult;
			try {
				fs.writeFileSync(file, "", { encoding: "utf-8", flag: "wx" });
				link = await linkNote(ctx, file, { topic, tags: true });
			} catch (e) {
				ctx.ui.notify(`Could not create ${file}: ${(e as Error).message}`, "error");
				return;
			}
			regenerateIndex(notesDir);
			ctx.ui.notify(`Learning note: ${file} → ${link.heading}`, "info");
			pi.sendUserMessage(`Teach me: ${topic}`);
		},
	});

	pi.registerCommand("learn-resume", {
		description: "Continue a learning note (default: the most recently studied one)",
		handler: async (args, ctx: any) => {
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish before resuming.", "warning");
				return;
			}
			const notesDir = notesDirFor(ctx);
			let file: string | null;
			if (args.trim()) {
				file = resolveNote(args, ctx);
				if (!file) {
					ctx.ui.notify(`Learning note not found: ${args.trim()} (looked in ${notesDir} and ${ctx.cwd})`, "error");
					return;
				}
			} else {
				const latest = pickMostRecent(learningNotes(notesDir));
				if (!latest) {
					ctx.ui.notify(`No learning notes in ${notesDir}. Start one with /learn <topic>.`, "error");
					return;
				}
				file = path.join(notesDir, `${latest.basename}.md`);
			}
			try {
				fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
				fs.readFileSync(file, "utf-8");
			} catch (e) {
				ctx.ui.notify(`Cannot read learning note ${file}: ${(e as Error).message}`, "error");
				return;
			}
			try {
				await resumeNote(ctx, file);
			} catch (e) {
				ctx.ui.notify(`Could not resume ${path.basename(file)}: ${(e as Error).message}`, "error");
			}
		},
	});
}
