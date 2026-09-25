// Loads the REAL system-diagrams extension through pi's own loader (jiti + aliases)
// and drives its handlers with scripted events and a scripted classifier model.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { importPiLoader, repoRoot } from "../helpers/pi.mjs";

const extensionPath = resolve(repoRoot, "extensions", "system-diagrams.ts");
const { loadExtensions, createExtensionRuntime } = await importPiLoader();

async function load() {
	const loaded = await loadExtensions([extensionPath], mkdtempSync(join(tmpdir(), "pi-learn-sd-")), undefined, createExtensionRuntime());
	assert.equal(loaded.errors.length, 0, loaded.errors.map((e) => e.error).join("; "));
	return loaded.extensions[0];
}

const LONG_SYSTEM_PROSE =
	"Your body keeps blood glucose near a set point. Beta cells in the pancreas sense a rise after a meal and release insulin; insulin tells liver, muscle and fat cells to take glucose up and store it as glycogen. When glucose falls, alpha cells release glucagon, which tells the liver to break glycogen down and release glucose. The result is a negative-feedback loop: every correction reduces the signal that caused it, so the level settles back toward the set point instead of running away.";

function harness(ext, classifierReplies) {
	const calls = [];
	const replies = [...classifierReplies];
	const ctx = {
		model: { id: "m", provider: "p", api: "openai-completions" },
		modelRegistry: {
			streamSimple(model, context, options) {
				calls.push({ model, context, options });
				const next = replies.shift();
				return {
					result: async () => {
						if (next instanceof Error) throw next;
						return { role: "assistant", content: [{ type: "text", text: next ?? "" }], stopReason: "stop" };
					},
				};
			},
		},
		sessionManager: { getBranch: () => [], getSessionId: () => "sess-123" },
		ui: { notify() {}, setStatus() {} },
		hasUI: true,
		cwd: tmpdir(),
	};
	const emit = async (type, event) => {
		let result;
		for (const handler of ext.handlers.get(type) || []) {
			const r = await handler({ type, ...event }, ctx);
			if (r !== undefined) result = r;
		}
		return result;
	};
	const assistant = async (text, toolCalls = []) =>
		emit("message_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text }, ...toolCalls.map((id) => ({ type: "toolCall", id, name: "quiz", arguments: {} }))],
			},
		});
	const quiz = (id, toolName = "quiz") => emit("tool_call", { toolName, toolCallId: id, input: {} });
	return { ctx, calls, emit, assistant, quiz };
}

const verdict = (v, extra = {}) =>
	JSON.stringify({ teaches: true, concept: "Blood-glucose regulation", features: [1, 3, 6], verdict: v, covered: false, reason: "r", ...extra });

test("the policy is injected as a structured system-prompt section on every run", async () => {
	const ext = await load();
	const h = harness(ext, []);
	const event = { prompt: "teach me", systemPrompt: "", systemPromptOptions: { sections: {} } };
	await h.emit("before_agent_start", event);
	assert.match(event.systemPromptOptions.sections.system_diagrams, /SYSTEMS GET A MERMAID DIAGRAM BY DEFAULT/);
	assert.equal(event.systemPromptOptions.sections.lesson_presentation, undefined, "unlinked Pi sessions keep their own presentation");
	h.ctx.sessionManager.getEntries = () => [{ type: "custom", customType: "learn-link", data: { file: "C:/vault/Learn/Topic.md" } }];
	const linkedEvent = { prompt: "teach me", systemPrompt: "", systemPromptOptions: { sections: {} } };
	await h.emit("before_agent_start", linkedEvent);
	assert.match(linkedEvent.systemPromptOptions.sections.lesson_presentation, /clear, self-contained book section/);
	assert.match(linkedEvent.systemPromptOptions.sections.lesson_presentation, /Do not expose private reasoning/);
	assert.match(linkedEvent.systemPromptOptions.sections.lesson_presentation, /approval of the Learning path/);
	assert.match(linkedEvent.systemPromptOptions.sections.lesson_presentation, /Never write an approval or check question as bare prose/);
	assert.match(linkedEvent.systemPromptOptions.sections.lesson_presentation, /one substantial concept section/);
	assert.match(linkedEvent.systemPromptOptions.sections.lesson_presentation, /one or two diagnostic quiz checks/);
	assert.match(linkedEvent.systemPromptOptions.sections.lesson_presentation, /save concept diagrams and teaching sections until the learner approves the path/);
	assert.match(linkedEvent.systemPromptOptions.sections.lesson_presentation, /on a generic "Continue," advance to its next concept/);
});

