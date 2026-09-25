// Integration tests for extensions/obsidian-link.ts, loaded through pi's real extension loader
// and driven with fake events and a fake command context.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPiLoader, repoRoot } from "../helpers/pi.mjs";
import { formatDate, readFrontmatter, splitFrontmatter, findMermaidFences, findSessionSections, HIDDEN_DIAGRAM_CALLOUT } from "../../extensions/lib/learn-notes.ts";
import {
	ASK_ARGS,
	INVALID_MERMAID,
	QUIZ_ARGS,
	QUIZ_DETAILS,
	VALID_MERMAID,
	createSession,
	fillLesson,
	liveLessonEvents,
} from "../fixtures/md-log/session.mjs";

const fixturesDir = join(repoRoot, "tests", "fixtures", "md-log");
const realExtension = join(repoRoot, "extensions", "obsidian-link.ts");
const ALLOWED_LEVELS = new Set([undefined, "info", "warning", "error"]);

let loader;
let root;
// Amos Blomqvist's last upstream commit (amosblomqvist/learn "updated thumbnail"); the fork builds on it.
const UPSTREAM_BASELINE = "7cfd894";
let originalExtension; // md-log.ts from Amos's upstream baseline commit
let stubExtension; // real Obsidian link copied next to deterministic stand-ins
const savedEnv = process.env.PI_LEARN_NOTES_DIR;

before(async () => {
	loader = await importPiLoader();
	root = mkdtempSync(join(tmpdir(), "pi-learn-md-log-"));
	// Original extension, straight from git.
	const origDir = join(root, "orig-ext");
	mkdirSync(origDir);
	originalExtension = join(origDir, "md-log.ts");
	writeFileSync(originalExtension, execFileSync("git", ["show", `${UPSTREAM_BASELINE}:extensions/md-log.ts`], { cwd: repoRoot, encoding: "utf8" }));
	// Same code, but with deterministic stand-ins for the modules other work packages own.
	const stubDir = join(root, "stub-ext");
	mkdirSync(join(stubDir, "lib"), { recursive: true });
	stubExtension = join(stubDir, "obsidian-link.ts");
	copyFileSync(realExtension, stubExtension);
	copyFileSync(join(repoRoot, "extensions", "lib", "learn-notes.ts"), join(stubDir, "lib", "learn-notes.ts"));
	copyFileSync(join(repoRoot, "extensions", "lib", "learn-link-state.ts"), join(stubDir, "lib", "learn-link-state.ts"));
	writeFileSync(
		join(stubDir, "lib", "mermaid.ts"),
		`export async function validateMermaid(source: string) {
	(globalThis as any).__stubMermaidCalls = ((globalThis as any).__stubMermaidCalls ?? 0) + 1;
	return /-->\\s*$/m.test(source) ? { status: "invalid", error: "dangling edge" } : { status: "valid", diagramType: "flowchart" };
}
`,
	);
	writeFileSync(
		join(stubDir, "lib", "obsidian-style.ts"),
		`export function findVaultRoot(start: string) { return start; }
export async function ensureLearnStyle(notePath: string) {
	((globalThis as any).__stubStyleCalls ??= []).push(notePath);
	return { status: "customized", message: "pi-learn.css was customized; not overwriting" };
}
`,
	);
});

after(() => {
	if (savedEnv === undefined) delete process.env.PI_LEARN_NOTES_DIR;
	else process.env.PI_LEARN_NOTES_DIR = savedEnv;
	rmSync(root, { recursive: true, force: true });
});

// ─── harness ─────────────────────────────────────────────────────────────────

