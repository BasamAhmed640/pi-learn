// Exercise the real extension loader with scripted nested-model replies. These
// tests cover the diagram-quality gate where it meets quiz calls and Obsidian notes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { HIDDEN_DIAGRAM_CALLOUT } from "../../extensions/lib/learn-notes.ts";
import { diagramHash } from "../../extensions/lib/diagram-quality.ts";
import { createSession } from "../fixtures/md-log/session.mjs";
import { importPiLoader, repoRoot } from "../helpers/pi.mjs";

const { loadExtensions, createExtensionRuntime } = await importPiLoader();
const systemPath = resolve(repoRoot, "extensions", "system-diagrams.ts");
const obsidianLinkPath = resolve(repoRoot, "extensions", "obsidian-link.ts");
const root = mkdtempSync(join(tmpdir(), "pi-learn-diagram-quality-"));
after(() => rmSync(root, { recursive: true, force: true }));

const issue = (line) => JSON.stringify({
	issues: [{ index: 1, line, kind: "causal", problem: "The sensor does not command the actuator directly.", fix: "Route the command through a controller.", confidence: "high" }],
});
const accepted = JSON.stringify({ issues: [] });

function wrongDiagram(n) {
	const line = `  s${n}["Sensor"] -->|commands| a${n}["Actuator"]`;
	return {
		line,
		text: `The feedback path should show who decides what the actuator does.\n\n\`\`\`mermaid\nflowchart LR\n%% system: Rejected loop ${n} — overview\n${line}\n  a${n} -->|changes| p${n}["Plant"]\n  p${n} -->|measured by| s${n}\n\`\`\``,
	};
}

const disconnected = `These pieces should form the same regulation pathway.\n\n\`\`\`mermaid
flowchart LR
%% system: Glucose regulation — overview
  b["Beta cells"] -->|release| i["Insulin"]
  l["Liver"] -->|stores| g["Glycogen"]
\`\`\``;

const goodDiagram = `Follow the signal through the controller and back from the measured plant.\n\n\`\`\`mermaid
flowchart LR
%% system: Accepted loop — overview
  s["Sensor"] -->|measurement| c["Controller"]
  c -->|command| a["Actuator"]
  a -->|changes| p["Plant"]
  p -->|feedback| s
\`\`\``;

const longSystemProse = "A system has interacting parts and a flow of signals. The sensor measures the plant state, the controller compares that signal with a goal, and the actuator changes the plant in response. The new plant state is measured again, so a later decision depends on the effect of the previous one. This feedback matters because each step changes what the controller sees next. ".repeat(2);

function resetGlobals() {
	delete globalThis.__piLearnDiagramQuality;
	delete globalThis.__piLearnSystemAudit;
	delete globalThis.__piLearn;
}

async function harness({ withNote = false, replies = [], session = createSession(`quality-${Math.random().toString(36).slice(2)}`), reset = true } = {}) {
	if (reset) resetGlobals();
	const dir = mkdtempSync(join(root, "case-"));
	if (withNote) mkdirSync(join(dir, ".obsidian"));
	const runtime = createExtensionRuntime();
	runtime.appendEntry = (customType, data) => session.custom(customType, data);
	const paths = withNote ? [systemPath, obsidianLinkPath] : [systemPath];
	const loaded = await loadExtensions(paths, dir, undefined, runtime);
	assert.equal(loaded.errors.length, 0, loaded.errors.map((e) => e.error).join("; "));
	assert.equal(loaded.extensions.length, paths.length);
	const calls = [];
	const scripted = [...replies];
	const ctx = {
		cwd: dir,
		hasUI: true,
		model: { id: "scripted", provider: "test", api: "openai-completions" },
		modelRegistry: {
			streamSimple(model, context, options) {
				calls.push({ model, context, options });
				const next = scripted.shift();
				return {
					result: async () => {
						if (next instanceof Error) throw next;
						if (next === undefined) throw new Error("Unexpected nested model call");
						const body = typeof next === "function" ? next(context) : next;
						return { role: "assistant", content: [{ type: "text", text: body }], stopReason: "stop" };
					},
				};
			},
		},
		sessionManager: session.manager,
		ui: { theme: { fg: (_color, value) => value }, notify() {}, setStatus() {} },
	};
	async function emit(type, event = {}) {
		let result;
		for (const ext of loaded.extensions) {
			for (const handler of ext.handlers.get(type) || []) {
				const next = await handler({ type, ...event }, ctx);
				if (next !== undefined) result = next;
				if (type === "tool_call" && result?.block) return result;
			}
		}
		return result;
	}
	async function assistant(text, ids = []) {
		const message = {
			role: "assistant",
			content: [{ type: "text", text }, ...ids.map((id) => ({ type: "toolCall", id, name: "quiz", arguments: {} }))],
		};
		// pi has the final message in session state by the time message_end runs.
		session.message(message);
		await emit("message_end", { message });
		return message;
	}
	const quiz = (id) => emit("tool_call", { toolName: "quiz", toolCallId: id, input: {} });
	return { dir, session, extensions: loaded.extensions, calls, ctx, emit, assistant, quiz };
}