test("an undiagrammed system explanation holds back its quiz once, then the diagram unlocks it", async () => {
	const ext = await load();
	const h = harness(ext, [verdict("clearly")]);
	await h.emit("session_start", { reason: "startup" });
	await h.emit("agent_start", {});
	await h.assistant(LONG_SYSTEM_PROSE, ["q1", "q2"]);
	const first = await h.quiz("q1");
	assert.equal(first?.block, true);
	assert.match(first.reason, /Blood-glucose regulation/);
	assert.match(first.reason, /%% system: Blood-glucose regulation — overview/);
	const sibling = await h.quiz("q2");
	assert.equal(sibling?.block, true, "every gated call of the same message is held back");
	assert.equal(h.calls.length, 1, "the classifier runs once per message");
	assert.equal(h.calls[0].options.reasoning, "minimal");
	assert.equal(h.calls[0].options.sessionId, "sess-123", "providers like opencode-go reject nested calls without the session id");
	assert.match(h.calls[0].context.systemPrompt, /structural features/i);

	await h.assistant("Here is the loop — follow the arrows from the pancreas out and back.\n\n```mermaid\nflowchart LR\n%% system: Blood-glucose regulation — overview\n  g[\"Blood glucose\"] -->|rises| b[\"Beta cells\"]\n  b -->|insulin| l[\"Liver, muscle\"]\n  l -->|uptake lowers| g\n```", ["q3"]);
	assert.equal(await h.quiz("q3"), undefined);
	assert.equal(h.calls.filter((c) => /concepts that are systems must be shown with a diagram/i.test(c.context.systemPrompt)).length, 1, "a message with a diagram is never sent to the missing-diagram classifier");
	assert.equal(h.calls.length, 2, "the new concept diagram receives one semantic quality review");
});

test("a dependency map attached to teaching prose does not satisfy the concept-diagram requirement", async () => {
	const ext = await load();
	const h = harness(ext, [verdict("clearly")]);
	await h.emit("agent_start", {});
	await h.assistant(`${LONG_SYSTEM_PROSE}\n\n\x60\x60\x60mermaid\nflowchart LR\n%% dependency-map\n  a["Food"] --> b["Hormones"]\n  b --> c["Review"]\n\x60\x60\x60`, ["plan-only"]);
	const result = await h.quiz("plan-only");
	assert.equal(result?.block, true);
	assert.equal(h.calls.length, 1, "the missing-diagram classifier sees prose with only a dependency map");
});