function newDir(name) {
	const dir = join(root, `${name}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(dir, ".obsidian"));
	return dir;
}

/** Load an extension with a runtime whose actions write into `session`. */
async function load(extPath, session, cwd) {
	const runtime = loader.createExtensionRuntime();
	const calls = { sendMessage: [], sendUserMessage: [] };
	runtime.appendEntry = (customType, data) => session.custom(customType, data);
	runtime.sendMessage = (message, options) => calls.sendMessage.push({ message, options });
	runtime.sendUserMessage = (content, options) => calls.sendUserMessage.push({ content, options });
	const loaded = await loader.loadExtensions([extPath], cwd, undefined, runtime);
	assert.deepEqual(loaded.errors, [], "extension loads without errors");
	assert.equal(loaded.extensions.length, 1);
	return { ext: loaded.extensions[0], runtime, calls, session };
}

function makeCtx(session, cwd, { idle = true, onNewSession, anyLevel = false } = {}) {
	const ui = {
		notices: [],
		status: new Map(),
		prompts: 0,
		theme: { fg: (_color, text) => text, bold: (t) => t },
		notify(message, level) {
			if (!anyLevel) assert.ok(ALLOWED_LEVELS.has(level), `notify level ${level} is not accepted by pi 0.87.1`);
			ui.notices.push({ message, level });
		},
		setStatus(key, text) {
			ui.status.set(key, text);
		},
		select: async () => { ui.prompts++; throw new Error("must not prompt"); },
		confirm: async () => { ui.prompts++; throw new Error("must not prompt"); },
		input: async () => { ui.prompts++; throw new Error("must not prompt"); },
	};
	return {
		cwd,
		hasUI: true,
		mode: "tui",
		ui,
		sessionManager: session.manager,
		isIdle: () => idle,
		newSession: onNewSession ?? (async () => { throw new Error("unexpected newSession"); }),
	};
}

async function emit(ext, name, event, ctx) {
	for (const handler of ext.handlers.get(name) ?? []) await handler(event, ctx);
}

async function command(ext, name, args, ctx) {
	const cmd = ext.commands.get(name);
	assert.ok(cmd, `command /${name} is registered`);
	await cmd.handler(args, ctx);
}

async function open(ext, file, ctx) {
	await command(ext, "learn", `open "${file}"`, ctx);
}

async function newTopic(ext, notesDir, topic, ctx) {
	const previous = process.env.PI_LEARN_NOTES_DIR;
	try {
		process.env.PI_LEARN_NOTES_DIR = notesDir;
		await command(ext, "learn", `new ${topic}`, ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_LEARN_NOTES_DIR;
		else process.env.PI_LEARN_NOTES_DIR = previous;
	}
}

const read = (p) => readFileSync(p, "utf8");
const normalizeUpdated = (t) => t.replace(/^learn-updated: .*$/m, "learn-updated: <t>");
const marker = (sid) => `%% learn-session: ${sid} %%`;
/** Everything after the session marker line. */
const afterMarker = (text, sid) => text.slice(text.indexOf(marker(sid)) + marker(sid).length + 1);
const today = () => formatDate(new Date());

async function waitFor(predicate, ms = 2000) {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) return false;
		await new Promise((r) => setTimeout(r, 10));
	}
	return true;
}

// ─── baseline formats vs the original md-log ─────────────────────────────────

test("live logging: lesson prose reads as Markdown while question callouts stay visual", async () => {
	const dir = newDir("live");
	const origFile = join(dir, "orig.md");
	const newFile = join(dir, "new.md");
	writeFileSync(origFile, "");
	writeFileSync(newFile, "");
	const s1 = createSession("aaaaaaaa-live-orig");
	const s2 = createSession("bbbbbbbb-live-new");
	const orig = await load(originalExtension, s1, dir);
	const mine = await load(realExtension, s2, dir);
	const ctx1 = makeCtx(s1, dir, { anyLevel: true }); // the original notifies "success"
	const ctx2 = makeCtx(s2, dir);
	await command(orig.ext, "md-log", origFile, ctx1);
	await open(mine.ext, newFile, ctx2);
	for (const [name, event] of liveLessonEvents()) {
		await emit(orig.ext, name, event, ctx1);
		await emit(mine.ext, name, event, ctx2);
	}
	const o = read(origFile);
	const n = read(newFile);
	assert.ok(o.includes("> [!question] Quiz\n> Why does binary search need a sorted array?"), "sanity: original logged the quiz");
	const expected = o
		.replace("> [!quote] YOU\n\nTeach me binary search\n\n> [!note] SKILL loaded: teach", "> [!quote] Learner\n> Teach me binary search")
		.replaceAll("> [!abstract] PI\n\n", "")
		.replace("> Correct answer: 2\n", "> Correct answer: 2. To discard half\n");
	assert.equal(afterMarker(n, s2.sessionId), `\n\n${expected}`, "only prose presentation and answer clarity change");
	assert.ok(!n.includes("SECRET-EXPLANATION: one comparison") || n.indexOf("SECRET") > n.indexOf("Quiz — correct"), "explanation only after answering");
	assert.ok(!n.includes("BRIEF-SHOULD-NOT-BE-LOGGED"));
	// true shuffled order, logged once despite two updates
	assert.equal(n.split("> [!question] Quiz\n").length - 1, 1);
	assert.ok(n.includes("> 1. It does not\n> 2. To discard half\n> 3. To use less memory"));
});

test("backfill uses the same book-style prose and question callouts as live logging", async () => {
	const dir = newDir("backfill");
	const origFile = join(dir, "orig.md");
	const newFile = join(dir, "new.md");
	writeFileSync(origFile, "");
	const s1 = fillLesson(createSession("aaaaaaaa-bf-orig"));
	const s2 = fillLesson(createSession("bbbbbbbb-bf-new"));
	const orig = await load(originalExtension, s1, dir);
	const mine = await load(realExtension, s2, dir);
	const ctx1 = makeCtx(s1, dir, { anyLevel: true }); // the original notifies "success"
	const ctx2 = makeCtx(s2, dir);
	await command(orig.ext, "md-log", origFile, ctx1);
	await newTopic(mine.ext, dir, "new", ctx2);
	const o = read(origFile);
	const n = read(newFile);
	assert.ok(o.includes("> [!note] SKILL loaded: teach"));
	const expected = o
		.replace("> [!quote] YOU\n\nTeach me binary search\n\n> [!note] SKILL loaded: teach", "> [!quote] Learner\n> Teach me binary search")
		.replaceAll("> [!abstract] PI\n\n", "")
		.replace("> Correct answer: 2\n", "> Correct answer: 2. To discard half\n");
	assert.equal(afterMarker(n, s2.sessionId), `\n${expected}`);
	assert.equal(ctx2.ui.notices.at(-1).level, "info", "success notify replaced by info");
	assert.match(ctx2.ui.notices.at(-1).message, /Learning note: .*new\.md → Session 1 \(\d{4}-\d{2}-\d{2}\)/);
});

test("live and backfilled notes omit reasoning and tool-status narration but keep the explanation", async () => {
	const dir = newDir("presentation");
	const lesson = [
		"I'll start by mapping your understanding and kick off background research.",
		"",
		"<analysis>Need to call a tool and inspect its result.</analysis>",
		"",
		"### Why the capacitor sits near the die",
		"The package path has inductance. For a current step, $V=L\\,di/dt$, so nearby capacitance responds first.",
		"",
		"The die sees a shorter current loop than the board can provide.",
	].join("\n");
	const msg = { role: "assistant", content: [{ type: "thinking", thinking: "private thought" }, { type: "text", text: lesson }] };
	const liveFile = join(dir, "live.md");
	writeFileSync(liveFile, "");
	const liveSession = createSession("12341234-presentation-live");
	const live = await load(realExtension, liveSession, dir);
	const liveCtx = makeCtx(liveSession, dir);
	await open(live.ext, liveFile, liveCtx);
	await emit(live.ext, "message_end", { message: msg }, liveCtx);
	const backfillSession = createSession("56785678-presentation-backfill");
	backfillSession.message(msg);
	const backfill = await load(realExtension, backfillSession, dir);
	await newTopic(backfill.ext, dir, "backfilled", makeCtx(backfillSession, dir));
	for (const note of [read(liveFile), read(join(dir, "backfilled.md"))]) {
		assert.ok(note.includes("### Why the capacitor sits near the die"));
		assert.ok(note.includes("$V=L\\,di/dt$"));
		assert.ok(note.includes("The die sees a shorter current loop"));
		for (const leaked of ["background research", "Need to call", "private thought", "> [!abstract] PI"]) assert.ok(!note.includes(leaked), leaked);
	}
});

test("presentation cleanup cannot bypass a diagram's semantic rejection", async () => {
	const dir = newDir("quality-cache");
	const file = join(dir, "diagram.md");
	writeFileSync(file, "");
	const session = createSession("aaaa5555-quality-cache");
	const source = findMermaidFences(VALID_MERMAID)[0].source;
	const raw = `Research is back.\n\n### The data path\n\n${VALID_MERMAID}`;
	globalThis.__piLearnDiagramQuality = {
		sessionId: session.sessionId,
		byText: new Map([[raw, Promise.resolve({ issues: [{ source }] })]]),
		bySource: new Map(),
	};
	try {
		const { ext } = await load(stubExtension, session, dir);
		const ctx = makeCtx(session, dir);
		await open(ext, file, ctx);
		await emit(ext, "message_end", { message: { role: "assistant", content: [{ type: "text", text: raw }] } }, ctx);
		const note = read(file);
		assert.ok(!note.includes("Research is back"));
		assert.ok(note.includes("### The data path"));
		assert.ok(!note.includes(HIDDEN_DIAGRAM_CALLOUT), "validator status stays out of the reader's note");
		assert.ok(note.includes(`%%\n${VALID_MERMAID}\n%%`), "the semantic verdict is applied before presentation cleanup");
		assert.equal(findMermaidFences(note).filter((f) => !f.hidden).length, 0);
	} finally {
		delete globalThis.__piLearnDiagramQuality;
	}
});

