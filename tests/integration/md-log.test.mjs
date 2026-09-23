// Integration tests for extensions/md-log.ts, loaded through pi's real extension loader
// and driven with fake events and a fake command context.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPiLoader, repoRoot } from "../helpers/pi.mjs";
import { formatDate, readFrontmatter, splitFrontmatter, findSessionSections, HIDDEN_DIAGRAM_CALLOUT } from "../../extensions/lib/learn-notes.ts";
import {
	ASK_ARGS,
	INVALID_MERMAID,
	QUIZ_ARGS,
	VALID_MERMAID,
	createSession,
	fillLesson,
	liveLessonEvents,
} from "../fixtures/md-log/session.mjs";

const fixturesDir = join(repoRoot, "tests", "fixtures", "md-log");
const realExtension = join(repoRoot, "extensions", "md-log.ts");
const ALLOWED_LEVELS = new Set([undefined, "info", "warning", "error"]);

let loader;
let root;
let originalExtension; // md-log.ts from git HEAD (Amos's original)
let stubExtension; // real md-log.ts copied next to stub lib/mermaid.ts + lib/obsidian-style.ts
const savedEnv = process.env.PI_LEARN_NOTES_DIR;

before(async () => {
	loader = await importPiLoader();
	root = mkdtempSync(join(tmpdir(), "pi-learn-md-log-"));
	// Original extension, straight from git.
	const origDir = join(root, "orig-ext");
	mkdirSync(origDir);
	originalExtension = join(origDir, "md-log.ts");
	writeFileSync(originalExtension, execFileSync("git", ["show", "HEAD:extensions/md-log.ts"], { cwd: repoRoot, encoding: "utf8" }));
	// Same code, but with deterministic stand-ins for the modules other work packages own.
	const stubDir = join(root, "stub-ext");
	mkdirSync(join(stubDir, "lib"), { recursive: true });
	stubExtension = join(stubDir, "md-log.ts");
	copyFileSync(realExtension, stubExtension);
	copyFileSync(join(repoRoot, "extensions", "lib", "learn-notes.ts"), join(stubDir, "lib", "learn-notes.ts"));
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
		`export async function ensureLearnStyle(notePath: string) {
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

test("live logging: block formats are byte-identical to the original md-log", async () => {
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
	await command(mine.ext, "md-log", newFile, ctx2);
	for (const [name, event] of liveLessonEvents()) {
		await emit(orig.ext, name, event, ctx1);
		await emit(mine.ext, name, event, ctx2);
	}
	const o = read(origFile);
	const n = read(newFile);
	assert.ok(o.includes("> [!question] Quiz\n> Why does binary search need a sorted array?"), "sanity: original logged the quiz");
	assert.equal(afterMarker(n, s2.sessionId), `\n\n${o}`, "same blocks, same separators");
	assert.ok(!n.includes("SECRET-EXPLANATION: one comparison") || n.indexOf("SECRET") > n.indexOf("Quiz — correct"), "explanation only after answering");
	assert.ok(!n.includes("BRIEF-SHOULD-NOT-BE-LOGGED"));
	// true shuffled order, logged once despite two updates
	assert.equal(n.split("> [!question] Quiz\n").length - 1, 1);
	assert.ok(n.includes("> 1. It does not\n> 2. To discard half\n> 3. To use less memory"));
});

test("backfill: block formats are byte-identical to the original md-log", async () => {
	const dir = newDir("backfill");
	const origFile = join(dir, "orig.md");
	const newFile = join(dir, "new.md");
	writeFileSync(origFile, "");
	writeFileSync(newFile, "");
	const s1 = fillLesson(createSession("aaaaaaaa-bf-orig"));
	const s2 = fillLesson(createSession("bbbbbbbb-bf-new"));
	const orig = await load(originalExtension, s1, dir);
	const mine = await load(realExtension, s2, dir);
	const ctx1 = makeCtx(s1, dir, { anyLevel: true }); // the original notifies "success"
	const ctx2 = makeCtx(s2, dir);
	await command(orig.ext, "md-log", origFile, ctx1);
	await command(mine.ext, "md-log", newFile, ctx2);
	const o = read(origFile);
	const n = read(newFile);
	assert.ok(o.includes("> [!note] SKILL loaded: teach"));
	assert.equal(afterMarker(n, s2.sessionId), `\n${o}`);
	assert.equal(ctx2.ui.notices.at(-1).level, "info", "success notify replaced by info");
	assert.match(ctx2.ui.notices.at(-1).message, /Linked: .*new\.md → Session 1 \(\d{4}-\d{2}-\d{2}\) \(\d+ entries backfilled\)/);
});

// ─── linking ─────────────────────────────────────────────────────────────────

test("/md-log requires an existing file; /md-log twice in one session is idempotent", async () => {
	const dir = newDir("idem");
	const file = join(dir, "Linear algebra.md");
	const s = fillLesson(createSession("cccccccc-idem"));
	const { ext } = await load(realExtension, s, dir);
	const ctx = makeCtx(s, dir);
	await command(ext, "md-log", "missing.md", ctx);
	assert.equal(ctx.ui.notices.at(-1).level, "error");
	assert.ok(!existsSync(join(dir, "missing.md")), "never creates the file");

	writeFileSync(file, "");
	await command(ext, "md-log", file, ctx);
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

	await command(ext, "md-log", file, ctx);
	assert.equal(normalizeUpdated(read(file)), normalizeUpdated(first), "re-link regenerates the same section");
	// the link is persisted, and shared with other extensions
	assert.equal(s.entries.filter((e) => e.customType === "md-log").length, 2);
	assert.equal(globalThis.__piLearn.linkedNote, file);
	assert.equal(ctx.ui.status.get("md-log"), "🗒 Linear algebra.md");
});

test("/md-log on a note with a previous session keeps it (and the learner's text) byte-for-byte", async () => {
	const dir = newDir("prev");
	const file = join(dir, "Binary search trees.md");
	const original = read(join(fixturesDir, "previous-session.md"));
	writeFileSync(file, original);
	const s = fillLesson(createSession("dddddddd-prev"));
	const { ext } = await load(realExtension, s, dir);
	const ctx = makeCtx(s, dir);
	await command(ext, "md-log", file, ctx);
	const after = read(file);
	const before = splitFrontmatter(original);
	const now = splitFrontmatter(after);
	assert.ok(now.body.startsWith(before.body), "old sessions + learner text are a byte-for-byte prefix");
	assert.ok(now.body.slice(before.body.length).startsWith(`\n## Session 2 (${today()})\n${marker(s.sessionId)}\n\n> [!quote] YOU`));
	assert.ok(!now.body.includes("Continues [[#"), "plain /md-log is not a resume");
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
	writeFileSync(bfFile, "");
	const s1 = createSession("eeeeeeee-blocked-live");
	const live = await load(realExtension, s1, dir);
	const ctx1 = makeCtx(s1, dir);
	await command(live.ext, "md-log", liveFile, ctx1);
	for (const [name, event] of liveLessonEvents({ withBlocked: true })) await emit(live.ext, name, event, ctx1);
	const s2 = fillLesson(createSession("ffffffff-blocked-bf"), { withBlocked: true });
	const bf = await load(realExtension, s2, dir);
	await command(bf.ext, "md-log", bfFile, makeCtx(s2, dir));
	for (const text of [read(liveFile), read(bfFile)]) {
		assert.ok(!text.includes("BLOCKED"), "no question/answer for the blocked call");
		assert.equal(text.split("> [!question] Quiz\n").length - 1, 1, "only the real quiz");
		assert.equal(text.split("Quiz — ").length - 1, 1, "only the real answer");
		assert.equal(text.split("> [!question] Question\n").length - 1, 1);
		assert.ok(text.includes(`> [!question] Question\n> ${ASK_ARGS.question}\n>\n> 1. Proofs\n> 2. Code`));
	}
});

