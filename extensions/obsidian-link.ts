/**
 * Obsidian link — keep a learning note synchronized with the Pi lesson.
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
 * One /learn command offers new, open, search, resume, status and close.
 * Old md-log session entries are read only to restore existing Pi sessions.
 *
 * Notes directory: $PI_LEARN_NOTES_DIR, else the user's pi-learn.json
 * configuration, else the working directory.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import {
	INDEX_BASENAME,
	INDEX_FILENAME,
	buildIndexNote,
	buildResumeBrief,
	findMermaidFences,
	findSessionSections,
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
import { LEARN_LINK_ENTRY, linkedNoteFromEntries } from "./lib/learn-link-state.ts";
import { findVaultRoot } from "./lib/obsidian-style.ts";

const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

/** Latest Obsidian link instance in this process (session replacement re-runs the factory). */
const INSTANCE_KEY = "__piLearnObsidianLink";
const VALIDATE_TIMEOUT_MS = 20_000;

type MermaidCheck = { status: string; error?: string };
type Validator = (source: string) => Promise<MermaidCheck>;

interface ObsidianLinkInstance {
	/** Link + brief inside `ctx`'s session. `persist: false` when the link entry was already written. */
	resumeHere(ctx: any, file: string, opts: { persist: boolean }): Promise<void>;
}

function notesDirFor(ctx: any): string {
	if (process.env.PI_LEARN_NOTES_DIR?.trim()) return path.resolve(process.env.PI_LEARN_NOTES_DIR.trim());
	try {
		const config = JSON.parse(fs.readFileSync(agentConfigPath(), "utf8"));
		if (typeof config.notesDir === "string" && path.isAbsolute(config.notesDir)) return config.notesDir;
	} catch { /* an absent or malformed optional config leaves the current directory as the default */ }
	return ctx.cwd;
}

function agentConfigPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".pi", "agent");
	return path.join(agentDir, "pi-learn.json");
}