test("a quiz that fails before its question appears leaves no orphan callout", async () => {
	const dir = newDir("quiz-unavailable");
	const file = join(dir, "live.md");
	writeFileSync(file, "");
	const input = { question: "Why does it fail?", options: [{ label: "A" }, { label: "B" }] };
	const unavailable = { status: "unavailable", message: "quiz needs two distinct answers" };
	const liveSession = createSession("aaaabbbb-unavailable-live");
	const live = await load(realExtension, liveSession, dir);
	const liveCtx = makeCtx(liveSession, dir);
	await open(live.ext, file, liveCtx);
	await emit(live.ext, "tool_result", { toolName: "quiz", toolCallId: "never-shown", input, details: unavailable, isError: false }, liveCtx);
	assert.ok(!read(file).includes("Quiz — unavailable"));
	assert.ok(!read(file).includes("Why does it fail?"));
	const answered = { ...QUIZ_DETAILS, question: input.question };
	await emit(live.ext, "tool_result", { toolName: "quiz", toolCallId: "answered-without-update", input, details: answered, isError: false }, liveCtx);
	assert.ok(read(file).includes("> [!question] Quiz\n> Why does it fail?"));
	assert.ok(read(file).includes("> [!success] Quiz — correct"));
	const backfillSession = createSession("ccccdddd-unavailable-backfill");
	backfillSession.message({ role: "assistant", content: [{ type: "toolCall", id: "persisted-unavailable", name: "quiz", arguments: input }] });
	backfillSession.message({ role: "toolResult", toolCallId: "persisted-unavailable", toolName: "quiz", details: unavailable, isError: false });
	const backfill = await load(realExtension, backfillSession, dir);
	await newTopic(backfill.ext, dir, "backfilled", makeCtx(backfillSession, dir));
	const note = read(join(dir, "backfilled.md"));
	assert.ok(!note.includes("Quiz — unavailable"));
	assert.ok(!note.includes("Why does it fail?"));
	const legacySession = createSession("eeeeffff-answered-legacy");
	legacySession.message({ role: "assistant", content: [{ type: "toolCall", id: "legacy-answer", name: "quiz", arguments: QUIZ_ARGS }] });
	legacySession.message({ role: "toolResult", toolCallId: "legacy-answer", toolName: "quiz", details: { ...QUIZ_DETAILS, options: undefined }, isError: false });
	const legacy = await load(realExtension, legacySession, dir);
	await newTopic(legacy.ext, dir, "legacy-answer", makeCtx(legacySession, dir));
	const legacyNote = read(join(dir, "legacy-answer.md"));
	assert.ok(legacyNote.includes("> [!question] Quiz\n> Why does binary search need a sorted array?"));
	assert.ok(legacyNote.includes("> [!success] Quiz — correct"));
	assert.ok(!legacyNote.includes("> 1. To discard half"), "old author order must not be presented as the shuffled order");
});