test("a proposed learning path waits for approval without a concept-diagram follow-up, then teaching is still checked", async () => {
	const ext = await load();
	const h = harness(ext, [verdict("clearly")]);
	await h.emit("agent_start", {});
	const plan = `## Learning path

We will trace the physical path from a chip package to a circuit board, then look at how each solder ball becomes a joint. The diagram maps the proposed order; the detailed concept diagrams belong beside the explanations after you approve this path.

\x60\x60\x60mermaid
flowchart TD
%% dependency-map
  pads["Board pads"] --> align["Balls align"]
  align --> reflow["Solder melts"]
  reflow --> joint["Solid joint"]
\x60\x60\x60

Does this path fit what you wanted?`;
	await h.assistant(plan);
	assert.equal(await h.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed", context: {} }), undefined);
	assert.equal(h.calls.length, 0, "a plan checkpoint never reaches the missing-diagram classifier");

	await h.assistant(plan, ["approval"]);
	assert.equal(await h.quiz("approval", "ask_user_question"), undefined, "the learner can approve the path without a concept-diagram block");
	assert.equal(h.calls.length, 0);

	await h.assistant(LONG_SYSTEM_PROSE);
	const result = await h.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed", context: {} });
	assert.equal(result?.continue, true, "actual post-plan system teaching still requests its diagram");
	assert.match(result.entries.at(-1).content, /Add the Mermaid diagram now/);
	assert.equal(h.calls.length, 1);
});

test("a malformed dependency map in a learning path still receives a Mermaid syntax repair", async () => {
	const ext = await load();
	const h = harness(ext, []);
	await h.emit("agent_start", {});
	await h.assistant("## Learning path\n\nHere is the proposed order:\n\n```mermaid\nflowchart TD\n%% dependency-map\n  A[Sensor (glucose)] --> B\n```");
	const result = await h.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed", context: {} });
	assert.equal(result?.continue, true);
	assert.match(result.entries.at(-1).content, /failed to parse/);
	assert.equal(h.calls.length, 0, "syntax repair does not require the semantic classifier");
});

test("non-systems, short probes and already-covered systems pass without a diagram", async () => {
	const ext = await load();
	const h = harness(ext, [JSON.stringify({ teaches: true, concept: "prime number", features: [], verdict: "not", covered: false }), verdict("clearly", { covered: true })]);
	await h.emit("agent_start", {});
	await h.assistant("A prime number is a whole number greater than 1 whose only divisors are 1 and itself. ".repeat(6), ["a"]);
	assert.equal(await h.quiz("a"), undefined);
	await h.assistant("Quick check before we start:", ["b"]);
	assert.equal(await h.quiz("b"), undefined);
	assert.equal(h.calls.length, 1, "short probe text is not audited");
	await h.assistant(LONG_SYSTEM_PROSE, ["c"]);
	assert.equal(await h.quiz("c"), undefined, "covered=true means no new diagram is required");
	assert.equal(await h.quiz("unrelated-tool", "read"), undefined);
});

test("possibly-systems are held back too (bias toward drawing); complex asks for overview + zoom-ins", async () => {
	const ext = await load();
	const h = harness(ext, [verdict("possibly"), verdict("complex")]);
	await h.emit("agent_start", {});
	await h.assistant(LONG_SYSTEM_PROSE, ["p"]);
	assert.equal((await h.quiz("p"))?.block, true);
	await h.assistant(LONG_SYSTEM_PROSE + " (more)", ["x"]);
	const complex = await h.quiz("x", "ask_user_question");
	assert.equal(complex?.block, true, "ask_user_question is gated as well");
	assert.match(complex.reason, /overview/);
	assert.match(complex.reason, /zoom-in/);
});

test("classifier failures fail open", async () => {
	const ext = await load();
	const h = harness(ext, [new Error("network down"), "not json at all"]);
	await h.emit("agent_start", {});
	await h.assistant(LONG_SYSTEM_PROSE, ["a"]);
	assert.equal(await h.quiz("a"), undefined);
	await h.assistant(LONG_SYSTEM_PROSE + " again", ["b"]);
	assert.equal(await h.quiz("b"), undefined);
});

test("an invalid diagram holds back the quiz with Mermaid's parse error; repairs are capped per run", async () => {
	const ext = await load();
	const h = harness(ext, []);
	await h.emit("agent_start", {});
	const broken = "See the loop:\n\n```mermaid\nflowchart TD\n%% system: Loop — overview\n  A[Sensor (glucose)] --> B\n```";
	for (const [i, expectBlock] of [[1, true], [2, true], [3, false]]) {
		await h.assistant(broken, [`r${i}`]);
		const r = await h.quiz(`r${i}`);
		assert.equal(r?.block === true, expectBlock, `repair #${i}`);
		if (expectBlock) {
			assert.match(r.reason, /failed to parse/);
			assert.match(r.reason, /Parse error/);
		}
	}
	assert.equal(h.calls.length, 0, "a message that has a diagram is never classified");
});

test("missing-diagram nudges are capped at 3 per run and reset on the next run", async () => {
	const ext = await load();
	const h = harness(ext, Array.from({ length: 6 }, () => verdict("clearly")));
	await h.emit("agent_start", {});
	const outcomes = [];
	for (let i = 0; i < 4; i++) {
		await h.assistant(`${LONG_SYSTEM_PROSE} #${i}`, [`n${i}`]);
		outcomes.push((await h.quiz(`n${i}`))?.block === true);
	}
	assert.deepEqual(outcomes, [true, true, true, false]);
	await h.emit("agent_start", {});
	await h.assistant(`${LONG_SYSTEM_PROSE} next run`, ["m"]);
	assert.equal((await h.quiz("m"))?.block, true);
});

test("a run ending on an undiagrammed system gets exactly one continuation, keeping earlier entries", async () => {
	const ext = await load();
	const h = harness(ext, [verdict("clearly")]);
	await h.emit("agent_start", {});
	await h.assistant(LONG_SYSTEM_PROSE);
	const prior = { type: "custom", customType: "other", data: {} };
	const result = await h.emit("agent_before_settle", { entries: [prior], continue: false, outcome: "completed", context: {} });
	assert.equal(result.continue, true);
	assert.equal(result.entries.length, 2);
	assert.deepEqual(result.entries[0], prior);
	assert.equal(result.entries[1].type, "custom_message");
	assert.equal(result.entries[1].display, false);
	assert.match(result.entries[1].content, /Add the Mermaid diagram now/);
	// Same message again (e.g. model ignored it): no second continuation.
	assert.equal(await h.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed", context: {} }), undefined);
	// Aborted runs are left alone.
	await h.assistant(LONG_SYSTEM_PROSE + " aborted");
	assert.equal(await h.emit("agent_before_settle", { entries: [], continue: false, outcome: "aborted", context: {} }), undefined);
});

test("PI_LEARN_SYSTEM_DIAGRAMS=off disables the extension entirely", async () => {
	process.env.PI_LEARN_SYSTEM_DIAGRAMS = "off";
	try {
		const ext = await load();
		assert.equal(ext.handlers.size, 0);
	} finally {
		delete process.env.PI_LEARN_SYSTEM_DIAGRAMS;
	}
});