function learnHelp(notesDir: string): string {
	return `# pi-learn — commands and options

**Start or continue**

| Type in Pi | What it does |
| --- | --- |
| \`/learn new <topic>\` | Create and link a learning note, then start teaching. \`/learn <topic>\` also works. |
| \`/learn open [note]\` | Search your Obsidian learning notes and link one to this Pi session. With no name, choose from a picker. |
| \`/learn search [words]\` | Find notes by title or topic in the Pi terminal; choose one to open. |
| \`/learn resume [note]\` | Continue from a note's actual contents in a fresh Pi session. With no name, choose from a picker. |
| \`/learn-resume [note]\` | Shortcut for resume; with no name, continues the latest learning note. |
| \`/learn status\` / \`/learn close\` | Show the linked note, or unlink it. |
| \`/learn obsidian [folder]\` | Show or set the Obsidian notes folder. Pass a vault root to use its \`Learn\` folder. |

**Skills:** \`/skill:teach\` loads the teaching method; \`/skill:visualize\` requests a generated visual when its maker tools are available.

**During a lesson:** Pi asks graded \`quiz\` questions and \`ask_user_question\` prompts, draws Mermaid diagrams for systems, and can search Wikimedia Commons for a useful real image. The image tools (\`search_commons_images\` and \`import_commons_image\`) are used by the tutor and include attribution; they are not slash commands.

**Obsidian notes:** \`${notesDir}\`. The \`Learn Index.md\` there links your topics. Type \`/learn open \` or \`/learn resume \` and use Pi's completion list to find a note.`;
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

export default function obsidianLink(pi: ExtensionAPI) {
	let logFile: string | null = null;
	let currentCwd = process.cwd();
	sharedState();

	function setLinked(file: string | null, ctx: any): void {
		logFile = file;
		sharedState().linkedNote = file;
		if (file) {
			const theme = ctx.ui.theme;
			ctx.ui.setStatus(
				"learn-obsidian",
				theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(file)),
			);
			ensureStyle(file, ctx);
		} else {
			ctx.ui.setStatus("learn-obsidian", undefined);
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
		currentCwd = ctx.cwd;
		const file = linkedNoteFromEntries(ctx.sessionManager.getEntries());
		setLinked(file, ctx);
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
					return null; // module missing or broken: note sync keeps working, diagrams pass through
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
		/** Write the persisted link entry (false when it was written by newSession's setup). */
		persist?: boolean;
		/** Backfill prior messages into this note. Opening an existing note starts at the link point. */
		backfill?: boolean;
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
			const { blocks, count } = opts.backfill === false ? { blocks: [], count: 0 } : await backfillBlocks(ctx);
			const before = fs.readFileSync(file, "utf-8");
			const now = new Date();
			const sessionId = sessionIdOf(ctx);
			const existing = opts.backfill === false ? findSessionSections(before).find((s) => s.sessionId === sessionId) : undefined;
			const up = existing ? { text: before, heading: existing.heading, created: false } : upsertSessionSection(before, {
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
		if (opts.persist !== false) pi.appendEntry(LEARN_LINK_ENTRY, { file });
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
		for (const note of browsableNotes(notesDir)) {
			try {
				if (!/^learn-topic\s*:/m.test(readHead(note.file))) continue;
				const text = fs.readFileSync(note.file, "utf-8");
				const summary = summarizeNote(text, path.basename(note.file).replace(/\.md$/i, ""), fs.statSync(note.file).mtimeMs);
				if (summary) out.push({ ...summary, basename: note.relativePath.replace(/\.md$/i, ""), file: note.file });
			} catch {
				// unreadable note: skip
			}
		}
		return out;
	}

	interface BrowsableNote {
		file: string;
		relativePath: string;
		title: string;
		status: string;
		sessions: number;
		sortKey: number;
	}

	/** Scholar-style title browser. Plain Markdown notes can be linked too. */
	function browsableNotes(notesDir: string): BrowsableNote[] {
		const notes: BrowsableNote[] = [];
		const pending: Array<{ dir: string; depth: number }> = [{ dir: notesDir, depth: 0 }];
		while (pending.length && notes.length < 1000) {
			const { dir, depth } = pending.shift()!;
			let entries: fs.Dirent[];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const file = path.join(dir, entry.name);
				if (entry.isDirectory() && depth < 4 && entry.name !== "node_modules" && entry.name !== "pi-learn-images") {
					pending.push({ dir: file, depth: depth + 1 });
					continue;
				}
				if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || entry.name === INDEX_FILENAME) continue;
				try {
					const relativePath = path.relative(notesDir, file).split(path.sep).join("/");
					const basename = entry.name.slice(0, -3);
					const stat = fs.statSync(file);
					const summary = summarizeNote(readHead(file), basename, stat.mtimeMs);
					notes.push({ file, relativePath, title: summary?.topic || basename,
						status: summary?.status || "existing note", sessions: summary?.sessions || 0,
						sortKey: summary?.sortKey || stat.mtimeMs });
				} catch { /* unreadable note: skip */ }
				if (notes.length >= 1000) break;
			}
		}
		return notes.sort((a, b) => b.sortKey - a.sortKey || a.title.localeCompare(b.title));
	}

	function cleanNoteArgument(raw: string): string {
		let value = raw.trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1).trim();
		if (value.startsWith("[[") && value.endsWith("]]")) value = value.slice(2, -2).split("|")[0].trim();
		return value;
	}

	async function chooseNote(raw: string, ctx: any, action: "open" | "resume" | "search"): Promise<string | null> {
		const query = cleanNoteArgument(raw);
		if (query && path.isAbsolute(query) && isFile(query)) {
			if (findVaultRoot(query)) return query;
			ctx.ui.notify("That Markdown file is outside an Obsidian vault.", "warning");
			return null;
		}
		const notes = browsableNotes(notesDirFor(ctx));
		if (!notes.length) {
			ctx.ui.notify(`No Markdown notes found in ${notesDirFor(ctx)}. Start one with /learn new <topic>.`, "warning");
			return null;
		}
		const lower = query.replace(/\.md$/i, "").toLowerCase();
		let matches = notes;
		if (lower) {
			const exact = notes.filter((note) => [note.relativePath.replace(/\.md$/i, ""), path.basename(note.file, ".md"), note.title].some((value) => value.toLowerCase() === lower));
			if (exact.length === 1) return exact[0].file;
			matches = exact.length > 1 ? exact : notes.filter((note) => [note.relativePath, note.title].some((value) => value.toLowerCase().includes(lower)));
			if (matches.length === 1) return matches[0].file;
			if (!matches.length) {
				ctx.ui.notify(`No learning note matches "${query}". Try /learn search with a shorter title.`, "warning");
				return null;
			}
			if (action !== "search") {
				ctx.ui.notify(`Several notes match "${query}". Use autocomplete, a fuller name, or /learn search ${query}.`, "warning");
				return null;
			}
		}
		const options = matches.map((note) => note.relativePath);
		const selected = await ctx.ui.select(action === "resume" ? "Resume a learning note" : "Choose an Obsidian note", options);
		return matches.find((note) => note.relativePath === selected)?.file ?? null;
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

	async function sendBrief(ctx: any, brief: string): Promise<void> {
		const message = { customType: "learn-resume", content: brief, display: false };
		if (typeof ctx.sendMessage === "function") {
			await ctx.sendMessage(message, { triggerTurn: true });
		} else {
			pi.sendMessage(message, { triggerTurn: true });
		}
	}

	const self: ObsidianLinkInstance = {
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
		// the link entry is written by `setup` and the rest runs in the NEW
		// instance with the fresh ctx.
		const result = await ctx.newSession({
			setup: async (sessionManager: any) => {
				sessionManager.appendCustomEntry?.(LEARN_LINK_ENTRY, { file });
			},
			withSession: async (fresh: any) => {
				const latest = (globalThis as any)[INSTANCE_KEY] as ObsidianLinkInstance | undefined;
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

	const idle = (ctx: any, action: string): boolean => {
		if (typeof ctx.isIdle !== "function" || ctx.isIdle()) return true;
		ctx.ui.notify(`Wait for the agent to finish before ${action}.`, "warning");
		return false;
	};

	async function startTopic(raw: string, ctx: any): Promise<void> {
		if (!idle(ctx, "starting a lesson")) return;
		const topic = raw.trim().replace(/\s+/g, " ");
		const name = sanitizeNoteName(topic);
		if (!name || name === INDEX_BASENAME) {
			ctx.ui.notify("Usage: /learn new <topic>", "warning");
			return;
		}
		const notesDir = notesDirFor(ctx);
		if (!fs.existsSync(notesDir) || !fs.statSync(notesDir).isDirectory()) {
			ctx.ui.notify(`Notes folder does not exist: ${notesDir}. Set it with /learn obsidian <vault>.`, "error");
			return;
		}
		const file = path.join(notesDir, `${name}.md`);
		if (fs.existsSync(file)) {
			await continueNote(file, ctx);
			return;
		}
		try {
			fs.writeFileSync(file, "", { encoding: "utf-8", flag: "wx" });
			const link = await linkNote(ctx, file, { topic, tags: true });
			regenerateIndex(notesDir);
			ctx.ui.notify(`Learning note: ${file} → ${link.heading}`, "info");
			pi.sendUserMessage(`Teach me: ${topic}`);
		} catch (e) {
			ctx.ui.notify(`Could not start ${name}: ${(e as Error).message}`, "error");
		}
	}

	async function continueNote(file: string, ctx: any): Promise<void> {
		try {
			fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
			await resumeNote(ctx, file);
		} catch (e) {
			ctx.ui.notify(`Could not resume ${path.basename(file)}: ${(e as Error).message}`, "error");
		}
	}

	async function openExisting(raw: string, ctx: any, action: "open" | "search"): Promise<void> {
		if (!idle(ctx, "opening a note")) return;
		const file = await chooseNote(raw, ctx, action);
		if (!file) return;
		if (logFile && samePath(logFile, file)) {
			ctx.ui.notify(`Already linked: ${file}`, "info");
			return;
		}
		try {
			const link = await linkNote(ctx, file, { backfill: false });
			regenerateIndex(notesDirFor(ctx));
			ctx.ui.notify(`Linked: ${file} → ${link.heading}`, "info");
		} catch (e) {
			ctx.ui.notify(`Could not open ${file}: ${(e as Error).message}`, "error");
		}
	}

	async function resumeExisting(raw: string, ctx: any, latestByDefault = false): Promise<void> {
		if (!idle(ctx, "resuming a lesson")) return;
		let file: string | null;
		if (!raw.trim() && latestByDefault) {
			const latest = pickMostRecent(learningNotes(notesDirFor(ctx)));
			file = latest ? latest.file : null;
			if (!file) ctx.ui.notify("No learning notes found. Start with /learn new <topic>.", "warning");
		} else {
			file = await chooseNote(raw, ctx, "resume");
		}
		if (file) await continueNote(file, ctx);
	}

	function setObsidianFolder(raw: string, ctx: any): void {
		const input = cleanNoteArgument(raw);
		if (!input) {
			ctx.ui.notify(`Learning notes folder: ${notesDirFor(ctx)}`, "info");
			return;
		}
		const supplied = path.resolve(ctx.cwd, input);
		if (!fs.existsSync(supplied) || !fs.statSync(supplied).isDirectory()) {
			ctx.ui.notify(`Folder does not exist: ${supplied}`, "error");
			return;
		}
		const vault = findVaultRoot(supplied);
		if (!vault) {
			ctx.ui.notify(`No Obsidian vault contains ${supplied}. Choose a folder with a .obsidian directory above it.`, "error");
			return;
		}
		const folder = samePath(vault, supplied) ? path.join(vault, "Learn") : supplied;
		try {
			fs.mkdirSync(folder, { recursive: true });
			const configPath = agentConfigPath();
			let config: Record<string, unknown> = {};
			if (fs.existsSync(configPath)) {
				const existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
				if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("pi-learn.json is not a JSON object");
				config = existing;
			}
			config.notesDir = folder;
			fs.mkdirSync(path.dirname(configPath), { recursive: true });
			fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
			ctx.ui.notify(`Learning notes folder: ${folder}${process.env.PI_LEARN_NOTES_DIR ? " (PI_LEARN_NOTES_DIR currently overrides it)" : ""}`, "info");
		} catch (e) {
			ctx.ui.notify(`Could not save Obsidian folder: ${(e as Error).message}`, "error");
		}
	}

	const actions = [
		{ value: "new ", label: "new", description: "Start a topic and create its note" },
		{ value: "open ", label: "open", description: "Search and link an existing note" },
		{ value: "search ", label: "search", description: "Find a note and choose it" },
		{ value: "resume ", label: "resume", description: "Continue from a note's contents" },
		{ value: "status", label: "status", description: "Show the linked note" },
		{ value: "close", label: "close", description: "Unlink the current note" },
		{ value: "obsidian ", label: "obsidian", description: "Show or set the vault notes folder" },
		{ value: "help", label: "help", description: "Show commands and usage" },
	];

	pi.registerCommand("learn", {
		description: "Learn with searchable Obsidian notes: new, open, search, resume, status, close",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			if (!trimmed || !trimmed.includes(" ")) return actions.filter((item) => item.label.startsWith(trimmed.toLowerCase()));
			const match = /^(open|search|resume)\s+([\s\S]*)$/i.exec(trimmed);
			if (!match) return null;
			const action = match[1].toLowerCase();
			const query = cleanNoteArgument(match[2]).toLowerCase();
			return browsableNotes(notesDirFor({ cwd: currentCwd }))
				.filter((note) => !query || note.title.toLowerCase().includes(query) || note.relativePath.toLowerCase().includes(query))
				.slice(0, 50)
				.map((note) => ({ value: `${action} "${note.relativePath}"`, label: note.title,
					description: `${note.status} · ${note.sessions} session(s) · ${note.relativePath}` }));
		},
		handler: async (args, ctx: any) => {
			currentCwd = ctx.cwd;
			const trimmed = args.trim();
			if (!trimmed || /^(?:help|--help)$/i.test(trimmed)) {
				pi.sendMessage({ customType: "pi-learn-help", content: learnHelp(notesDirFor(ctx)), display: true }, { triggerTurn: false });
				return;
			}
			const parsed = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)!;
			const action = parsed[1].toLowerCase();
			const value = parsed[2] ?? "";
			if (action === "new") return startTopic(value, ctx);
			if (action === "open" || action === "link") return openExisting(value, ctx, "open");
			if (action === "search") return openExisting(value, ctx, "search");
			if (action === "resume") return resumeExisting(value, ctx);
			if (action === "obsidian") return setObsidianFolder(value, ctx);
			if (action === "status") {
				ctx.ui.notify(logFile ? `Linked learning note: ${logFile}` : `No note linked. Learning notes folder: ${notesDirFor(ctx)}`, "info");
				return;
			}
			if (action === "close") {
				if (!logFile) { ctx.ui.notify("No note linked", "warning"); return; }
				const name = path.basename(logFile);
				pi.appendEntry(LEARN_LINK_ENTRY, { file: null });
				setLinked(null, ctx);
				ctx.ui.notify(`Unlinked: ${name}`, "info");
				return;
			}
			return startTopic(trimmed, ctx); // /learn <topic> remains a shortcut for /learn new <topic>.
		},
	});

	pi.registerCommand("learn-resume", {
		description: "Shortcut for /learn resume (latest note when no name is given)",
		handler: async (args, ctx: any) => resumeExisting(args, ctx, true),
	});
}