// ─── linking ─────────────────────────────────────────────────────────────────

test("/learn open requires an existing file and is idempotent", async () => {
	const dir = newDir("idem");
	const file = join(dir, "Linear algebra.md");
	const s = fillLesson(createSession("cccccccc-idem"));
	const { ext } = await load(realExtension, s, dir);
	const ctx = makeCtx(s, dir);
	await open(ext, "missing.md", ctx);
	assert.equal(ctx.ui.notices.at(-1).level, "warning");
	assert.ok(!existsSync(join(dir, "missing.md")), "never creates the file");

	writeFileSync(file, "");
	await open(ext, file, ctx);
	const first = read(file);
	const fm = readFrontmatter(first);
	assert.equal(fm["learn-topic"], "Linear algebra", "topic defaults to the note's basename");
	assert.equal(fm["learn-status"], "active");
	assert.equal(fm["learn-created"], today());
	assert.match(fm["learn-updated"], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
	assert.deepEqual(fm["learn-sessions"].map((x) => x.replace(/^\S+ \S+ /, "")), ["· cccccccc"]);
	assert.deepEqual(fm.cssclasses, ["pi-learn"]);
	assert.equal(fm.tags, undefined, "tags only on notes created by /learn");
	assert.equal(findSessionSections(first).length, 1);

	await open(ext, file, ctx);
	assert.equal(normalizeUpdated(read(file)), normalizeUpdated(first), "re-link regenerates the same section");
	// the link is persisted, and shared with other extensions
	assert.equal(s.entries.filter((e) => e.customType === "learn-link").length, 1);
	assert.equal(globalThis.__piLearn.linkedNote, file);
	assert.equal(ctx.ui.status.get("learn-obsidian"), "🗒 Linear algebra.md");
});

test("/learn open keeps previous sessions and learner text byte-for-byte", async () => {
	const dir = newDir("prev");
	const file = join(dir, "Binary search trees.md");
	const original = read(join(fixturesDir, "previous-session.md"));
	writeFileSync(file, original);
	const s = fillLesson(createSession("dddddddd-prev"));
	const { ext } = await load(realExtension, s, dir);
	const ctx = makeCtx(s, dir);
	await open(ext, file, ctx);
	const after = read(file);
	const before = splitFrontmatter(original);
	const now = splitFrontmatter(after);
	assert.ok(now.body.startsWith(before.body), "old sessions + learner text are a byte-for-byte prefix");
	assert.ok(now.body.slice(before.body.length).startsWith(`\n## Session 2 (${today()})\n${marker(s.sessionId)}\n`));
	assert.ok(!now.body.slice(before.body.length).includes("> [!quote] Learner"), "opening a note never imports the earlier Pi conversation");
	assert.ok(!now.body.includes("Continues [[#"), "plain /learn open does not resume");
	// frontmatter: unknown keys and order kept, own keys merged
	assert.deepEqual(now.lines.slice(0, 4), ["aliases:", "  - BST basics", 'learn-topic: "Binary search trees"', "rating: 4"]);
	const fm = readFrontmatter(after);
	assert.equal(fm["learn-created"], "2026-09-20");
	assert.deepEqual(fm.tags, ["cs"]);
	assert.deepEqual(fm.cssclasses, ["wide", "pi-learn"]);
	assert.equal(fm["learn-sessions"].length, 2);
	assert.ok(fm["learn-sessions"][1].endsWith("· dddddddd"));
});

test("blocked QA calls produce no callouts (live and backfill)", async () => {
	const dir = newDir("blocked");
	const liveFile = join(dir, "live.md");
	const bfFile = join(dir, "backfill.md");
	writeFileSync(liveFile, "");
	const s1 = createSession("eeeeeeee-blocked-live");
	const live = await load(realExtension, s1, dir);
	const ctx1 = makeCtx(s1, dir);
	await open(live.ext, liveFile, ctx1);
	for (const [name, event] of liveLessonEvents({ withBlocked: true })) await emit(live.ext, name, event, ctx1);
	const s2 = fillLesson(createSession("ffffffff-blocked-bf"), { withBlocked: true });
	const bf = await load(realExtension, s2, dir);
	await newTopic(bf.ext, dir, "backfill", makeCtx(s2, dir));
	for (const text of [read(liveFile), read(bfFile)]) {
		assert.ok(!text.includes("BLOCKED"), "no question/answer for the blocked call");
		assert.equal(text.split("> [!question] Quiz\n").length - 1, 1, "only the real quiz");
		assert.equal(text.split("Quiz — ").length - 1, 1, "only the real answer");
		assert.equal(text.split("> [!question] Question\n").length - 1, 1);
		assert.ok(text.includes(`> [!question] Question\n> ${ASK_ARGS.question}\n>\n> 1. Proofs\n> 2. Code`));
	}
});

test("ask_user_question: written once when it executes; a call blocked at tool_call never reaches the note", async () => {
	const dir = newDir("ask-live");
	const file = join(dir, "ask.md");
	writeFileSync(file, "");
	const s = createSession("abababab-ask-live");
	const { ext } = await load(realExtension, s, dir);
	const ctx = makeCtx(s, dir);
	await open(ext, file, ctx);
	const args = { question: "BLOCKEDASK which way?", options: [{ label: "Left" }, { label: "Right" }] };
	// Blocked by another extension: tool_call happens, execute() never runs, result is an error.
	await emit(ext, "tool_call", { toolName: "ask_user_question", toolCallId: "blk", input: args }, ctx);
	await emit(ext, "tool_result", { toolName: "ask_user_question", toolCallId: "blk", input: args, isError: true, content: [{ type: "text", text: "held back" }], details: undefined }, ctx);
	assert.ok(!read(file).includes("BLOCKEDASK"), "blocked question is not logged");
	// Real call: execute() announces it via onUpdate → question now, answer on result, no duplicate.
	const real = { question: "Which topic next?", options: [{ label: "Proofs" }, { label: "Code" }] };
	await emit(ext, "tool_call", { toolName: "ask_user_question", toolCallId: "ok", input: real }, ctx);
	assert.ok(!read(file).includes("Which topic next?"), "not written before it executes");
	await emit(ext, "tool_execution_update", { toolName: "ask_user_question", toolCallId: "ok", args: real, partialResult: { details: { options: [{ index: 1, label: "Proofs" }, { index: 2, label: "Code" }] } } }, ctx);
	assert.ok(read(file).includes("> [!question] Question\n> Which topic next?\n>\n> 1. Proofs\n> 2. Code"));
	await emit(ext, "tool_result", { toolName: "ask_user_question", toolCallId: "ok", input: real, isError: false, content: [], details: { status: "answered", answers: [{ type: "option", index: 2, label: "Code", value: "Code" }] } }, ctx);
	const text = read(file);
	assert.equal(text.split("Which topic next?").length - 1, 1, "question written exactly once");
	assert.ok(text.indexOf("> [!example] Answer\n> 2. Code") > text.indexOf("Which topic next?"));
});

test("invalid Mermaid is hidden in the note (live + backfill); valid Mermaid is untouched; style installer warns once", async () => {
	globalThis.__stubStyleCalls = [];
	const dir = newDir("mermaid");
	const liveFile = join(dir, "live.md");
	const bfFile = join(dir, "backfill.md");
	writeFileSync(liveFile, "");
	const s1 = createSession("abababab-mermaid-live");
	const live = await load(stubExtension, s1, dir);
	const ctx1 = makeCtx(s1, dir);
	await open(live.ext, liveFile, ctx1);
	for (const [name, event] of liveLessonEvents({ withMermaid: true })) await emit(live.ext, name, event, ctx1);
	const s2 = fillLesson(createSession("cdcdcdcd-mermaid-bf"), { withMermaid: true });
	const bf = await load(stubExtension, s2, dir);
	const ctx2 = makeCtx(s2, dir);
	await newTopic(bf.ext, dir, "backfill", ctx2);
	const expected = `Here is the plan.\n\n${VALID_MERMAID}\n\nAnd a broken one:\n\n%%\n${INVALID_MERMAID}\n%%\n\nDone.`;
	for (const text of [read(liveFile), read(bfFile)]) {
		assert.ok(text.includes(expected), text);
	}
	assert.ok(globalThis.__stubMermaidCalls > 0, "validator module was imported dynamically");
	// ensureLearnStyle: called on link, "customized" → exactly one warning per session
	assert.ok(await waitFor(() => ctx1.ui.notices.some((n) => n.level === "warning")));
	await open(live.ext, liveFile, ctx1);
	await waitFor(() => globalThis.__stubStyleCalls.length >= 3);
	await new Promise((r) => setTimeout(r, 50));
	assert.ok(globalThis.__stubStyleCalls.includes(liveFile));
	assert.equal(ctx1.ui.notices.filter((n) => n.level === "warning").length, 1, "warned once");
	assert.equal(ctx1.ui.notices.find((n) => n.level === "warning").message, "pi-learn.css was customized; not overwriting");
});

test("session_start restores the link; /learn close stops logging", async () => {
	const dir = newDir("restore");
	const file = join(dir, "note.md");
	writeFileSync(file, "");
	const s = createSession("12121212-restore");
	const first = await load(realExtension, s, dir);
	await open(first.ext, file, makeCtx(s, dir));
	// a restarted pi: fresh instance, same session entries
	const second = await load(realExtension, s, dir);
	const ctx = makeCtx(s, dir);
	globalThis.__piLearn.linkedNote = null;
	await emit(second.ext, "session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.equal(ctx.ui.status.get("learn-obsidian"), "🗒 note.md");
	assert.equal(globalThis.__piLearn.linkedNote, file);
	await emit(second.ext, "message_end", { type: "message_end", message: { role: "user", content: "after restart" } }, ctx);
	assert.ok(read(file).endsWith("> [!quote] Learner\n> after restart\n"));
	await command(second.ext, "learn", "close", ctx);
	assert.equal(ctx.ui.status.get("learn-obsidian"), undefined);
	assert.equal(globalThis.__piLearn.linkedNote, null);
	await emit(second.ext, "message_end", { type: "message_end", message: { role: "user", content: "not logged" } }, ctx);
	assert.ok(!read(file).includes("not logged"));
	assert.deepEqual(s.entries.filter((e) => e.customType === "learn-link").at(-1).data, { file: null });
	const unrelated = createSession("23232323-unlinked");
	const unrelatedCtx = makeCtx(unrelated, dir);
	await emit(second.ext, "session_start", { type: "session_start", reason: "switch" }, unrelatedCtx);
	assert.equal(unrelatedCtx.ui.status.get("learn-obsidian"), undefined);
	await emit(second.ext, "message_end", { type: "message_end", message: { role: "user", content: "after session switch" } }, unrelatedCtx);
	assert.ok(!read(file).includes("after session switch"), "an unlinked session cannot write to the prior note");
});

// ─── /learn ──────────────────────────────────────────────────────────────────

test("/learn creates the note + index, links it and starts teaching", async () => {
	const notes = newDir("learn");
	process.env.PI_LEARN_NOTES_DIR = notes;
	const s = createSession("34343434-learn");
	const { ext, calls } = await load(realExtension, s, root);
	const ctx = makeCtx(s, root);

	await command(ext, "learn", "   ", ctx);
	const guide = calls.sendMessage.at(-1);
	assert.equal(guide?.message.customType, "pi-learn-help");
	assert.equal(guide?.message.display, true);
	assert.equal(guide?.options?.triggerTurn, false, "help must not interrupt a running model turn");
	for (const usage of ["/learn <topic>", "/learn new", "/learn open", "/learn search", "/learn resume", "/learn status", "/learn close", "/learn obsidian", "/skill:teach", "/skill:visualize", "search_commons_images", "Learn Index.md", notes]) {
		assert.ok(guide.message.content.includes(usage), `guide lacks ${usage}`);
	}
	assert.equal(calls.sendUserMessage.length, 0, "help never starts the model");
	assert.equal(readdirSync(notes).filter((name) => name.endsWith(".md")).length, 0, "help never creates a note");
	const actions = ext.commands.get("learn").getArgumentCompletions("");
	assert.deepEqual(actions.map((a) => a.label), ["new", "open", "search", "resume", "status", "close", "obsidian", "help"]);
	await command(ext, "learn", "help", ctx);
	assert.equal(calls.sendMessage.at(-1).message.customType, "pi-learn-help");
	const busy = makeCtx(s, root, { idle: false });
	await command(ext, "learn", "Anything", busy);
	assert.equal(busy.ui.notices.at(-1).level, "warning");
	assert.equal(readdirSync(notes).filter((name) => name.endsWith(".md")).length, 0);

	await command(ext, "learn", "How does TCP/IP work?", ctx);
	const file = join(notes, "How does TCP IP work.md");
	assert.ok(existsSync(file), readdirSync(notes).join(", "));
	const text = read(file);
	const fm = readFrontmatter(text);
	assert.equal(fm["learn-topic"], "How does TCP/IP work?");
	assert.deepEqual(fm.tags, ["learn"]);
	assert.deepEqual(fm.cssclasses, ["pi-learn"]);
	assert.equal(splitFrontmatter(text).body, `## Session 1 (${today()})\n${marker(s.sessionId)}\n`);
	assert.deepEqual(calls.sendUserMessage.map((c) => c.content), ["Teach me: How does TCP/IP work?"]);
	assert.equal(ctx.ui.status.get("learn-obsidian"), "🗒 How does TCP IP work.md");
	const index = read(join(notes, "Learn Index.md"));
	assert.match(index, /\| \[\[How does TCP IP work\]\] \| How does TCP\/IP work\? \| active \| 1 \| \d{4}-\d{2}-\d{2} \d{2}:\d{2} \|/);
	assert.ok(!index.includes("[[Learn Index]]"));
	// the teaching turn is logged live into the new section
	await emit(ext, "message_end", { type: "message_end", message: { role: "user", content: "Teach me: How does TCP/IP work?" } }, ctx);
	assert.ok(read(file).endsWith(`${marker(s.sessionId)}\n\n\n> [!quote] Learner\n> Teach me: How does TCP/IP work?\n`));
});

test("/learn uses a personal notes directory when Pi is started outside the vault", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousNotesDir = process.env.PI_LEARN_NOTES_DIR;
	const agentDir = newDir("agent-config");
	const notes = newDir("configured-notes");
	try {
		delete process.env.PI_LEARN_NOTES_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "pi-learn.json"), JSON.stringify({ notesDir: notes }));
		const s = createSession("45454545-configured");
		const { ext, calls } = await load(realExtension, s, root);
		const ctx = makeCtx(s, root);
		await command(ext, "learn", "", ctx);
		assert.ok(calls.sendMessage.at(-1).message.content.includes(notes));
		await command(ext, "learn", "Control loops", ctx);
		assert.ok(existsSync(join(notes, "Control loops.md")));
		assert.ok(existsSync(join(notes, "Learn Index.md")));
		assert.ok(!existsSync(join(root, "Control loops.md")));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousNotesDir === undefined) delete process.env.PI_LEARN_NOTES_DIR;
		else process.env.PI_LEARN_NOTES_DIR = previousNotesDir;
	}
});

