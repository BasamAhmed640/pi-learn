import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildClassifierInput,
	CLASSIFIER_SYSTEM_PROMPT,
	hasMermaidFence,
	MIN_PROSE_FOR_AUDIT,
	missingDiagramBlockReason,
	missingDiagramFollowUp,
	needsDiagram,
	parseClassification,
	proseLength,
	repairInstructions,
	SYSTEM_DIAGRAM_POLICY,
	SYSTEM_FEATURES,
} from "../../extensions/lib/system-policy.ts";

test("policy carries the user's definition, decision rule and syntax rules", () => {
	assert.equal(SYSTEM_FEATURES.length, 9);
	for (const feature of SYSTEM_FEATURES) assert.ok(SYSTEM_DIAGRAM_POLICY.includes(feature), feature);
	for (const phrase of [
		"clearly NOT a system",
		"POSSIBLY a system",
		"CLEARLY a system",
		"COMPLEX or central system",
		"bias toward drawing",
		"NOT systems",
		"classification or case split by one criterion",
		"Never wait for the learner to ask",
		"not its vocabulary",
		"overview",
		"zoom",
		"%% dependency-map",
		"sequenceDiagram",
		"stateDiagram-v2",
		"feedback",
		"Mermaid 11.13",
		"ask_user_question",
		"callouts",
	]) {
		assert.ok(SYSTEM_DIAGRAM_POLICY.includes(phrase), `policy mentions ${phrase}`);
	}
	assert.ok(CLASSIFIER_SYSTEM_PROMPT.includes("not whether the word \"system\" appears"));
});

test("parseClassification accepts plain, fenced and chatty JSON", () => {
	const plain = parseClassification('{"teaches":true,"concept":"PID loop","features":[1,3,6],"verdict":"clearly","covered":false,"reason":"feedback"}');
	assert.deepEqual(plain, { teaches: true, concept: "PID loop", features: [1, 3, 6], verdict: "clearly", covered: false, reason: "feedback" });
	const fenced = parseClassification('```json\n{"teaches": "true", "concept": "x", "features": ["2", 9, 9, 42], "verdict": "Complex"}\n```');
	assert.equal(fenced.verdict, "complex");
	assert.equal(fenced.teaches, true);
	assert.deepEqual(fenced.features, [2, 9]);
	assert.equal(fenced.covered, false);
	const chatty = parseClassification('Sure! Here it is: {"teaches": false, "concept": "", "features": [], "verdict": "not"} hope that helps');
	assert.equal(chatty.teaches, false);
	assert.equal(chatty.concept, "this concept");
});

test("parseClassification rejects unusable output (callers fail open)", () => {
	assert.equal(parseClassification(""), null);
	assert.equal(parseClassification("no json here"), null);
	assert.equal(parseClassification('{"verdict": "maybe"}'), null);
	assert.equal(parseClassification("{not json}"), null);
});

test("needsDiagram implements the four-tier rule with bias toward drawing", () => {
	const base = { teaches: true, concept: "c", features: [1, 3], covered: false, reason: "" };
	assert.equal(needsDiagram({ ...base, verdict: "not" }), false);
	assert.equal(needsDiagram({ ...base, verdict: "possibly" }), true);
	assert.equal(needsDiagram({ ...base, verdict: "clearly" }), true);
	assert.equal(needsDiagram({ ...base, verdict: "complex" }), true);
	assert.equal(needsDiagram({ ...base, verdict: "clearly", teaches: false }), false, "probes/plans are not lessons");
	assert.equal(needsDiagram({ ...base, verdict: "clearly", covered: true }), false, "already diagrammed");
	assert.equal(needsDiagram(null), false);
});

test("proseLength ignores fenced code and mermaid; hasMermaidFence finds fences, also in callouts", () => {
	const text = `Short intro.\n\n\`\`\`mermaid\nflowchart LR\n${"a-->b\n".repeat(200)}\`\`\`\n\nDone.`;
	assert.ok(proseLength(text) < 40);
	assert.ok(hasMermaidFence(text));
	assert.ok(hasMermaidFence("> ```mermaid\n> flowchart LR\n> a-->b\n> ```"));
	assert.ok(hasMermaidFence("~~~Mermaid\nflowchart LR\na-->b\n~~~"));
	assert.equal(hasMermaidFence("```js\nconst mermaid = 1;\n```"), false);
	assert.ok(proseLength("x".repeat(MIN_PROSE_FOR_AUDIT + 1)) > MIN_PROSE_FOR_AUDIT);
});

test("nudge and repair messages are actionable and bounded in size", () => {
	const c = { teaches: true, concept: "Blood-glucose regulation", features: [1, 3, 6], verdict: "clearly", covered: false, reason: "" };
	const block = missingDiagramBlockReason(c);
	assert.match(block, /Blood-glucose regulation/);
	assert.match(block, /%% system: Blood-glucose regulation — overview/);
	assert.match(block, /ask this same question again, unchanged/);
	assert.match(block, /feedback loops/);
	const complex = missingDiagramFollowUp({ ...c, verdict: "complex" });
	assert.match(complex, /overview/);
	assert.match(complex, /zoom-in/);
	const repair = repairInstructions([{ error: "Parse error on line 2:\n...\nExpecting 'SQE', got 'PS'", source: "flowchart TD\nA[Foo (bar)]" }], true);
	assert.match(repair, /failed to parse/);
	assert.match(repair, /Expecting 'SQE'/);
	assert.match(repair, /ask this same question again/);
	assert.ok(repair.length < 1200);
	assert.ok(buildClassifierInput("lesson", ["CPU (overview)"]).includes("- CPU (overview)"));
	assert.ok(buildClassifierInput("lesson", []).includes("(none)"));
});