test("invalid Mermaid is hidden in the note (live + backfill); valid Mermaid is untouched; style installer warns once", async () => {
	globalThis.__stubStyleCalls = [];
	const dir = newDir("mermaid");
	const liveFile = join(dir, "live.md");
	const bfFile = join(dir, "backfill.md");
	writeFileSync(liveFile, "");
	writeFileSync(bfFile, "");
	const s1 = createSession("abababab-mermaid-live");
	const live = await load(stubExtension, s1, dir);
	const ctx1 = makeCtx(s1, dir);
	await command(live.ext, "md-log", liveFile, ctx1);
	for (const [name, event] of liveLessonEvents({ withMermaid: true })) await emit(live.ext, name, event, ctx1);
	const s2 = fillLesson(createSession("cdcdcdcd-mermaid-bf"), { withMermaid: true });
	const bf = await load(stubExtension, s2, dir);
	const ctx2 = makeCtx(s2, dir);
	await command(bf.ext, "md-log", bfFile, ctx2);
	const expected = `Here is the plan.\n\n${VALID_MERMAID}\n\nAnd a broken one:\n\n${HIDDEN_DIAGRAM_CALLOUT}\n\n%%\n${INVALID_MERMAID}\n%%\n\nDone.`;
	for (const text of [read(liveFile), read(bfFile)]) {
		assert.ok(text.includes(`> [!abstract] PI\n\n${expected}`), text);
	}
	assert.ok(globalThis.__stubMermaidCalls > 0, "validator module was imported dynamically");
	// ensureLearnStyle: called on link, "customized" → exactly one warning per session
	assert.ok(await waitFor(() => ctx1.ui.notices.some((n) => n.level === "warning")));
	await command(live.ext, "md-log", liveFile, ctx1);
	await waitFor(() => globalThis.__stubStyleCalls.length >= 3);
	await new Promise((r) => setTimeout(r, 50));
	assert.ok(globalThis.__stubStyleCalls.includes(liveFile));
	assert.equal(ctx1.ui.notices.filter((n) => n.level === "warning").length, 1, "warned once");
	assert.equal(ctx1.ui.notices.find((n) => n.level === "warning").message, "pi-learn.css was customized; not overwriting");
});