test("/learn on an existing note resumes it instead of overwriting", async () => {
	const notes = newDir("learn-existing");
	process.env.PI_LEARN_NOTES_DIR = notes;
	const file = join(notes, "Binary search trees.md");
	const original = read(join(fixturesDir, "previous-session.md"));
	writeFileSync(file, original);
	const s = createSession("56565656-learn-existing");
	const { ext, calls } = await load(realExtension, s, root);
	const ctx = makeCtx(s, root);
	await command(ext, "learn", "Binary search trees", ctx);
	const text = read(file);
	assert.ok(splitFrontmatter(text).body.startsWith(splitFrontmatter(original).body));
	assert.ok(text.includes(`## Session 2 (${today()})\n${marker(s.sessionId)}\nContinues [[#Session 1 (2026-09-20)]].\n`));
	assert.equal(calls.sendUserMessage.length, 0, "no fresh 'Teach me' on resume");
	assert.equal(calls.sendMessage.length, 1);
	assert.equal(calls.sendMessage[0].message.customType, "learn-resume");
});

// ─── /learn-resume ───────────────────────────────────────────────────────────

test("/learn-resume <note> in an empty session: new section, index, hidden brief with triggerTurn", async () => {
	const notes = newDir("resume-arg");
	process.env.PI_LEARN_NOTES_DIR = notes;
	const file = join(notes, "Binary search trees.md");
	writeFileSync(file, read(join(fixturesDir, "previous-session.md")));
	const s = createSession("78787878-resume-arg");
	const { ext, calls } = await load(realExtension, s, root);
	const ctx = makeCtx(s, root);
	await command(ext, "learn-resume", "Binary search trees", ctx); // basename without .md
	const text = read(file);
	const sections = findSessionSections(text);
	assert.equal(sections.length, 2);
	assert.equal(sections[1].continues, `Continues [[#${sections[0].heading}]].`);
	assert.equal(sections[1].continues, "Continues [[#Session 1 (2026-09-20)]].");
	assert.equal(calls.sendMessage.length, 1);
	const { message, options } = calls.sendMessage[0];
	assert.equal(message.customType, "learn-resume");
	assert.equal(message.display, false);
	assert.deepEqual(options, { triggerTurn: true });
	for (const needle of [
		"Topic: Binary search trees",
		"- Session 1 (2026-09-20)",
		"A[Ordering] --> B[BST invariant] --> C[Search]",
		"[correct] What does the BST invariant say about the left subtree?",
		"MY OWN NOTE",
		"Do not restart the probe from scratch",
	]) {
		assert.ok(message.content.includes(needle), `brief lacks ${needle}`);
	}
	assert.ok(read(join(notes, "Learn Index.md")).includes("| [[Binary search trees]] | Binary search trees | active | 2 |"));
	assert.equal(ctx.ui.prompts, 0);
	// the brief is a custom message: never logged
	await emit(ext, "message_end", { type: "message_end", message: { role: "custom", customType: "learn-resume", content: message.content, display: false } }, ctx);
	assert.equal(read(file), text);
});

