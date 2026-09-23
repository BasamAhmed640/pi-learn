// Offline check of the simulated learner against the REAL quiz / ask_user_question components.
// No model calls: loads this package's extensions through the SDK, binds the simulated UI and
// invokes the registered tools' execute() directly, as the agent loop would.
//
//   node tests/e2e/selftest.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPiSdk, packageExtensionPaths, skillsDir } from "../helpers/pi.mjs";
import { createSimulatedUI, makeRng } from "./learner.mjs";

const sdk = await importPiSdk();
const cwd = mkdtempSync(join(tmpdir(), "pi-learn-e2e-selftest-"));
const agentDir = sdk.getAgentDir();
const loader = new sdk.DefaultResourceLoader({
	cwd,
	agentDir,
	noExtensions: true,
	additionalExtensionPaths: packageExtensionPaths().filter((p) => existsSync(p)),
	noSkills: true,
	additionalSkillPaths: [skillsDir],
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await loader.reload();
const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd) });

const pending = new Map();
const log = [];
function makeUI(p, dontKnowRate = 0) {
	return createSimulatedUI({ rng: makeRng(`selftest:${p}:${dontKnowRate}`), p, dontKnowRate, goal: "I want intuition.", pendingCalls: () => pending, record: (e) => log.push(e) });
}
let sim = makeUI(1);
await session.bindExtensions({ uiContext: sim.ui, mode: "tui" });
const runner = session.extensionRunner;
const ctx = () => runner.createContext();

async function call(name, params) {
	const id = `call-${Math.random().toString(36).slice(2, 8)}`;
	pending.set(id, { id, name, args: params });
	const def = runner.getToolDefinition(name);
	const res = await def.execute(id, params, undefined, (u) => {
		const sh = u?.details?.options;
		if (sh) pending.get(id).shuffled = sh;
	}, ctx());
	pending.delete(id);
	return res;
}

const single = {
	question: "Which of these numbers is prime?",
	options: [
		{ label: "9", value: "nine" },
		{ label: "15", value: "fifteen" },
		{ label: "13", value: "thirteen" },
		{ label: "21", value: "twentyone" },
	],
	correctAnswer: "thirteen",
	explanation: "13 has exactly two divisors: 1 and 13.",
};
const multi = {
	question: "Select every prime.",
	options: [
		{ label: "2", value: "two" },
		{ label: "4", value: "four" },
		{ label: "5", value: "five" },
		{ label: "9", value: "nine" },
	],
	multiSelect: true,
	correctAnswer: '["two", "five"]', // stringified array, as models sometimes send
	explanation: "2 and 5 have exactly two divisors.",
};

let failures = 0;
async function check(label, fn) {
	try {
		await fn();
		console.log(`ok   ${label}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${label}: ${err.message}`);
	}
}

for (let i = 0; i < 5; i++) {
	await check(`single-select correct #${i + 1}`, async () => {
		const r = await call("quiz", single);
		assert.equal(r.details.status, "answered");
		assert.equal(r.details.correct, true, JSON.stringify(sim.decisions.at(-1)));
	});
}
await check("multi-select correct (stringified correctAnswer)", async () => {
	const r = await call("quiz", multi);
	assert.equal(r.details.correct, true, JSON.stringify(sim.decisions.at(-1)));
	assert.equal(r.details.answers.length, 2);
});

sim = makeUI(0, 0);
await session.bindExtensions({ uiContext: sim.ui, mode: "tui" });
await check("single-select wrong when p=0", async () => {
	const r = await call("quiz", single);
	assert.equal(r.details.correct, false);
	assert.equal(r.details.dontKnow, false);
	assert.equal(sim.decisions.at(-1).observed, "wrong");
});
await check("multi-select wrong when p=0", async () => {
	const r = await call("quiz", multi);
	assert.equal(r.details.correct, false);
});

sim = makeUI(0, 1);
await session.bindExtensions({ uiContext: sim.ui, mode: "tui" });
await check("I don't know (single)", async () => {
	const r = await call("quiz", single);
	assert.equal(r.details.dontKnow, true);
});
await check("I don't know (multi)", async () => {
	const r = await call("quiz", multi);
	assert.equal(r.details.dontKnow, true);
});

await check("ask_user_question single-select picks option 1", async () => {
	const r = await call("ask_user_question", { question: "What is your goal?", options: [{ label: "Intuition" }, { label: "Proofs" }] });
	assert.equal(r.details.status, "answered");
	assert.equal(r.details.answers[0].label, "Intuition");
});
await check("ask_user_question multi-select picks option 1 and submits", async () => {
	const r = await call("ask_user_question", { question: "Which areas?", options: [{ label: "A" }, { label: "B" }], multiSelect: true });
	assert.equal(r.details.status, "answered");
	assert.deepEqual(r.details.answers.map((a) => a.label), ["A"]);
});
await check("ask_user_question text mode types the goal", async () => {
	const r = await call("ask_user_question", { question: "In your own words, what do you want?" });
	assert.equal(r.details.answers[0].label, "I want intuition.");
});

const errs = log.filter((e) => e.kind === "learner" && e.error);
if (errs.length) console.log(JSON.stringify(errs, null, 2));
session.dispose();
console.log(failures === 0 ? "\nselftest: all passed" : `\nselftest: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