test("session_start restores the link; /md-unlog stops logging", async () => {
	const dir = newDir("restore");
	const file = join(dir, "note.md");
	writeFileSync(file, "");
	const s = createSession("12121212-restore");
	const first = await load(realExtension, s, dir);
	await command(first.ext, "md-log", file, makeCtx(s, dir));
	// a restarted pi: fresh instance, same session entries
	const second = await load(realExtension, s, dir);
	const ctx = makeCtx(s, dir);
	globalThis.__piLearn.linkedNote = null;
	await emit(second.ext, "session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.equal(ctx.ui.status.get("md-log"), "🗒 note.md");
	assert.equal(globalThis.__piLearn.linkedNote, file);
	await emit(second.ext, "message_end", { type: "message_end", message: { role: "user", content: "after restart" } }, ctx);
	assert.ok(read(file).endsWith("> [!quote] YOU\n\nafter restart\n"));
	await command(second.ext, "md-unlog", "", ctx);
	assert.equal(ctx.ui.status.get("md-log"), undefined);
	assert.equal(globalThis.__piLearn.linkedNote, null);
	await emit(second.ext, "message_end", { type: "message_end", message: { role: "user", content: "not logged" } }, ctx);
	assert.ok(!read(file).includes("not logged"));
	assert.deepEqual(s.entries.filter((e) => e.customType === "md-log").at(-1).data, { file: null });
});

// ─── /learn ──────────────────────────────────────────────────────────────────

test("/learn creates the note + index, links it and starts teaching", async () => {
	const notes = newDir("learn");
	process.env.PI_LEARN_NOTES_DIR = notes;
	const s = createSession("34343434-learn");
	const { ext, calls } = await load(realExtension, s, root);
	const ctx = makeCtx(s, root);

	await command(ext, "learn", "   ", ctx);
	assert.deepEqual(ctx.ui.notices.at(-1), { message: "Usage: /learn <topic>", level: "warning" });
	const busy = makeCtx(s, root, { idle: false });
	await command(ext, "learn", "Anything", busy);
	assert.equal(busy.ui.notices.at(-1).level, "warning");
	assert.equal(readdirSync(notes).length, 0);

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
	assert.equal(ctx.ui.status.get("md-log"), "🗒 How does TCP IP work.md");
	const index = read(join(notes, "Learn Index.md"));
	assert.match(index, /\| \[\[How does TCP IP work\]\] \| How does TCP\/IP work\? \| active \| 1 \| \d{4}-\d{2}-\d{2} \d{2}:\d{2} \|/);
	assert.ok(!index.includes("[[Learn Index]]"));
	// the teaching turn is logged live into the new section
	await emit(ext, "message_end", { type: "message_end", message: { role: "user", content: "Teach me: How does TCP/IP work?" } }, ctx);
	assert.ok(read(file).endsWith(`${marker(s.sessionId)}\n\n\n> [!quote] YOU\n\nTeach me: How does TCP/IP work?\n`));
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
	assert.equal(freshSession.entries.filter((e) => e.customType === "md-log").length, 1, "link persisted once in the new session");
	assert.equal(freshCtx.ui.status.get("md-log"), "🗒 Binary search trees.md");
	// the new session keeps logging into the note
	await emit(second.ext, "message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Welcome back." }] } }, freshCtx);
	assert.ok(read(newer).endsWith("> [!abstract] PI\n\nWelcome back.\n"));
	const index = read(join(notes, "Learn Index.md"));
	const rows = index.split("\n").filter((l) => l.startsWith("| [["));
	assert.equal(rows.length, 2, "only learning notes, not the index or plain notes");
	assert.ok(rows[0].startsWith("| [[Binary search trees]]"), "newest first");
});