test("/learn-resume without args picks the latest note and continues in a fresh session when this one has a conversation", async () => {
	const notes = newDir("resume-latest");
	process.env.PI_LEARN_NOTES_DIR = notes;
	const older = join(notes, "Older topic.md");
	const newer = join(notes, "Binary search trees.md");
	writeFileSync(older, '---\nlearn-topic: "Older"\nlearn-updated: 2026-09-01T09:00\n---\n## Session 1 (2026-09-01)\n%% learn-session: 99999999-x %%\n');
	writeFileSync(newer, read(join(fixturesDir, "previous-session.md"))); // learn-updated 2026-09-20T10:30
	writeFileSync(join(notes, "Not a learning note.md"), "just text");
	const future = new Date(2030, 0, 1);
	utimesSync(older, future, future); // mtime must not beat frontmatter learn-updated

	const oldSession = fillLesson(createSession("90909090-old"));
	const first = await load(realExtension, oldSession, root);
	const freshSession = createSession("a1a1a1a1-fresh");
	let second;
	let freshCtx;
	const ctx = makeCtx(oldSession, root, {
		onNewSession: async ({ setup, withSession }) => {
			// what pi does: invalidate the old runtime, load a new one, setup, session_start, withSession
			first.runtime.invalidate();
			second = await load(realExtension, freshSession, root);
			await setup?.(freshSession.manager);
			freshCtx = makeCtx(freshSession, root);
			await emit(second.ext, "session_start", { type: "session_start", reason: "new" }, freshCtx);
			const replaced = {
				...freshCtx,
				sendMessage: async (message, options) => second.calls.sendMessage.push({ message, options, via: "fresh-ctx" }),
				sendUserMessage: async () => {},
			};
			await withSession?.(replaced);
			return { cancelled: false };
		},
	});
	await command(first.ext, "learn-resume", "", ctx);
	assert.ok(second, "a fresh session was started");
	assert.equal(first.calls.sendMessage.length, 0, "stale pi is not used");
	assert.equal(second.calls.sendMessage.length, 1);
	assert.equal(second.calls.sendMessage[0].via, "fresh-ctx");
	assert.deepEqual(second.calls.sendMessage[0].options, { triggerTurn: true });
	assert.equal(read(older).includes("a1a1a1a1"), false, "picked the note with the newest learn-updated");
	const text = read(newer);
	assert.ok(text.includes(`## Session 2 (${today()})\n${marker(freshSession.sessionId)}\nContinues [[#Session 1 (2026-09-20)]].\n`));
	assert.ok(!text.includes(oldSession.sessionId), "the old session is not written into the note");
	assert.equal(freshSession.entries.filter((e) => e.customType === "learn-link").length, 1, "link persisted once in the new session");
	assert.equal(freshCtx.ui.status.get("learn-obsidian"), "🗒 Binary search trees.md");
	// the new session keeps logging into the note
	await emit(second.ext, "message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Welcome back." }] } }, freshCtx);
	assert.ok(read(newer).endsWith("Welcome back.\n"));
	const index = read(join(notes, "Learn Index.md"));
	const rows = index.split("\n").filter((l) => l.startsWith("| [["));
	assert.equal(rows.length, 2, "only learning notes, not the index or plain notes");
	assert.ok(rows[0].startsWith("| [[Binary search trees]]"), "newest first");
});

