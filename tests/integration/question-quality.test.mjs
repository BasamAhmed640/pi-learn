import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importPiLoader, repoRoot } from "../helpers/pi.mjs";

const { loadExtensions, createExtensionRuntime } = await importPiLoader();
const loaded = await loadExtensions(
	[join(repoRoot, "extensions", "quiz.ts"), join(repoRoot, "extensions", "ask-user-question.ts")],
	mkdtempSync(join(tmpdir(), "pi-learn-questions-")),
	undefined,
	createExtensionRuntime(),
);
assert.deepEqual(loaded.errors, []);
const quiz = loaded.extensions.flatMap((ext) => [...ext.tools.values()]).find((tool) => tool.definition.name === "quiz")?.definition;
const ask = loaded.extensions.flatMap((ext) => [...ext.tools.values()]).find((tool) => tool.definition.name === "ask_user_question")?.definition;
assert.ok(quiz && ask);

const question = {
	question: "A trace gets wider while its return path stays narrow. What happens to its impedance?",
	options: [
		{ label: "It falls", value: "falls" },
		{ label: "It rises", value: "rises" },
	],
	correctAnswer: "falls",
	explanation: "A wider trace has lower inductance and higher capacitance per length, so its characteristic impedance falls.",
	shuffle: false,
};
const context = { hasUI: true, ui: { custom: async () => ({ dontKnow: true, answers: [] }) } };

test("invalid quiz calls produce no pre-answer question update", async () => {
	const cases = [
		[{ ...question, question: "   " }, /requires a question/],
		[{ ...question, explanation: "  " }, /requires an explanation/],
		[{ ...question, correctAnswer: "unknown" }, /does not match any option/],
		[{ ...question, correctAnswer: ["falls", "rises"] }, /set multiSelect: true/],
		[{ ...question, multiSelect: true }, /requires at least two correct answers/],
	];
	for (const [args, message] of cases) {
		const updates = [];
		const result = await quiz.execute("bad", args, undefined, (update) => updates.push(update), context);
		assert.equal(result.details.status, "unavailable");
		assert.match(result.details.message, message);
		assert.equal(updates.length, 0, `no pending question for ${result.details.message}`);
	}
});

test("a valid quiz announces its displayed options without revealing the key", async () => {
	const updates = [];
	const result = await quiz.execute("good", question, undefined, (update) => updates.push(update), context);
	assert.equal(updates.length, 1);
	assert.deepEqual(updates[0].details.options, [
		{ index: 1, label: "It falls" },
		{ index: 2, label: "It rises" },
	]);
	assert.equal(updates[0].details.correctIndices, undefined);
	assert.equal(updates[0].details.explanation, undefined);
	assert.equal(result.details.status, "answered");
	assert.equal(result.details.dontKnow, true);
});

test("question tools guide the tutor toward focused checks and purposeful learner choices", () => {
	assert.match(quiz.promptGuidelines.join(" "), /concrete application or comparison/);
	assert.match(quiz.promptGuidelines.join(" "), /two or three short sentences/);
	assert.match(ask.promptGuidelines.join(" "), /goal, depth, pace, or direction/);
});