async function startNewNote(h, topic) {
	const previous = process.env.PI_LEARN_NOTES_DIR;
	try {
		process.env.PI_LEARN_NOTES_DIR = h.dir;
		await h.extensions[1].commands.get("learn").handler(`new ${topic}`, h.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_LEARN_NOTES_DIR;
		else process.env.PI_LEARN_NOTES_DIR = previous;
	}
}

test("two isolated mapping pairs are rejected without a model review", async () => {
	const h = await harness();
	await h.emit("agent_start");
	await h.assistant(disconnected, ["disconnected-q"]);
	const result = await h.quiz("disconnected-q");
	assert.equal(result?.block, true);
	assert.match(result.reason, /connect|disconnected|relationship/i);
	assert.equal(h.calls.length, 0, "structural rejection does not spend a model call");
});

test("a connected but false causal edge is rejected once for all questions in that message", async () => {
	const bad = wrongDiagram(1);
	const h = await harness({ replies: [issue(bad.line)] });
	await h.emit("agent_start");
	await h.assistant(bad.text, ["causal-q1", "causal-q2"]);
	for (const id of ["causal-q1", "causal-q2"]) {
		const result = await h.quiz(id);
		assert.equal(result?.block, true);
		assert.match(result.reason, /controller|actuator/i);
	}
	assert.equal(h.calls.length, 1, "both calls share the message's review");
	assert.match(JSON.stringify(h.calls[0].context), /Sensor/);
	assert.match(JSON.stringify(h.calls[0].context), /Actuator/);
});

test("concurrent sibling questions share one rejected-diagram decision", async () => {
	const bad = wrongDiagram(41);
	const h = await harness({ replies: [issue(bad.line)] });
	await h.emit("agent_start");
	await h.assistant(bad.text, ["parallel-q1", "parallel-q2"]);
	const results = await Promise.all([h.quiz("parallel-q1"), h.quiz("parallel-q2")]);
	assert.deepEqual(results.map((r) => r?.block), [true, true]);
	assert.equal(results[0].reason, results[1].reason);
	assert.equal(h.calls.length, 1);
});

test("a diagram in one assistant message is reviewed before a quiz in the next message", async () => {
	const bad = wrongDiagram(2);
	const h = await harness({ replies: [issue(bad.line)] });
	await h.emit("agent_start");
	await h.assistant(bad.text);
	await h.assistant("Check whether this loop is wired correctly.", ["later-question"]);
	const result = await h.quiz("later-question");
	assert.equal(result?.block, true);
	assert.match(result.reason, /controller/i);
	assert.equal(h.calls.length, 1);
});

test("a same-tag redraw supersedes a bad draft before the quiz", async () => {
	const bad = wrongDiagram(3);
	const corrected = bad.text.replace(bad.line, `  s3["Sensor"] -->|measurement| c3["Controller"]\n  c3 -->|command| a3["Actuator"]`);
	const h = await harness({ replies: [issue(bad.line), accepted] });
	await h.emit("agent_start");
	await h.assistant(bad.text);
	await h.assistant(corrected, ["after-redraw"]);
	assert.equal(await h.quiz("after-redraw"), undefined);
	assert.equal(h.calls.length, 2);
});

test("quality review failures fail open, and semantic repairs are capped and reset per run", async () => {
	const h = await harness({ replies: [
		new Error("reviewer unavailable"),
		"unparseable reply",
		...[1, 2, 3, 4].map((n) => issue(wrongDiagram(n + 10).line)),
	] });
	await h.emit("agent_start");
	for (const [n, id] of [[8, "unavailable"], [9, "malformed"]]) {
		await h.assistant(wrongDiagram(n).text, [id]);
		assert.equal(await h.quiz(id), undefined, `${id} must not block teaching`);
	}
	for (const [n, expected] of [[11, true], [12, true], [13, false]]) {
		const id = `repair-${n}`;
		await h.assistant(wrongDiagram(n).text, [id]);
		assert.equal((await h.quiz(id))?.block === true, expected, `repair ${n}`);
	}
	await h.emit("agent_start");
	await h.assistant(wrongDiagram(14).text, ["next-run"]);
	assert.equal((await h.quiz("next-run"))?.block, true, "new run resets the cap");
	assert.equal(h.calls.length, 6);
});

test("an unavailable review is retried when a new agent run starts", async () => {
	const bad = wrongDiagram(42);
	const h = await harness({ replies: [new Error("temporary provider failure"), accepted] });
	await h.emit("agent_start");
	await h.assistant(bad.text, ["first-attempt"]);
	assert.equal(await h.quiz("first-attempt"), undefined);
	await h.emit("agent_start");
	await h.assistant(bad.text, ["second-attempt"]);
	assert.equal(await h.quiz("second-attempt"), undefined);
	assert.equal(h.calls.length, 2, "the provider is tried again after the run budget resets");
});

test("note backfill uses the latest saved quality verdict for an identical diagram", async () => {
	const source = /\x60\x60\x60mermaid\n([\s\S]*?)\n\x60\x60\x60/.exec(goodDiagram)?.[1];
	assert.ok(source);
	for (const [statuses, shouldHide] of [[["repair", "pass"], false], [["pass", "repair"], true]]) {
		const session = createSession(`latest-${Math.random().toString(36).slice(2)}`);
		for (const status of statuses) session.custom("diagram-quality", { hash: diagramHash(source), status });
		session.message({ role: "assistant", content: [{ type: "text", text: goodDiagram }] });
		const h = await harness({ withNote: true, session });
		const note = join(h.dir, "latest.md");
		await startNewNote(h, "latest");
		const written = readFileSync(note, "utf8");
		assert.equal(written.includes(HIDDEN_DIAGRAM_CALLOUT), shouldHide, `latest status: ${statuses.at(-1)}`);
	}
});

test("Obsidian note hides a rejected diagram but shows an accepted repair, without a blocked quiz callout", async () => {
	const bad = wrongDiagram(20);
	const h = await harness({ withNote: true, replies: [issue(bad.line), accepted] });
	const note = join(h.dir, "lesson.md");
	writeFileSync(note, "");
	const command = h.extensions[1].commands.get("learn");
	assert.ok(command);
	await command.handler(`open "${note}"`, h.ctx);
	await h.emit("session_start", { reason: "startup" });
	await h.emit("agent_start");
	await h.assistant(bad.text, ["hidden-quiz"]);
	assert.equal((await h.quiz("hidden-quiz"))?.block, true);
	await h.emit("tool_result", { toolName: "quiz", toolCallId: "hidden-quiz", input: {}, isError: true, details: undefined, content: [] });
	await h.assistant(goodDiagram, ["shown-quiz"]);
	assert.equal(await h.quiz("shown-quiz"), undefined);
	const text = readFileSync(note, "utf8");
	assert.ok(text.includes(HIDDEN_DIAGRAM_CALLOUT), "rejected diagram has a visible explanation");
	assert.ok(text.includes(`%%\n${bad.text.slice(bad.text.indexOf("```mermaid"))}\n%%`), "rejected source is commented out");
	assert.ok(text.includes(goodDiagram.slice(goodDiagram.indexOf("```mermaid"))), "accepted diagram renders normally");
	assert.ok(!text.includes("> [!question] Quiz"), "blocked quiz did not reach the note");
});

test("a rejected diagram is still hidden when a new note backfills the session later", async () => {
	const bad = wrongDiagram(21);
	const h = await harness({ withNote: true, replies: [issue(bad.line)] });
	await h.emit("session_start", { reason: "startup" });
	await h.emit("agent_start");
	await h.assistant(bad.text, ["later-quiz"]);
	assert.equal((await h.quiz("later-quiz"))?.block, true);
	await h.emit("agent_settled");
	const note = join(h.dir, "later.md");
	await startNewNote(h, "later");
	const text = readFileSync(note, "utf8");
	assert.ok(text.includes(HIDDEN_DIAGRAM_CALLOUT));
	assert.ok(text.includes(`%%\n${bad.text.slice(bad.text.indexOf("```mermaid"))}\n%%`));
});

test("a fresh session resumes only visible accepted diagrams from the linked note", async () => {
	const bad = wrongDiagram(22);
	const first = await harness({ withNote: true, replies: [issue(bad.line), accepted] });
	const note = join(first.dir, "resume.md");
	writeFileSync(note, "");
	await first.extensions[1].commands.get("learn").handler(`open "${note}"`, first.ctx);
	await first.emit("session_start", { reason: "startup" });
	await first.emit("agent_start");
	await first.assistant(bad.text, ["bad-before-resume"]);
	assert.equal((await first.quiz("bad-before-resume"))?.block, true);
	await first.assistant(goodDiagram, ["good-before-resume"]);
	assert.equal(await first.quiz("good-before-resume"), undefined);
	const fresh = createSession(`fresh-${Math.random().toString(36).slice(2)}`);
	fresh.custom("learn-link", { file: note });
	const classifierReply = JSON.stringify({ teaches: true, concept: "control loop", features: [], verdict: "not", covered: false, reason: "test" });
	const second = await harness({ session: fresh, replies: [classifierReply] });
	await second.emit("session_start", { reason: "startup" });
	await second.emit("agent_start");
	await second.assistant(longSystemProse, ["after-note-resume"]);
	await second.quiz("after-note-resume");
	const input = JSON.stringify(second.calls[0].context);
	assert.match(input, /Accepted loop/);
	assert.doesNotMatch(input, /Rejected loop 22/);
});

test("restart restores only accepted diagrams as prior coverage", async () => {
	const bad = wrongDiagram(30);
	const first = await harness({ replies: [issue(bad.line), accepted] });
	await first.emit("session_start", { reason: "startup" });
	await first.emit("agent_start");
	await first.assistant(bad.text, ["bad-q"]);
	assert.equal((await first.quiz("bad-q"))?.block, true);
	await first.assistant(goodDiagram, ["good-q"]);
	assert.equal(await first.quiz("good-q"), undefined);
	await first.emit("agent_settled");

	const classifierReply = JSON.stringify({ teaches: true, concept: "control loop", features: [], verdict: "not", covered: false, reason: "test" });
	const second = await harness({ session: first.session, reset: false, replies: [classifierReply] });
	await second.emit("session_start", { reason: "startup" });
	await second.emit("agent_start");
	await second.assistant(longSystemProse, ["after-restart"]);
	await second.quiz("after-restart");
	assert.equal(second.calls.length, 1, "substantial diagram-free prose is classified");
	const input = JSON.stringify(second.calls[0].context);
	assert.match(input, /Accepted loop/);
	assert.doesNotMatch(input, /Rejected loop 30/);
});