test("/learn-resume missing-note warns and never prompts", async () => {
	const notes = newDir("resume-missing");
	process.env.PI_LEARN_NOTES_DIR = notes;
	const s = createSession("b2b2b2b2-missing");
	const { ext, calls } = await load(realExtension, s, root);
	const ctx = makeCtx(s, root);
	await command(ext, "learn-resume", "missing-note", ctx);
	assert.equal(ctx.ui.notices.length, 1);
	assert.equal(ctx.ui.notices[0].level, "warning");
	assert.match(ctx.ui.notices[0].message, /No Markdown notes/);
	await command(ext, "learn-resume", "", ctx); // empty notes dir
	assert.equal(ctx.ui.notices[1].level, "warning");
	assert.match(ctx.ui.notices[1].message, /No learning notes/);
	assert.equal(ctx.ui.prompts, 0);
	assert.equal(calls.sendMessage.length, 0);
	assert.deepEqual(readdirSync(notes), [".obsidian"]);
});

test("/learn search browses plain Markdown notes with a picker and title completions", async () => {
	const notes = newDir("search");
	process.env.PI_LEARN_NOTES_DIR = notes;
	const nested = join(notes, "Hardware");
	mkdirSync(nested);
	const packaging = join(nested, "Silicon Packaging.md");
	const other = join(nested, "Package Tools.md");
	writeFileSync(packaging, "# Package anatomy\n\nLearner note.\n");
	writeFileSync(other, "# Package tools\n");
	const s = createSession("d4d4d4d4-search");
	s.message({ role: "user", content: "Private conversation before searching" });
	const { ext } = await load(realExtension, s, notes);
	const ctx = makeCtx(s, notes);
	const choices = [];
	ctx.ui.select = async (_title, options) => {
		choices.push(options);
		return "Hardware/Silicon Packaging.md";
	};
	assert.equal(ext.commands.has("md-log"), false);
	assert.equal(ext.commands.has("md-unlog"), false);
	const completions = ext.commands.get("learn").getArgumentCompletions("search silicon");
	assert.equal(completions.length, 1);
	assert.equal(completions[0].value, 'search "Hardware/Silicon Packaging.md"');
	await command(ext, "learn", "search", ctx);
	assert.deepEqual(new Set(choices[0]), new Set(["Hardware/Package Tools.md", "Hardware/Silicon Packaging.md"]));
	assert.equal(globalThis.__piLearn.linkedNote, packaging);
	assert.equal(s.entries.filter((e) => e.customType === "learn-link").at(-1).data.file, packaging);
	assert.ok(read(packaging).includes("Learner note.\n"), "the existing note is preserved");
	assert.ok(read(packaging).includes(marker(s.sessionId)), "session is linked to the note");
	assert.ok(!read(packaging).includes("Private conversation before searching"), "prior Pi conversation is not copied into a newly opened note");
	assert.match(read(join(notes, "Learn Index.md")), /\[\[Hardware\/Silicon Packaging\]\]/, "nested learning notes appear in the index");
});