test("/learn-resume missing-note reports an error and never prompts", async () => {
	const notes = newDir("resume-missing");
	process.env.PI_LEARN_NOTES_DIR = notes;
	const s = createSession("b2b2b2b2-missing");
	const { ext, calls } = await load(realExtension, s, root);
	const ctx = makeCtx(s, root);
	await command(ext, "learn-resume", "missing-note", ctx);
	assert.equal(ctx.ui.notices.length, 1);
	assert.equal(ctx.ui.notices[0].level, "error");
	assert.match(ctx.ui.notices[0].message, /missing-note/);
	await command(ext, "learn-resume", "", ctx); // empty notes dir
	assert.equal(ctx.ui.notices[1].level, "error");
	assert.match(ctx.ui.notices[1].message, /No learning notes/);
	assert.equal(ctx.ui.prompts, 0);
	assert.equal(calls.sendMessage.length, 0);
	assert.deepEqual(readdirSync(notes), []);
});

test("quiz question never leaks the correct answer or explanation before the answer", async () => {
	const dir = newDir("leak");
	const file = join(dir, "n.md");
	writeFileSync(file, "");
	const s = createSession("c3c3c3c3-leak");
	const { ext } = await load(realExtension, s, dir);
	const ctx = makeCtx(s, dir);
	await command(ext, "md-log", file, ctx);
	const [, update] = liveLessonEvents().find(([n]) => n === "tool_execution_update");
	await emit(ext, "tool_execution_update", update, ctx);
	const text = read(file);
	assert.ok(text.includes(QUIZ_ARGS.question));
	assert.ok(!text.includes("SECRET-EXPLANATION"));
	assert.ok(!text.includes("Correct answer"));
});