test("old md-log session entries restore into the new Obsidian link and /learn close supersedes them", async () => {
	const dir = newDir("legacy-link");
	const note = join(dir, "Legacy.md");
	writeFileSync(note, "# Learner notes\n");
	const s = createSession("e5e5e5e5-legacy");
	s.custom("md-log", { file: note });
	const { ext } = await load(realExtension, s, dir);
	const ctx = makeCtx(s, dir);
	await emit(ext, "session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.equal(ctx.ui.status.get("learn-obsidian"), "🗒 Legacy.md");
	await emit(ext, "message_end", { type: "message_end", message: { role: "user", content: "A new observation" } }, ctx);
	assert.ok(read(note).includes("A new observation"));
	await command(ext, "learn", "close", ctx);
	assert.equal(s.entries.at(-1).customType, "learn-link");
	assert.equal(s.entries.at(-1).data.file, null);
	const restarted = await load(realExtension, s, dir);
	const restartCtx = makeCtx(s, dir);
	await emit(restarted.ext, "session_start", { type: "session_start", reason: "startup" }, restartCtx);
	assert.equal(globalThis.__piLearn.linkedNote, null);
});

test("quiz question never leaks the correct answer or explanation before the answer", async () => {
	const dir = newDir("leak");
	const file = join(dir, "n.md");
	writeFileSync(file, "");
	const s = createSession("c3c3c3c3-leak");
	const { ext } = await load(realExtension, s, dir);
	const ctx = makeCtx(s, dir);
	await open(ext, file, ctx);
	const [, update] = liveLessonEvents().find(([n]) => n === "tool_execution_update");
	await emit(ext, "tool_execution_update", update, ctx);
	const text = read(file);
	assert.ok(text.includes(QUIZ_ARGS.question));
	assert.ok(!text.includes("SECRET-EXPLANATION"));
	assert.ok(!text.includes("Correct answer"));
});
